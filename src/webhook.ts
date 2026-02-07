import http from 'http';
import type { RegisteredGroup } from './types.js';
import { createTraceBase, executeAgentRun, recordAgentTelemetry, AgentExecutionError } from './agent-execution.js';
import { routeRequest } from './request-router.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { logger } from './logger.js';

export interface WebhookConfig {
  enabled: boolean;
  port: number;
  token: string;
}

export interface WebhookDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sessions: () => Record<string, string>;
  setSession: (folder: string, id: string) => void;
}

let server: http.Server | null = null;
let shuttingDown = false;

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB
const SAFE_GROUP_FOLDER_RE = /^[a-z0-9][a-z0-9_-]*$/;

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let byteLength = 0;
    req.on('data', (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function startWebhookServer(config: WebhookConfig, deps: WebhookDeps): void {
  if (!config.enabled || !config.token) {
    logger.info('Webhook server disabled');
    return;
  }

  const runtime = loadRuntimeConfig();
  const bind = runtime.host.bind;

  server = http.createServer(async (req, res) => {
    if (shuttingDown) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server is shutting down' }));
      return;
    }

    const url = req.url || '/';

    // Health check
    if (url === '/webhook/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Only accept POST to /webhook/:groupFolder
    if (req.method !== 'POST' || !url.startsWith('/webhook/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Auth
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${config.token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const groupFolder = decodeURIComponent(url.replace('/webhook/', '').replace(/\/$/, ''));
    if (!groupFolder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing group folder in URL' }));
      return;
    }
    if (!SAFE_GROUP_FOLDER_RE.test(groupFolder)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid group folder name' }));
      return;
    }

    // Find registered group by folder name
    const groups = deps.registeredGroups();
    const group = Object.values(groups).find(g => g.folder === groupFolder);
    if (!group) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Group "${groupFolder}" not found` }));
      return;
    }

    let body: { message?: string; userId?: string; metadata?: Record<string, unknown> };
    try {
      const raw = await parseBody(req);
      body = JSON.parse(raw);
    } catch (parseErr) {
      const isBodyTooLarge = parseErr instanceof Error && parseErr.message === 'Body too large';
      const statusCode = isBodyTooLarge ? 413 : 400;
      const errorMsg = isBodyTooLarge ? 'Request body too large' : 'Invalid JSON body';
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: errorMsg }));
      return;
    }

    if (!body.message || typeof body.message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "message" field' }));
      return;
    }

    const routing = routeRequest();
    const traceBase = createTraceBase({
      chatId: `webhook:${groupFolder}`,
      groupFolder: group.folder,
      userId: body.userId ?? undefined,
      inputText: body.message,
      source: 'webhook'
    });

    try {
      const sessions = deps.sessions();
      const { output, context } = await executeAgentRun({
        group,
        prompt: body.message,
        chatJid: `webhook:${groupFolder}`,
        userId: body.userId ?? undefined,
        recallQuery: body.message,
        recallMaxResults: routing.recallMaxResults,
        recallMaxTokens: routing.recallMaxTokens,
        sessionId: sessions[group.folder],
        onSessionUpdate: (sessionId) => { deps.setSession(group.folder, sessionId); },
        modelFallbacks: routing.fallbacks,
        modelMaxOutputTokens: routing.maxOutputTokens || undefined,
        maxToolSteps: routing.maxToolSteps,
        useGroupLock: true,
        useSemaphore: true,
      });

      recordAgentTelemetry({
        traceBase,
        output,
        context,
        metricsSource: 'webhook',
        toolAuditSource: 'message',
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: output.status,
        result: output.result,
        model: output.model,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ groupFolder, err }, 'Webhook agent error');
      if (err instanceof AgentExecutionError) {
        recordAgentTelemetry({
          traceBase,
          output: null,
          context: err.context,
          metricsSource: 'webhook',
          toolAuditSource: 'message',
          errorMessage: message,
          errorType: 'agent',
        });
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(port(config.port), bind, () => {
    logger.info({ port: config.port, bind }, 'Webhook server started');
  });
}

function port(p: number): number {
  return Number.isFinite(p) && p > 0 ? p : 3003;
}

export function stopWebhookServer(): void {
  shuttingDown = true;
  if (server) {
    server.close();
    server = null;
  }
}
