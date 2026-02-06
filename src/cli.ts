#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, execSync } from 'child_process';
import readline from 'readline';
import net from 'net';

import {
  DOTCLAW_HOME,
  PACKAGE_ROOT,
  GROUPS_DIR,
  LOGS_DIR,
  ENV_PATH,
  RUNTIME_CONFIG_PATH,
  REGISTERED_GROUPS_PATH,
  CONTAINER_BUILD_SCRIPT,
  SCRIPTS_DIR,
  ensureDirectoryStructure,
} from './paths.js';

const PLATFORM = process.platform;
const IS_MACOS = PLATFORM === 'darwin';
const IS_LINUX = PLATFORM === 'linux';

const INSTANCE_ID_RAW = process.env.DOTCLAW_INSTANCE_ID || '';
const INSTANCE_ID = INSTANCE_ID_RAW.trim()
  ? INSTANCE_ID_RAW.trim().replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
  : '';
const LAUNCHD_LABEL_BASE = 'com.dotclaw';
const LAUNCHD_LABEL = INSTANCE_ID ? `${LAUNCHD_LABEL_BASE}.${INSTANCE_ID}` : LAUNCHD_LABEL_BASE;
const LAUNCHD_PLIST_NAME = `${LAUNCHD_LABEL}.plist`;
const SYSTEMD_SERVICE_NAME = 'dotclaw.service';

function log(message: string): void {
  console.log(`[dotclaw] ${message}`);
}

function error(message: string): void {
  console.error(`[dotclaw] ERROR: ${message}`);
}

function warn(message: string): void {
  console.warn(`[dotclaw] WARN: ${message}`);
}

function getInstanceIdLabel(id: string): string {
  const normalized = id.trim().replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) return LAUNCHD_LABEL_BASE;
  return `${LAUNCHD_LABEL_BASE}.${normalized}`;
}

function normalizeInstanceId(id: string): string {
  return id.trim().replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
}

function getInstanceHome(id: string): string {
  const normalized = normalizeInstanceId(id);
  if (!normalized || normalized === 'default') {
    return path.join(getUserHome(), '.dotclaw');
  }
  return path.join(getUserHome(), `.dotclaw-${normalized}`);
}

function listInstanceTargets(): Array<{ id: string; home: string }> {
  const targets = new Map<string, { id: string; home: string }>();
  const defaultHome = DOTCLAW_HOME;
  const defaultId = INSTANCE_ID || 'default';
  targets.set(defaultHome, { id: defaultId, home: defaultHome });

  const homeDir = getUserHome();
  try {
    const entries = fs.readdirSync(homeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('.dotclaw-')) continue;
      const id = entry.name.slice('.dotclaw-'.length);
      const home = path.join(homeDir, entry.name);
      if (!targets.has(home)) {
        targets.set(home, { id, home });
      }
    }
  } catch {
    // ignore read errors
  }

  return Array.from(targets.values()).sort((a, b) => {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return 1;
    return a.id.localeCompare(b.id);
  });
}

type ParsedCliArgs = {
  command: string;
  args: string[];
  passthrough: string[];
  flags: {
    id?: string;
    all: boolean;
    follow: boolean;
    foreground: boolean;
  };
};

function parseCliArgs(argv: string[]): ParsedCliArgs {
  let command = '';
  const args: string[] = [];
  const passthrough: string[] = [];
  let id: string | undefined;
  let all = false;
  let sawFollow = false;
  let sawForeground = false;
  let sawShortF = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg.startsWith('--id=')) {
      id = arg.slice('--id='.length);
      continue;
    }
    if (arg === '--id') {
      id = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--follow') {
      sawFollow = true;
    }
    if (arg === '--foreground') {
      sawForeground = true;
    }
    if (arg === '-f') {
      sawShortF = true;
    }

    if (!command && !arg.startsWith('-')) {
      command = arg;
      continue;
    }

    if (arg.startsWith('-')) {
      passthrough.push(arg);
      continue;
    }

    args.push(arg);
  }

  const resolvedCommand = command || 'help';
  const follow = resolvedCommand === 'logs' ? (sawFollow || sawShortF) : sawFollow;
  const foreground = resolvedCommand === 'start' ? (sawForeground || sawShortF) : sawForeground;

  return {
    command: resolvedCommand,
    args,
    passthrough,
    flags: {
      id,
      all,
      follow,
      foreground
    }
  };
}

function buildChildArgs(command: string, parsed: ParsedCliArgs): string[] {
  return [command, ...parsed.passthrough, ...parsed.args].filter(Boolean);
}

function runCliWithEnv(command: string, parsed: ParsedCliArgs, env: NodeJS.ProcessEnv): number {
  const cliPath = path.join(PACKAGE_ROOT, 'dist', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    error(`DotClaw not properly installed. Missing: ${cliPath}`);
    return 1;
  }
  const childArgs = buildChildArgs(command, parsed);
  const result = spawnSync(getNodePath(), [cliPath, ...childArgs], { stdio: 'inherit', env });
  return result.status || 0;
}

function ensureDirectoryStructureAt(dotclawHome: string): void {
  const dirs = [
    dotclawHome,
    path.join(dotclawHome, 'config'),
    path.join(dotclawHome, 'data'),
    path.join(dotclawHome, 'data', 'store'),
    path.join(dotclawHome, 'data', 'ipc'),
    path.join(dotclawHome, 'data', 'sessions'),
    path.join(dotclawHome, 'groups'),
    path.join(dotclawHome, 'groups', 'main'),
    path.join(dotclawHome, 'groups', 'global'),
    path.join(dotclawHome, 'logs'),
    path.join(dotclawHome, 'traces'),
    path.join(dotclawHome, 'prompts')
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

type PortAvailability = 'available' | 'unavailable' | 'unknown';

async function checkPortAvailability(port: number): Promise<PortAvailability> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        resolve('unknown');
        return;
      }
      resolve('unavailable');
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve('available'));
    });
  });
}

function acquirePortLock(): number | null {
  const lockPath = path.join(getUserHome(), '.dotclaw', '.port-lock');
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
    fs.writeFileSync(lockPath, String(process.pid));
    return fd;
  } catch {
    return null;
  }
}

function releasePortLock(fd: number): void {
  const lockPath = path.join(getUserHome(), '.dotclaw', '.port-lock');
  try { fs.closeSync(fd); } catch { /* ignore */ }
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}

async function withPortLock<T>(fn: () => Promise<T>): Promise<T> {
  const maxWait = 10_000;
  const pollMs = 200;
  const start = Date.now();
  let fd: number | null = null;
  while (Date.now() - start < maxWait) {
    fd = acquirePortLock();
    if (fd !== null) break;
    await new Promise(r => setTimeout(r, pollMs));
  }
  if (fd === null) {
    throw new Error('Could not acquire port lock. Another instance creation may be in progress.');
  }
  try {
    return await fn();
  } finally {
    releasePortLock(fd);
  }
}

async function findAvailablePort(startPort: number, attempts = 20): Promise<number> {
  let unknownPort: number | null = null;
  let port = startPort;
  for (let i = 0; i < attempts; i += 1) {
    const status = await checkPortAvailability(port);
    if (status === 'available') return port;
    if (status === 'unknown' && unknownPort === null) {
      unknownPort = port;
    }
    port += 1;
  }
  if (unknownPort !== null) {
    return unknownPort;
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + attempts - 1}`);
}

function getVersion(): string {
  try {
    const pkgPath = path.join(PACKAGE_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getNodePath(): string {
  return process.execPath;
}

function getUserHome(): string {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}

function getLaunchdPlistPath(): string {
  return path.join(getUserHome(), 'Library', 'LaunchAgents', LAUNCHD_PLIST_NAME);
}

function isServiceRunning(): boolean {
  if (IS_MACOS) {
    try {
      const result = execSync(`launchctl list | grep -F "${LAUNCHD_LABEL}"`, { encoding: 'utf-8', stdio: 'pipe' });
      return result.includes(LAUNCHD_LABEL);
    } catch {
      return false;
    }
  } else if (IS_LINUX) {
    try {
      const result = execSync(`systemctl is-active ${SYSTEMD_SERVICE_NAME}`, { encoding: 'utf-8', stdio: 'pipe' });
      return result.trim() === 'active';
    } catch {
      return false;
    }
  }
  return false;
}

function generateLaunchdPlist(): string {
  const nodePath = getNodePath();
  const home = getUserHome();
  const distIndex = path.join(PACKAGE_ROOT, 'dist', 'index.js');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${distIndex}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${DOTCLAW_HOME}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${home}/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${home}</string>
        <key>DOTCLAW_HOME</key>
        <string>${DOTCLAW_HOME}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOGS_DIR}/dotclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${LOGS_DIR}/dotclaw.error.log</string>
</dict>
</plist>`;
}

function generateSystemdService(): string {
  const nodePath = getNodePath();
  const distIndex = path.join(PACKAGE_ROOT, 'dist', 'index.js');
  const user = process.env.USER || 'nobody';

  return `[Unit]
Description=DotClaw Personal Assistant
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=${user}
Environment=NODE_ENV=production
Environment=DOTCLAW_HOME=${DOTCLAW_HOME}
ExecStart=${nodePath} ${distIndex}
WorkingDirectory=${DOTCLAW_HOME}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
}

async function prompt(question: string, defaultValue = ''): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    rl.question(`${question}${suffix}: `, (answer: string) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

// Commands

async function cmdSetup(): Promise<void> {
  log('Starting DotClaw setup...');
  log(`Data directory: ${DOTCLAW_HOME}`);
  log(`Package root: ${PACKAGE_ROOT}`);

  // Create directory structure
  log('Creating directory structure...');
  ensureDirectoryStructure();

  // Run init to create config files
  log('Initializing configuration files...');
  const initResult = spawnSync('node', [path.join(SCRIPTS_DIR, 'init.js')], {
    stdio: 'inherit',
    env: { ...process.env, DOTCLAW_HOME }
  });
  if (initResult.status !== 0) {
    error('Init failed');
    process.exit(1);
  }

  // Run configure
  log('Running configuration...');
  const configureResult = spawnSync('node', [path.join(SCRIPTS_DIR, 'configure.js')], {
    stdio: 'inherit',
    env: { ...process.env, DOTCLAW_HOME }
  });
  if (configureResult.status !== 0) {
    error('Configuration failed');
    process.exit(1);
  }

  // Build container
  const buildContainer = await prompt('Build Docker container now? (yes/no)', 'yes');
  if (buildContainer.toLowerCase().startsWith('y')) {
    await cmdBuild();
  }

  // Install service
  const installService = await prompt('Install as system service? (yes/no)', 'yes');
  if (installService.toLowerCase().startsWith('y')) {
    await cmdInstallService();
  }

  log('Setup complete!');
  log('');
  log('Next steps:');
  log('  1. Register a chat channel: dotclaw register');
  log('  2. Start the service: dotclaw start');
  log('  3. Check status: dotclaw doctor');
}

async function cmdConfigure(): Promise<void> {
  log('Running configuration...');
  log(`Data directory: ${DOTCLAW_HOME}`);

  // Ensure directories exist
  ensureDirectoryStructure();

  // Run configure script
  const configureResult = spawnSync('node', [path.join(SCRIPTS_DIR, 'configure.js')], {
    stdio: 'inherit',
    env: { ...process.env, DOTCLAW_HOME }
  });

  if (configureResult.status !== 0) {
    error('Configuration failed');
    process.exit(1);
  }

  log('Configuration updated.');

  if (isServiceRunning()) {
    const restart = await prompt('Restart service to apply changes? (yes/no)', 'yes');
    if (restart.toLowerCase().startsWith('y')) {
      await cmdRestart();
    }
  }
}

async function cmdBuild(): Promise<void> {
  log('Building Docker container...');

  if (!fs.existsSync(CONTAINER_BUILD_SCRIPT)) {
    error(`Container build script not found: ${CONTAINER_BUILD_SCRIPT}`);
    process.exit(1);
  }

  const dockerResult = spawnSync('bash', [CONTAINER_BUILD_SCRIPT], {
    cwd: path.dirname(CONTAINER_BUILD_SCRIPT),
    stdio: 'inherit'
  });

  if (dockerResult.status !== 0) {
    warn('Container build failed. Make sure Docker is running.');
    process.exit(1);
  } else {
    log('Build complete');
  }
}

async function cmdStart(foreground = false): Promise<void> {
  const distIndex = path.join(PACKAGE_ROOT, 'dist', 'index.js');

  if (!fs.existsSync(distIndex)) {
    error(`DotClaw not properly installed. Missing: ${distIndex}`);
    process.exit(1);
  }

  if (foreground) {
    log('Starting DotClaw in foreground...');
    const child = spawn('node', [distIndex], {
      cwd: DOTCLAW_HOME,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production', DOTCLAW_HOME }
    });
    child.on('exit', code => process.exit(code || 0));
    return;
  }

  if (IS_MACOS) {
    const plistPath = getLaunchdPlistPath();
    if (!fs.existsSync(plistPath)) {
      warn('Service not installed. Installing now...');
      await cmdInstallService();
    }

    if (isServiceRunning()) {
      log('Service is already running');
      return;
    }

    log('Starting service...');
    try {
      execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });
      log('Service started');
    } catch {
      error('Failed to start service');
      process.exit(1);
    }
  } else if (IS_LINUX) {
    if (isServiceRunning()) {
      log('Service is already running');
      return;
    }

    log('Starting service...');
    try {
      execSync(`sudo systemctl start ${SYSTEMD_SERVICE_NAME}`, { stdio: 'inherit' });
      log('Service started');
    } catch {
      error('Failed to start service. Try: dotclaw start --foreground');
      process.exit(1);
    }
  } else {
    warn(`Unsupported platform: ${PLATFORM}. Running in foreground.`);
    await cmdStart(true);
  }
}

function cleanupInstanceContainers(): void {
  try {
    // Find containers belonging to this instance using Docker labels
    let filterArgs: string;
    if (INSTANCE_ID) {
      filterArgs = `--filter "label=dotclaw.instance=${INSTANCE_ID}"`;
    } else {
      // Default instance: containers with dotclaw.group label but WITHOUT dotclaw.instance label
      filterArgs = '--filter "label=dotclaw.group"';
    }

    const ids = execSync(`docker ps -q ${filterArgs}`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (!ids) return;

    const containerIds = ids.split('\n').filter(Boolean);

    // For the default instance, exclude containers that have a dotclaw.instance label
    let toRemove = containerIds;
    if (!INSTANCE_ID && containerIds.length > 0) {
      toRemove = containerIds.filter(id => {
        try {
          const labels = execSync(`docker inspect --format '{{index .Config.Labels "dotclaw.instance"}}' ${id}`, {
            encoding: 'utf-8', stdio: 'pipe'
          }).trim();
          return !labels; // Keep only containers without a dotclaw.instance label
        } catch {
          return true;
        }
      });
    }

    if (toRemove.length > 0) {
      execSync(`docker rm -f ${toRemove.join(' ')}`, { stdio: 'ignore' });
      log(`Cleaned up ${toRemove.length} container(s)`);
    }
  } catch {
    // Docker may not be running or no containers to clean up
  }
}

async function cmdStop(): Promise<void> {
  let serviceStopped = false;

  if (IS_MACOS) {
    const plistPath = getLaunchdPlistPath();
    if (!fs.existsSync(plistPath)) {
      log('Service not installed');
    } else if (!isServiceRunning()) {
      log('Service is not running');
    } else {
      log('Stopping service...');
      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'inherit' });
        log('Service stopped');
        serviceStopped = true;
      } catch {
        error('Failed to stop service');
        process.exit(1);
      }
    }
  } else if (IS_LINUX) {
    if (!isServiceRunning()) {
      log('Service is not running');
    } else {
      log('Stopping service...');
      try {
        execSync(`sudo systemctl stop ${SYSTEMD_SERVICE_NAME}`, { stdio: 'inherit' });
        log('Service stopped');
        serviceStopped = true;
      } catch {
        error('Failed to stop service');
        process.exit(1);
      }
    }
  } else {
    warn(`Unsupported platform: ${PLATFORM}`);
  }

  // Give the process a moment to run its graceful shutdown handler
  if (serviceStopped) {
    await new Promise(r => setTimeout(r, 2000));
  }

  // Clean up any remaining containers for this instance
  cleanupInstanceContainers();
}

async function cmdRestart(): Promise<void> {
  await cmdStop();

  // Wait for the old process to fully exit before starting again
  const maxWaitMs = 10_000;
  const pollMs = 500;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!isServiceRunning()) break;
    await new Promise(r => setTimeout(r, pollMs));
  }
  if (isServiceRunning()) {
    warn('Old service still running after timeout; starting anyway');
  }

  await cmdStart();
}

async function cmdLogs(follow = false): Promise<void> {
  const logFile = path.join(LOGS_DIR, 'dotclaw.log');
  const errorLogFile = path.join(LOGS_DIR, 'dotclaw.error.log');

  if (!fs.existsSync(logFile) && !fs.existsSync(errorLogFile)) {
    log('No logs found yet');
    log(`Log directory: ${LOGS_DIR}`);
    return;
  }

  if (follow) {
    log('Following logs (Ctrl+C to stop)...');
    const tailArgs = ['-f'];
    if (fs.existsSync(logFile)) tailArgs.push(logFile);
    if (fs.existsSync(errorLogFile)) tailArgs.push(errorLogFile);

    const child = spawn('tail', tailArgs, { stdio: 'inherit' });
    child.on('exit', code => process.exit(code || 0));
  } else {
    log('Recent logs:');
    console.log('');
    if (fs.existsSync(logFile)) {
      try {
        const content = execSync(`tail -n 50 "${logFile}"`, { encoding: 'utf-8' });
        console.log(content);
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(errorLogFile)) {
      const errorContent = fs.readFileSync(errorLogFile, 'utf-8').trim();
      if (errorContent) {
        console.log('\n--- Errors ---');
        try {
          const content = execSync(`tail -n 20 "${errorLogFile}"`, { encoding: 'utf-8' });
          console.log(content);
        } catch {
          // ignore
        }
      }
    }
  }
}

async function cmdDoctor(): Promise<void> {
  log('Running diagnostics...');
  console.log('');

  const doctorResult = spawnSync('node', [path.join(SCRIPTS_DIR, 'doctor.js')], {
    stdio: 'inherit',
    env: { ...process.env, DOTCLAW_HOME }
  });

  console.log('');

  // Additional service status
  if (IS_MACOS) {
    const plistPath = getLaunchdPlistPath();
    console.log(`launchd plist: ${fs.existsSync(plistPath) ? 'installed' : 'not installed'}`);
    console.log(`launchd label: ${LAUNCHD_LABEL}`);
    console.log(`Service running: ${isServiceRunning() ? 'yes' : 'no'}`);
  } else if (IS_LINUX) {
    console.log(`Service running: ${isServiceRunning() ? 'yes' : 'no'}`);
  }

  if (doctorResult.status !== 0) {
    process.exit(doctorResult.status || 1);
  }
}

async function cmdInstallService(): Promise<void> {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  if (IS_MACOS) {
    const plistPath = getLaunchdPlistPath();
    const plistDir = path.dirname(plistPath);

    fs.mkdirSync(plistDir, { recursive: true });

    // Unload if already loaded
    if (isServiceRunning()) {
      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
      } catch {
        // ignore
      }
    }

    const plistContent = generateLaunchdPlist();
    fs.writeFileSync(plistPath, plistContent);

    log(`Installed launchd service: ${plistPath}`);
    log('Start with: dotclaw start');
  } else if (IS_LINUX) {
    const servicePath = `/etc/systemd/system/${SYSTEMD_SERVICE_NAME}`;
    const serviceContent = generateSystemdService();

    log('Installing systemd service (requires sudo)...');

    // Write to temp file first, then move with sudo
    const tempPath = path.join('/tmp', SYSTEMD_SERVICE_NAME);
    fs.writeFileSync(tempPath, serviceContent);

    try {
      execSync(`sudo mv "${tempPath}" "${servicePath}"`, { stdio: 'inherit' });
      execSync('sudo systemctl daemon-reload', { stdio: 'inherit' });
      execSync(`sudo systemctl enable ${SYSTEMD_SERVICE_NAME}`, { stdio: 'inherit' });
      log(`Installed systemd service: ${servicePath}`);
      log('Start with: dotclaw start');
    } catch {
      error('Service installation failed');
      process.exit(1);
    }
  } else {
    warn(`Unsupported platform: ${PLATFORM}. No service installed.`);
  }
}

async function cmdUninstallService(): Promise<void> {
  if (IS_MACOS) {
    const plistPath = getLaunchdPlistPath();

    if (isServiceRunning()) {
      log('Stopping service...');
      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
      } catch {
        // ignore
      }
    }

    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
      log('Service uninstalled');
    } else {
      log('Service was not installed');
    }
  } else if (IS_LINUX) {
    log('Removing systemd service...');
    try {
      execSync(`sudo systemctl stop ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
    } catch {
      // ignore
    }
    try {
      execSync(`sudo systemctl disable ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
    } catch {
      // ignore
    }
    try {
      execSync(`sudo rm /etc/systemd/system/${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
      execSync('sudo systemctl daemon-reload', { stdio: 'pipe' });
      log('Service uninstalled');
    } catch {
      warn('Could not remove systemd service file');
    }
  } else {
    warn(`Unsupported platform: ${PLATFORM}`);
  }
}

async function cmdAddInstance(instanceId: string): Promise<void> {
  const normalized = normalizeInstanceId(instanceId);
  if (!normalized) {
    error('Usage: dotclaw add-instance <instance-id>');
    process.exit(1);
  }

  const newHome = getInstanceHome(normalized);
  const runtimePath = path.join(newHome, 'config', 'runtime.json');
  const envPath = path.join(newHome, '.env');

  if (fs.existsSync(newHome)) {
    error(`Instance home already exists: ${newHome}`);
    process.exit(1);
  }

  ensureDirectoryStructureAt(newHome);

  if (fs.existsSync(ENV_PATH)) {
    const copyEnv = await prompt('Copy .env from existing instance? (yes/no)', 'yes');
    if (copyEnv.toLowerCase().startsWith('y')) {
      fs.copyFileSync(ENV_PATH, envPath);
      log(`Copied .env to ${envPath}`);
    }
  }

  let runtimeConfig: Record<string, unknown> = {};
  if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
    try {
      runtimeConfig = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf-8'));
    } catch {
      warn('Failed to parse existing runtime.json; starting fresh');
    }
  }

  const host = typeof runtimeConfig.host === 'object' && runtimeConfig.host ? runtimeConfig.host as Record<string, unknown> : {};
  const container = typeof host.container === 'object' && host.container ? host.container as Record<string, unknown> : {};
  container.instanceId = normalized;
  host.container = container;

  // Allocate ports under a file lock to prevent race conditions with concurrent instance creation
  await withPortLock(async () => {
    const metrics = typeof host.metrics === 'object' && host.metrics ? host.metrics as Record<string, unknown> : {};
    const dashboard = typeof host.dashboard === 'object' && host.dashboard ? host.dashboard as Record<string, unknown> : {};
    const metricsEnabled = metrics.enabled !== false;
    if (metricsEnabled) {
      const basePort = typeof metrics.port === 'number' ? metrics.port : 3001;
      const metricsPort = await findAvailablePort(basePort + 1);
      metrics.port = metricsPort;
      // Dashboard port follows metrics port; allocate next available after it
      const dashboardPort = await findAvailablePort(metricsPort + 1);
      dashboard.port = dashboardPort;
    }
    host.metrics = metrics;
    host.dashboard = dashboard;
    runtimeConfig.host = host;

    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.writeFileSync(runtimePath, JSON.stringify(runtimeConfig, null, 2));
    log(`Wrote runtime config: ${runtimePath}`);
  });

  if (process.env.DOTCLAW_TEST_MODE === '1') {
    log('Test mode enabled: skipping service install/start');
    return;
  }

  const cliPath = path.join(PACKAGE_ROOT, 'dist', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    error(`DotClaw not properly installed. Missing: ${cliPath}`);
    process.exit(1);
  }

  const env = { ...process.env, DOTCLAW_HOME: newHome, DOTCLAW_INSTANCE_ID: normalized };
  const launchdLabel = getInstanceIdLabel(normalized);

  if (IS_MACOS) {
    try {
      const existing = execSync(`launchctl list | grep -F "${launchdLabel}"`, { encoding: 'utf-8', stdio: 'pipe' });
      if (existing.includes(launchdLabel)) {
        error(`launchd service already exists for ${launchdLabel}`);
        process.exit(1);
      }
    } catch {
      // not running, ok
    }
  }

  log(`Installing service for instance "${normalized}"...`);
  const installResult = spawnSync(getNodePath(), [cliPath, 'install-service'], { stdio: 'inherit', env });
  if (installResult.status !== 0) {
    process.exit(installResult.status || 1);
  }

  log(`Starting instance "${normalized}"...`);
  const startResult = spawnSync(getNodePath(), [cliPath, 'start'], { stdio: 'inherit', env });
  if (startResult.status !== 0) {
    process.exit(startResult.status || 1);
  }

  log(`Instance "${normalized}" started at ${newHome}`);
  log(`Launchd label: ${launchdLabel}`);
  if (fs.existsSync(envPath)) {
    log(`To use a different bot token, edit: ${envPath}`);
  }
}

async function cmdRegister(): Promise<void> {
  // Ensure directories exist
  ensureDirectoryStructure();

  let groups: Record<string, { name: string; folder: string; added_at: string }> = {};
  if (fs.existsSync(REGISTERED_GROUPS_PATH)) {
    try {
      groups = JSON.parse(fs.readFileSync(REGISTERED_GROUPS_PATH, 'utf-8'));
    } catch {
      // ignore
    }
  }

  // Read provider config
  let runtimeConfig: Record<string, unknown> = {};
  if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
    try {
      runtimeConfig = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf-8'));
    } catch {
      // ignore
    }
  }
  const host = runtimeConfig.host as Record<string, unknown> | undefined;
  const telegramEnabled = (host?.telegram as Record<string, unknown> | undefined)?.enabled !== false;
  const discordEnabled = (host?.discord as Record<string, unknown> | undefined)?.enabled === true;

  console.log('Register a chat channel with DotClaw');
  console.log('');

  // Provider selection
  let provider = 'telegram';
  if (telegramEnabled && discordEnabled) {
    const choice = await prompt('Which provider?\n  1. Telegram\n  2. Discord\nChoice', '1');
    provider = choice === '2' ? 'discord' : 'telegram';
  } else if (discordEnabled) {
    provider = 'discord';
  }

  let chatId: string;
  if (provider === 'discord') {
    console.log('To find your channel ID:');
    console.log('  Right-click the channel → Copy Channel ID.');
    console.log('  (Enable Developer Mode in Discord Settings → App Settings → Advanced if needed.)');
    console.log('');
    chatId = await prompt('Discord channel ID');
  } else {
    console.log('To find your chat ID:');
    console.log('  1. Add @userinfobot or @get_id_bot to your Telegram chat');
    console.log('  2. The bot will reply with the chat ID (usually a negative number for groups)');
    console.log('');
    chatId = await prompt('Telegram chat ID');
  }

  if (!chatId) {
    error('Chat ID is required');
    process.exit(1);
  }

  const name = await prompt('Group name', 'main');
  const folder = await prompt('Folder name (lowercase, hyphens only)', 'main');

  if (!/^[a-z0-9-]+$/.test(folder)) {
    error('Folder name must be lowercase letters, numbers, and hyphens only');
    process.exit(1);
  }

  const prefixedId = provider === 'discord' ? `discord:${chatId}` : `telegram:${chatId}`;
  groups[prefixedId] = {
    name,
    folder,
    added_at: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(REGISTERED_GROUPS_PATH), { recursive: true });
  fs.writeFileSync(REGISTERED_GROUPS_PATH, JSON.stringify(groups, null, 2) + '\n');

  // Create group folder
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(groupDir, { recursive: true });

  log(`Registered ${provider} channel ${chatId} as "${name}" (folder: ${folder})`);

  if (isServiceRunning()) {
    const restart = await prompt('Restart service to apply changes? (yes/no)', 'yes');
    if (restart.toLowerCase().startsWith('y')) {
      await cmdRestart();
    }
  }
}

async function cmdGroups(): Promise<void> {
  if (!fs.existsSync(REGISTERED_GROUPS_PATH)) {
    log('No groups registered yet. Run: dotclaw register');
    return;
  }

  let groups: Record<string, { name: string; folder: string; added_at?: string }>;
  try {
    groups = JSON.parse(fs.readFileSync(REGISTERED_GROUPS_PATH, 'utf-8'));
  } catch {
    error('Failed to read registered groups file');
    process.exit(1);
  }

  const entries = Object.entries(groups);
  if (entries.length === 0) {
    log('No groups registered yet. Run: dotclaw register');
    return;
  }

  console.log(`Registered groups (${entries.length}):\n`);
  for (const [chatId, group] of entries) {
    // Detect provider from prefix
    let provider = 'telegram';
    let displayId = chatId;
    if (chatId.startsWith('discord:')) {
      provider = 'discord';
      displayId = chatId.slice('discord:'.length);
    } else if (chatId.startsWith('telegram:')) {
      provider = 'telegram';
      displayId = chatId.slice('telegram:'.length);
    }

    console.log(`  ${group.name}`);
    console.log(`    Provider: ${provider}`);
    console.log(`    Chat ID:  ${displayId}`);
    console.log(`    Folder:   ${group.folder}`);
    if (group.added_at) {
      console.log(`    Added:    ${group.added_at}`);
    }
    console.log('');
  }
}

async function cmdUnregister(identifier?: string): Promise<void> {
  if (!fs.existsSync(REGISTERED_GROUPS_PATH)) {
    log('No groups registered.');
    return;
  }

  let groups: Record<string, { name: string; folder: string; added_at?: string }>;
  try {
    groups = JSON.parse(fs.readFileSync(REGISTERED_GROUPS_PATH, 'utf-8'));
  } catch {
    error('Failed to read registered groups file');
    process.exit(1);
  }

  const entries = Object.entries(groups);
  if (entries.length === 0) {
    log('No groups registered.');
    return;
  }

  let targetChatId: string | undefined;

  if (identifier) {
    // Match by chat ID, name, or folder
    for (const [chatId, group] of entries) {
      if (chatId === identifier || group.name === identifier || group.folder === identifier) {
        targetChatId = chatId;
        break;
      }
    }
    if (!targetChatId) {
      error(`No group found matching "${identifier}"`);
      log('Registered groups:');
      for (const [chatId, group] of entries) {
        log(`  ${group.name} (${chatId}, folder: ${group.folder})`);
      }
      process.exit(1);
    }
  } else {
    // Interactive: list groups and ask
    console.log('Registered groups:\n');
    for (let i = 0; i < entries.length; i++) {
      const [chatId, group] = entries[i];
      console.log(`  ${i + 1}. ${group.name} (${chatId}, folder: ${group.folder})`);
    }
    console.log('');

    const choice = await prompt('Enter number, chat ID, name, or folder to unregister');
    if (!choice) {
      log('Cancelled.');
      return;
    }

    // Try as a number (1-indexed selection)
    const num = parseInt(choice, 10);
    if (!isNaN(num) && num >= 1 && num <= entries.length) {
      targetChatId = entries[num - 1][0];
    } else {
      // Try as chat ID, name, or folder
      for (const [chatId, group] of entries) {
        if (chatId === choice || group.name === choice || group.folder === choice) {
          targetChatId = chatId;
          break;
        }
      }
    }

    if (!targetChatId) {
      error(`No group found matching "${choice}"`);
      process.exit(1);
    }
  }

  const group = groups[targetChatId];
  const confirm = await prompt(`Remove "${group.name}" (${targetChatId})? (yes/no)`, 'no');
  if (!confirm.toLowerCase().startsWith('y')) {
    log('Cancelled.');
    return;
  }

  delete groups[targetChatId];
  fs.writeFileSync(REGISTERED_GROUPS_PATH, JSON.stringify(groups, null, 2) + '\n');
  log(`Unregistered "${group.name}" (${targetChatId})`);

  if (isServiceRunning()) {
    const restart = await prompt('Restart service to apply changes? (yes/no)', 'yes');
    if (restart.toLowerCase().startsWith('y')) {
      await cmdRestart();
    }
  }
}

async function cmdStatus(): Promise<void> {
  console.log(`Platform: ${PLATFORM}`);
  console.log(`DOTCLAW_HOME: ${DOTCLAW_HOME}`);
  console.log(`Instance ID: ${INSTANCE_ID || 'default'}`);
  console.log(`Package root: ${PACKAGE_ROOT}`);
  console.log(`Service running: ${isServiceRunning() ? 'yes' : 'no'}`);

  console.log(`.env: ${fs.existsSync(ENV_PATH) ? 'present' : 'missing'}`);

  if (fs.existsSync(REGISTERED_GROUPS_PATH)) {
    try {
      const groups = JSON.parse(fs.readFileSync(REGISTERED_GROUPS_PATH, 'utf-8'));
      const count = Object.keys(groups).length;
      console.log(`Registered groups: ${count}`);
    } catch {
      console.log('Registered groups: error reading file');
    }
  } else {
    console.log('Registered groups: none');
  }
}

async function cmdInstances(): Promise<void> {
  const instances = listInstanceTargets();
  if (instances.length === 0) {
    console.log('No instances found.');
    return;
  }
  console.log('Instances:');
  for (const instance of instances) {
    console.log(`- ${instance.id}: ${instance.home}`);
  }
}

function printHelp(): void {
  console.log(`
DotClaw - Personal OpenRouter-based assistant

Usage: dotclaw <command> [options]

Commands:
  setup              Run initial setup (init, configure, build, install service)
  configure          Re-run configuration (change API keys, model, etc.)
  start              Start the service (or run in foreground with --foreground)
  stop               Stop the service
  restart            Restart the service
  logs               Show recent logs (use --follow to tail)
  status             Show current status
  doctor             Run diagnostics
  register           Register a chat channel (Telegram or Discord)
  unregister         Remove a registered chat channel
  groups             List registered chat channels
  build              Build Docker container
  add-instance       Create and start a new isolated instance
  instances          List discovered instances
  install-service    Install as system service
  uninstall-service  Remove system service
  version            Show version
  help               Show this help message

Options:
  --version, -v      Show version
  --foreground, -f   Run in foreground (for 'start' command)
  --follow, -f       Follow log output (for 'logs' command)
  --id <id>          Run command against a specific instance
  --all              Run command against all instances (supported commands only)

Data directory: ${DOTCLAW_HOME}
Override with DOTCLAW_HOME environment variable.

Examples:
  dotclaw setup              # First-time setup
  dotclaw configure          # Change configuration
  dotclaw start              # Start as background service
  dotclaw start --foreground # Run in terminal
  dotclaw logs --follow      # Tail logs
  dotclaw doctor             # Check configuration
  dotclaw groups             # List registered chats
  dotclaw unregister main    # Remove a group by name/folder/chat ID
  dotclaw add-instance dev   # Create a new instance (~/.dotclaw-dev)
  dotclaw restart --all      # Restart all instances
`);
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  const command = parsed.command;

  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(`dotclaw ${getVersion()}`);
    return;
  }

  try {
    if ((command === 'add-instance' || command === 'instances') && (parsed.flags.id || parsed.flags.all)) {
      error(`${command} does not support --id or --all.`);
      process.exit(1);
    }

    if (parsed.flags.id && parsed.flags.all) {
      error('Use either --id or --all, not both.');
      process.exit(1);
    }

    const allSupported = new Set(['start', 'stop', 'restart', 'status', 'logs', 'doctor']);
    if (parsed.flags.all) {
      if (!allSupported.has(command)) {
        error(`--all is not supported for "${command}".`);
        process.exit(1);
      }
      if (command === 'logs' && parsed.flags.follow) {
        error('--all cannot be used with logs --follow.');
        process.exit(1);
      }
      if (command === 'start' && parsed.flags.foreground) {
        error('--all cannot be used with start --foreground.');
        process.exit(1);
      }

      const instances = listInstanceTargets();
      let exitCode = 0;
      for (const instance of instances) {
        console.log(`\n=== ${instance.id} (${instance.home}) ===`);
        const env: NodeJS.ProcessEnv = { ...process.env, DOTCLAW_HOME: instance.home };
        if (instance.id && instance.id !== 'default') {
          env.DOTCLAW_INSTANCE_ID = instance.id;
        } else {
          delete env.DOTCLAW_INSTANCE_ID;
        }
        const code = runCliWithEnv(command, parsed, env);
        if (code !== 0) exitCode = code;
      }
      process.exit(exitCode);
    }

    if (parsed.flags.id) {
      const normalized = normalizeInstanceId(parsed.flags.id);
      if (!normalized) {
        error('Invalid instance id.');
        process.exit(1);
      }
      const targetHome = getInstanceHome(normalized);
      const targetInstanceId = normalized === 'default' ? '' : normalized;
      if (DOTCLAW_HOME !== targetHome || INSTANCE_ID !== targetInstanceId) {
        const env: NodeJS.ProcessEnv = { ...process.env, DOTCLAW_HOME: targetHome };
        if (targetInstanceId) {
          env.DOTCLAW_INSTANCE_ID = targetInstanceId;
        } else {
          delete env.DOTCLAW_INSTANCE_ID;
        }
        const exitCode = runCliWithEnv(command, parsed, env);
        process.exit(exitCode);
      }
    }

    switch (command) {
      case 'setup':
        await cmdSetup();
        break;
      case 'configure':
        await cmdConfigure();
        break;
      case 'add-instance':
        await cmdAddInstance(parsed.args[0] || '');
        break;
      case 'instances':
        await cmdInstances();
        break;
      case 'build':
        await cmdBuild();
        break;
      case 'start':
        await cmdStart(parsed.flags.foreground);
        break;
      case 'stop':
        await cmdStop();
        break;
      case 'restart':
        await cmdRestart();
        break;
      case 'logs':
        await cmdLogs(parsed.flags.follow);
        break;
      case 'doctor':
        await cmdDoctor();
        break;
      case 'register':
        await cmdRegister();
        break;
      case 'unregister':
        await cmdUnregister(parsed.args[0]);
        break;
      case 'groups':
        await cmdGroups();
        break;
      case 'status':
        await cmdStatus();
        break;
      case 'install-service':
        await cmdInstallService();
        break;
      case 'uninstall-service':
        await cmdUninstallService();
        break;
      case 'version':
        console.log(`dotclaw ${getVersion()}`);
        break;
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;
      default:
        error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
