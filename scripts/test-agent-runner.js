import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const projectRoot = process.cwd();
const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');
const nodeModulesDir = path.join(agentRunnerDir, 'node_modules');
const packageLock = path.join(agentRunnerDir, 'package-lock.json');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runNpm(args) {
  execFileSync(npmCmd, args, { cwd: agentRunnerDir, stdio: 'inherit' });
}

const skipInstall = ['1', 'true', 'yes'].includes((process.env.DOTCLAW_AGENT_RUNNER_SKIP_INSTALL || '').toLowerCase());
if (!skipInstall) {
  if (existsSync(packageLock)) {
    runNpm(['ci']);
  } else if (!existsSync(nodeModulesDir)) {
    runNpm(['install']);
  }
}

runNpm(['run', 'build']);

execFileSync(process.execPath, ['--test', 'test/**/*.test.js'], {
  cwd: agentRunnerDir,
  stdio: 'inherit'
});
