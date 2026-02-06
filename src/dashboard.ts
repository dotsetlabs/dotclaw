/**
 * DotClaw Health Dashboard
 * Provides /health endpoint and simple status page
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { STORE_DIR, DATA_DIR, CONTAINER_MODE } from './config.js';
import { PACKAGE_ROOT } from './paths.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { logger } from './logger.js';

const runtime = loadRuntimeConfig();

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  uptimeFormatted: string;
  timestamp: string;
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  database: {
    status: 'ok' | 'error';
    messageCount?: number;
    taskCount?: number;
    memoryItemCount?: number;
    error?: string;
  };
  container: {
    status: 'ok' | 'error' | 'unknown';
    mode: string;
    runningDaemons?: number;
    error?: string;
  };
  telegram: {
    status: 'ok' | 'error' | 'unknown';
    connected?: boolean;
    error?: string;
  };
  openrouter: {
    status: 'ok' | 'error' | 'unknown';
    error?: string;
  };
  lastMessage?: string;
  queueDepth?: number;
  version?: string;
}

interface CanaryStats {
  behavior: string;
  baselineSamples: number;
  baselineScore: number;
  canarySamples: number;
  canaryScore: number;
  status: 'testing' | 'promoted' | 'rolled_back';
}

const providerStatus = new Map<string, boolean>();
let lastMessageTime: string | null = null;
let messageQueueDepth = 0;
let server: http.Server | null = null;

export function setProviderConnected(name: string, connected: boolean): void {
  providerStatus.set(name, connected);
}

export function setTelegramConnected(connected: boolean): void {
  setProviderConnected('telegram', connected);
}

export function setLastMessageTime(time: string): void {
  lastMessageTime = time;
}

export function setMessageQueueDepth(depth: number): void {
  messageQueueDepth = depth;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(' ');
}

function checkDatabaseHealth(): { database: HealthStatus['database'] } {
  try {
    const messagesDbPath = path.join(STORE_DIR, 'messages.db');
    const memoryDbPath = path.join(STORE_DIR, 'memory.db');

    let messageCount = 0;
    let taskCount = 0;
    let memoryItemCount = 0;

    if (fs.existsSync(messagesDbPath)) {
      const db = new Database(messagesDbPath, { readonly: true });
      try {
        const msgRow = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
        messageCount = msgRow?.count || 0;

        const taskRow = db.prepare('SELECT COUNT(*) as count FROM scheduled_tasks').get() as { count: number };
        taskCount = taskRow?.count || 0;
      } finally {
        db.close();
      }
    }

    if (fs.existsSync(memoryDbPath)) {
      const db = new Database(memoryDbPath, { readonly: true });
      try {
        const memRow = db.prepare('SELECT COUNT(*) as count FROM memory_items').get() as { count: number };
        memoryItemCount = memRow?.count || 0;
      } finally {
        db.close();
      }
    }

    return {
      database: {
        status: 'ok',
        messageCount,
        taskCount,
        memoryItemCount
      }
    };
  } catch (err) {
    return {
      database: {
        status: 'error',
        error: err instanceof Error ? err.message : String(err)
      }
    };
  }
}

function checkContainerHealth(): HealthStatus['container'] {
  try {
    if (CONTAINER_MODE === 'daemon') {
      const output = execSync('docker ps --filter "label=dotclaw.group" --format "{{.Names}}"', {
        stdio: 'pipe',
        timeout: 5000
      }).toString().trim();

      const runningDaemons = output ? output.split('\n').filter(Boolean).length : 0;

      return {
        status: 'ok',
        mode: CONTAINER_MODE,
        runningDaemons
      };
    }

    // For ephemeral mode, just check Docker is available
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    return {
      status: 'ok',
      mode: CONTAINER_MODE
    };
  } catch (err) {
    return {
      status: 'error',
      mode: CONTAINER_MODE,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function checkTelegramHealth(): HealthStatus['telegram'] {
  const connected = providerStatus.get('telegram') ?? false;
  return {
    status: connected ? 'ok' : 'unknown',
    connected
  };
}

export function getProviderHealthStatuses(): Array<{ name: string; connected: boolean }> {
  return Array.from(providerStatus.entries()).map(([name, connected]) => ({ name, connected }));
}

async function checkOpenRouterHealth(): Promise<HealthStatus['openrouter']> {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return { status: 'error', error: 'API key not configured' };
    }

    // Simple check - just verify key format
    // We don't make actual API calls to avoid rate limits
    if (!apiKey.startsWith('sk-or-')) {
      return { status: 'error', error: 'Invalid API key format' };
    }

    return { status: 'ok' };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function getVersion(): string | undefined {
  try {
    const pkgPath = path.join(PACKAGE_ROOT, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version;
    }
  } catch {
    // Ignore
  }
  return undefined;
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const uptime = process.uptime();
  const memUsage = process.memoryUsage();

  const { database } = checkDatabaseHealth();
  const container = checkContainerHealth();
  const telegram = checkTelegramHealth();
  const openrouter = await checkOpenRouterHealth();

  // Determine overall status
  let status: HealthStatus['status'] = 'healthy';
  if (database.status === 'error' || container.status === 'error') {
    status = 'unhealthy';
  } else if (telegram.status === 'unknown' || openrouter.status === 'error') {
    status = 'degraded';
  }

  return {
    status,
    uptime,
    uptimeFormatted: formatUptime(uptime),
    timestamp: new Date().toISOString(),
    memory: {
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      rss: memUsage.rss
    },
    database,
    container,
    telegram,
    openrouter,
    lastMessage: lastMessageTime || undefined,
    queueDepth: messageQueueDepth,
    version: getVersion()
  };
}

export async function getCanaryStats(): Promise<CanaryStats[]> {
  // Try to read canary stats from autotune database
  try {
    const autotuneDbPath = path.join(DATA_DIR, 'autotune.db');
    if (!fs.existsSync(autotuneDbPath)) {
      return [];
    }

    const db = new Database(autotuneDbPath, { readonly: true });
    try {
      // Query autotune canary experiments if table exists
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='canary_experiments'`).all();
      if (tables.length === 0) {
        return [];
      }

      const rows = db.prepare(`
        SELECT
          behavior,
          baseline_samples,
          baseline_score,
          canary_samples,
          canary_score,
          status
        FROM canary_experiments
        ORDER BY updated_at DESC
        LIMIT 10
      `).all() as Array<{
        behavior: string;
        baseline_samples: number;
        baseline_score: number;
        canary_samples: number;
        canary_score: number;
        status: string;
      }>;

      return rows.map(row => ({
        behavior: row.behavior,
        baselineSamples: row.baseline_samples,
        baselineScore: row.baseline_score,
        canarySamples: row.canary_samples,
        canaryScore: row.canary_score,
        status: row.status as 'testing' | 'promoted' | 'rolled_back'
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getStatusEmoji(status: string): string {
  switch (status) {
    case 'healthy':
    case 'ok':
      return '✅';
    case 'degraded':
    case 'unknown':
      return '⚠️';
    case 'unhealthy':
    case 'error':
      return '❌';
    default:
      return '❓';
  }
}

function renderHtmlDashboard(health: HealthStatus): string {
  const statusColor = health.status === 'healthy' ? '#22c55e' : health.status === 'degraded' ? '#eab308' : '#ef4444';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DotClaw Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      line-height: 1.6;
      padding: 2rem;
    }
    .container { max-width: 800px; margin: 0 auto; }
    h1 {
      font-size: 2rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.875rem;
      font-weight: 500;
      background: ${statusColor};
      color: white;
      text-transform: uppercase;
    }
    .version { color: #64748b; font-size: 0.875rem; margin-bottom: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
    .card {
      background: #1e293b;
      border-radius: 0.75rem;
      padding: 1.25rem;
      border: 1px solid #334155;
    }
    .card h2 {
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #94a3b8;
      margin-bottom: 1rem;
    }
    .metric {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-bottom: 1px solid #334155;
    }
    .metric:last-child { border-bottom: none; }
    .metric-label { color: #94a3b8; }
    .metric-value { font-weight: 500; }
    .status-icon { font-size: 1.25rem; }
    footer {
      margin-top: 2rem;
      text-align: center;
      color: #64748b;
      font-size: 0.875rem;
    }
    footer a { color: #60a5fa; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
    @media (max-width: 640px) {
      body { padding: 1rem; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      🐾 DotClaw
      <span class="status-badge">${health.status}</span>
    </h1>
    <p class="version">${health.version ? `v${health.version} • ` : ''}Uptime: ${health.uptimeFormatted}</p>

    <div class="grid">
      <div class="card">
        <h2>Services</h2>
        <div class="metric">
          <span class="metric-label">Database</span>
          <span class="metric-value">${getStatusEmoji(health.database.status)} ${health.database.status}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Container (${health.container.mode})</span>
          <span class="metric-value">${getStatusEmoji(health.container.status)} ${health.container.status}${health.container.runningDaemons !== undefined ? ` (${health.container.runningDaemons} daemons)` : ''}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Telegram</span>
          <span class="metric-value">${getStatusEmoji(health.telegram.status)} ${health.telegram.status}</span>
        </div>
        <div class="metric">
          <span class="metric-label">OpenRouter</span>
          <span class="metric-value">${getStatusEmoji(health.openrouter.status)} ${health.openrouter.status}</span>
        </div>
      </div>

      <div class="card">
        <h2>Memory</h2>
        <div class="metric">
          <span class="metric-label">Heap Used</span>
          <span class="metric-value">${formatBytes(health.memory.heapUsed)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Heap Total</span>
          <span class="metric-value">${formatBytes(health.memory.heapTotal)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">RSS</span>
          <span class="metric-value">${formatBytes(health.memory.rss)}</span>
        </div>
      </div>

      <div class="card">
        <h2>Data</h2>
        <div class="metric">
          <span class="metric-label">Messages</span>
          <span class="metric-value">${health.database.messageCount?.toLocaleString() ?? '-'}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Memory Items</span>
          <span class="metric-value">${health.database.memoryItemCount?.toLocaleString() ?? '-'}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Scheduled Tasks</span>
          <span class="metric-value">${health.database.taskCount?.toLocaleString() ?? '-'}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Queue Depth</span>
          <span class="metric-value">${health.queueDepth ?? 0}</span>
        </div>
      </div>

      <div class="card">
        <h2>Activity</h2>
        <div class="metric">
          <span class="metric-label">Last Message</span>
          <span class="metric-value">${health.lastMessage ? new Date(health.lastMessage).toLocaleString() : 'Never'}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Updated</span>
          <span class="metric-value">${new Date(health.timestamp).toLocaleString()}</span>
        </div>
      </div>
    </div>

    <footer>
      <p>DotClaw • <a href="/health">JSON API</a> • <a href="/canary">Canary Stats</a></p>
    </footer>
  </div>
  <script>
    // Auto-refresh every 30 seconds
    setTimeout(() => location.reload(), 30000);
  </script>
</body>
</html>`;
}

export function startDashboard(): void {
  if (!runtime.host.dashboard.enabled) {
    logger.info('Dashboard disabled');
    return;
  }
  const port = runtime.host.dashboard.port;
  const bind = runtime.host.bind;

  server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    try {
      if (url === '/health' || url === '/health/') {
        const health = await getHealthStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health, null, 2));
        return;
      }

      if (url === '/canary' || url === '/canary/') {
        const stats = await getCanaryStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ canary: stats }, null, 2));
        return;
      }

      if (url === '/' || url === '/status' || url === '/status/') {
        const health = await getHealthStatus();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderHtmlDashboard(health));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      logger.error({ err, url }, 'Dashboard request error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.listen(port, bind, () => {
    logger.info({ port, bind }, 'Dashboard server started');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Dashboard server error');
  });
}

export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
}
