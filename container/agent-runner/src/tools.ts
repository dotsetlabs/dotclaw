import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import dns from 'dns/promises';
import net from 'net';
import { tool as sdkTool, type Tool } from '@openrouter/sdk';
import { z } from 'zod';
import { createIpcHandlers, IpcContext } from './ipc.js';
import type { AgentRuntimeConfig } from './agent-config.js';

type ToolConfig = {
  name: string;
  description?: string;
  inputSchema: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  eventSchema?: z.ZodTypeAny;
  nextTurnParams?: Record<string, unknown>;
  requireApproval?: boolean | ((params: unknown, context: unknown) => boolean | Promise<boolean>);
  execute: unknown;
};

const tool = sdkTool as unknown as (config: ToolConfig) => Tool;

type ToolRuntime = {
  outputLimitBytes: number;
  bashTimeoutMs: number;
  bashOutputLimitBytes: number;
  webfetchMaxBytes: number;
  webfetchTimeoutMs: number;
  websearchTimeoutMs: number;
  pluginHttpTimeoutMs: number;
  grepMaxFileBytes: number;
  pluginMaxBytes: number;
  toolSummary: {
    enabled: boolean;
    maxBytes: number;
    model: string;
    maxOutputTokens: number;
    tools: string[];
    timeoutMs: number;
  };
  progress: {
    enabled: boolean;
    minIntervalMs: number;
    notifyTools: string[];
    notifyOnStart: boolean;
    notifyOnError: boolean;
  };
  openrouter: {
    siteUrl: string;
    siteName: string;
  };
  enableBash: boolean;
  enableWebSearch: boolean;
  enableWebFetch: boolean;
  webfetchBlockPrivate: boolean;
  webfetchAllowlist: string[];
  webfetchBlocklist: string[];
  pluginDirs: string[];
};

function buildToolRuntime(config: AgentRuntimeConfig['agent']): ToolRuntime {
  const webfetchAllowlist = (config.tools.webfetch.allowlist || [])
    .map(normalizeDomain)
    .filter(Boolean);
  const webfetchBlocklist = (config.tools.webfetch.blocklist || [])
    .map(normalizeDomain)
    .filter(Boolean);
  const pluginDirs = Array.from(new Set([
    ...config.tools.plugin.dirs,
    ...DEFAULT_PLUGIN_DIRS
  ]));
  const toolSummaryTools = (config.tools.toolSummary.tools || [])
    .map(toolName => toolName.trim().toLowerCase())
    .filter(Boolean);
  const toolSummaryTimeoutMs = Math.min(config.openrouter.timeoutMs, 30_000);

  return {
    outputLimitBytes: config.tools.outputLimitBytes,
    bashTimeoutMs: config.tools.bash.timeoutMs,
    bashOutputLimitBytes: config.tools.bash.outputLimitBytes,
    webfetchMaxBytes: config.tools.webfetch.maxBytes,
    webfetchTimeoutMs: config.tools.webfetch.timeoutMs,
    websearchTimeoutMs: config.tools.websearch.timeoutMs,
    pluginHttpTimeoutMs: config.tools.plugin.httpTimeoutMs,
    grepMaxFileBytes: config.tools.grepMaxFileBytes,
    pluginMaxBytes: config.tools.plugin.maxBytes,
    toolSummary: {
      enabled: config.tools.toolSummary.enabled,
      maxBytes: config.tools.toolSummary.maxBytes,
      model: config.models.toolSummary,
      maxOutputTokens: config.tools.toolSummary.maxOutputTokens,
      tools: toolSummaryTools,
      timeoutMs: toolSummaryTimeoutMs
    },
    progress: {
      enabled: config.tools.progress.enabled,
      minIntervalMs: config.tools.progress.minIntervalMs,
      notifyTools: config.tools.progress.notifyTools,
      notifyOnStart: config.tools.progress.notifyOnStart,
      notifyOnError: config.tools.progress.notifyOnError
    },
    openrouter: {
      siteUrl: config.openrouter.siteUrl,
      siteName: config.openrouter.siteName
    },
    enableBash: config.tools.enableBash,
    enableWebSearch: config.tools.enableWebSearch,
    enableWebFetch: config.tools.enableWebFetch,
    webfetchBlockPrivate: config.tools.webfetch.blockPrivate,
    webfetchAllowlist,
    webfetchBlocklist,
    pluginDirs
  };
}

const WORKSPACE_GROUP = '/workspace/group';
const WORKSPACE_GLOBAL = '/workspace/global';
const WORKSPACE_EXTRA = '/workspace/extra';
const WORKSPACE_PROJECT = '/workspace/project';

const DEFAULT_PLUGIN_DIRS = [
  path.join(WORKSPACE_GROUP, 'plugins'),
  path.join(WORKSPACE_GLOBAL, 'plugins')
];

const PLUGIN_SCHEMA = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(['http', 'bash']),
  method: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  query_params: z.record(z.string(), z.string()).optional(),
  body: z.record(z.string(), z.any()).optional(),
  command: z.string().optional(),
  input: z.record(z.string(), z.enum(['string', 'number', 'boolean'])).optional(),
  required: z.array(z.string()).optional()
});

type PluginConfig = z.infer<typeof PLUGIN_SCHEMA>;

export type ToolCallRecord = {
  name: string;
  args?: unknown;
  ok: boolean;
  duration_ms?: number;
  error?: string;
  output_bytes?: number;
  output_truncated?: boolean;
};

type ToolCallLogger = (record: ToolCallRecord) => void;

export type ToolPolicy = {
  allow?: string[];
  deny?: string[];
  max_per_run?: Record<string, number>;
  default_max_per_run?: number;
};

function getAllowedRoots(isMain: boolean): string[] {
  const roots = [WORKSPACE_GROUP, WORKSPACE_GLOBAL, WORKSPACE_EXTRA];
  if (isMain) roots.push(WORKSPACE_PROJECT);
  return roots.map(root => path.resolve(root));
}

function isWithinRoot(targetPath: string, root: string): boolean {
  return targetPath === root || targetPath.startsWith(`${root}${path.sep}`);
}

function resolvePath(inputPath: string, isMain: boolean, mustExist = false): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path is required');
  }
  const roots = getAllowedRoots(isMain);
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(WORKSPACE_GROUP, inputPath);

  if (!roots.some(root => isWithinRoot(resolved, root))) {
    throw new Error(`Path is outside allowed roots: ${resolved}`);
  }

  if (mustExist && !fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  return resolved;
}

function resolveGroupPath(inputPath: string, mustExist = false): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path is required');
  }
  const groupRoot = path.resolve(WORKSPACE_GROUP);
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(WORKSPACE_GROUP, inputPath);
  if (!isWithinRoot(resolved, groupRoot)) {
    throw new Error(`Path must be inside /workspace/group: ${resolved}`);
  }
  if (mustExist && !fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  return resolved;
}

function limitText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
  const truncated = buf.subarray(0, end).toString('utf-8');
  return { text: truncated + '\n[OUTPUT TRUNCATED]', truncated: true };
}

function normalizeDomain(value: string): string {
  let normalized = value.trim().toLowerCase();
  normalized = normalized.replace(/^[a-z]+:\/\//, '');
  normalized = normalized.split('/')[0];
  normalized = normalized.split(':')[0];
  return normalized;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  label: string
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError') {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRedirects(params: {
  url: string;
  options: RequestInit;
  timeoutMs: number;
  label: string;
  allowlist: string[];
  blocklist: string[];
  blockPrivate: boolean;
  maxRedirects?: number;
}): Promise<Response> {
  let currentUrl = params.url;
  let options: RequestInit = { ...params.options, redirect: 'manual' };
  const maxRedirects = Number.isFinite(params.maxRedirects) ? Number(params.maxRedirects) : 5;
  let redirectsRemaining = maxRedirects;

  while (true) {
    const response = await fetchWithTimeout(currentUrl, options, params.timeoutMs, params.label);
    const status = response.status;
    const location = response.headers.get('location');
    if (status >= 300 && status < 400 && location) {
      if (redirectsRemaining <= 0) {
        throw new Error(`Too many redirects fetching ${params.url}`);
      }
      redirectsRemaining -= 1;
      const nextUrl = new URL(location, currentUrl).toString();
      await assertUrlAllowed({
        url: nextUrl,
        allowlist: params.allowlist,
        blocklist: params.blocklist,
        blockPrivate: params.blockPrivate
      });
      const method = (options.method || 'GET').toUpperCase();
      const forceGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
      if (forceGet) {
        options = { ...options, method: 'GET' };
        delete (options as { body?: unknown }).body;
      }
      currentUrl = nextUrl;
      continue;
    }
    return response;
  }
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === 'ip6-localhost'
    || normalized.endsWith('.local')
    || normalized === 'metadata.google.internal'
    || normalized === 'metadata';
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(part => parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80')) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

function isPrivateIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

async function resolveIps(hostname: string): Promise<string[]> {
  try {
    const results = await dns.lookup(hostname, { all: true });
    return results.map(record => record.address);
  } catch {
    return [];
  }
}

async function assertUrlAllowed(params: {
  url: string;
  allowlist: string[];
  blocklist: string[];
  blockPrivate: boolean;
}) {
  let hostname: string;
  try {
    hostname = new URL(params.url).hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid URL: ${params.url}`);
  }

  const isBlocked = params.blocklist.some(domain =>
    hostname === domain || hostname.endsWith(`.${domain}`)
  );
  if (isBlocked) {
    throw new Error(`WebFetch blocked for host: ${hostname}`);
  }

  if (params.allowlist.length > 0) {
    const isAllowed = params.allowlist.some(domain =>
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
    if (!isAllowed) {
      throw new Error(`WebFetch not allowed for host: ${hostname}`);
    }
  }

  if (params.blockPrivate) {
    if (isLocalHostname(hostname)) {
      throw new Error(`WebFetch blocked for local host: ${hostname}`);
    }
    if (isPrivateIp(hostname)) {
      throw new Error(`WebFetch blocked for private IP: ${hostname}`);
    }
    const resolved = await resolveIps(hostname);
    for (const ip of resolved) {
      if (isPrivateIp(ip)) {
        throw new Error(`WebFetch blocked for private IP: ${ip}`);
      }
    }
  }
}

function sanitizeToolArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  const record = { ...(args as Record<string, unknown>) };

  if ('content' in record && typeof record.content === 'string') {
    record.content = `<redacted:${(record.content as string).length}>`;
  }
  if ('text' in record && typeof record.text === 'string') {
    record.text = `<redacted:${(record.text as string).length}>`;
  }
  if ('old_text' in record && typeof record.old_text === 'string') {
    record.old_text = `<redacted:${(record.old_text as string).length}>`;
  }
  if ('new_text' in record && typeof record.new_text === 'string') {
    record.new_text = `<redacted:${(record.new_text as string).length}>`;
  }
  if ('command' in record && typeof record.command === 'string') {
    record.command = (record.command as string).slice(0, 200);
  }

  return record;
}

function toPosixPath(inputPath: string): string {
  return inputPath.split(path.sep).join('/');
}

function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*') {
      const next = pattern[i + 1];
      if (next === '*') {
        const nextNext = pattern[i + 2];
        if (nextNext === '/') {
          regex += '(?:.*/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
        continue;
      }
      regex += '[^/]*';
      i += 1;
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      i += 1;
      continue;
    }
    if ('\\^$+?.()|{}[]'.includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
    i += 1;
  }
  return new RegExp(`^${regex}$`);
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
    return process.env[key] || '';
  });
}

function interpolateTemplate(value: string, args: Record<string, unknown>): string {
  const expanded = expandEnv(value);
  return expanded.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const replacement = args[key];
    if (replacement === undefined || replacement === null) return '';
    return String(replacement);
  });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildInputSchema(config: PluginConfig) {
  const shape: Record<string, z.ZodTypeAny> = {};
  const input = config.input || {};
  const required = new Set(config.required || []);

  for (const [key, value] of Object.entries(input)) {
    let schema: z.ZodTypeAny;
    if (value === 'number') schema = z.number();
    else if (value === 'boolean') schema = z.boolean();
    else schema = z.string();
    shape[key] = required.has(key) ? schema : schema.optional();
  }

  return z.object(shape).passthrough();
}

function loadPluginConfigs(dirs: string[]): PluginConfig[] {
  const configs: PluginConfig[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(file => file.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        const parsed = PLUGIN_SCHEMA.parse(raw);
        configs.push(parsed);
      } catch (err) {
        console.error(`[agent-runner] Malformed plugin config ${path.join(dir, file)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return configs;
}

function getSearchRoot(patternPosix: string): string {
  const globIndex = patternPosix.search(/[*?]/);
  if (globIndex === -1) {
    return patternPosix;
  }
  const slashIndex = patternPosix.lastIndexOf('/', globIndex);
  if (slashIndex <= 0) return '/';
  return patternPosix.slice(0, slashIndex);
}

function walkFileTree(
  rootPath: string,
  options: { includeFiles: boolean; includeDirs: boolean; maxResults: number }
): string[] {
  const results: string[] = [];
  const stack: string[] = [rootPath];

  while (stack.length > 0 && results.length < options.maxResults) {
    const current = stack.pop();
    if (!current) continue;
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      if (options.includeDirs) results.push(current);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (results.length >= options.maxResults) break;
        const nextPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          stack.push(nextPath);
        } else if (entry.isFile()) {
          if (options.includeFiles) results.push(nextPath);
        }
      }
    } else if (stats.isFile()) {
      if (options.includeFiles) results.push(current);
    }
  }

  return results;
}

async function runCommand(command: string, timeoutMs: number, outputLimit: number, cwd = WORKSPACE_GROUP) {
  return new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    truncated: boolean;
  }>((resolve) => {
    const start = Date.now();
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: process.env,
      detached: true
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let totalBytes = 0;
    const maxBytes = outputLimit;

    const killProcessGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch { /* process already exited */ }
      }
    };

    const append = (chunk: Buffer | string, isStdout: boolean) => {
      if (truncated) return;
      const text = chunk.toString();
      const chunkBytes = Buffer.byteLength(text, 'utf-8');
      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) {
        truncated = true;
        killProcessGroup('SIGTERM');
        setTimeout(() => killProcessGroup('SIGKILL'), 2000);
        return;
      }
      const toAdd = chunkBytes > remaining
        ? Buffer.from(text).subarray(0, remaining).toString('utf-8')
        : text;
      const addedBytes = chunkBytes > remaining ? remaining : chunkBytes;
      if (isStdout) {
        stdout += toAdd;
      } else {
        stderr += toAdd;
      }
      totalBytes += addedBytes;
      if (totalBytes >= maxBytes) {
        truncated = true;
        killProcessGroup('SIGTERM');
        setTimeout(() => killProcessGroup('SIGKILL'), 2000);
      }
    };

    child.stdout.on('data', (data) => append(data, true));
    child.stderr.on('data', (data) => append(data, false));

    const timeout = setTimeout(() => {
      killProcessGroup('SIGTERM');
      setTimeout(() => killProcessGroup('SIGKILL'), 5000);
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - start,
        truncated
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr: `${stderr}\n${err instanceof Error ? err.message : String(err)}`.trim(),
        exitCode: 1,
        durationMs: Date.now() - start,
        truncated
      });
    });
  });
}

async function readFileSafe(filePath: string, maxBytes: number) {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return { content: fs.readFileSync(filePath, 'utf-8'), truncated: false, size: stat.size };
  }
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(maxBytes);
  const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
  fs.closeSync(fd);
  return { content: buffer.subarray(0, bytesRead).toString('utf-8'), truncated: true, size: stat.size };
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength <= maxBytes) {
      return { body: Buffer.from(buffer), truncated: false };
    }
    return { body: Buffer.from(buffer).subarray(0, maxBytes), truncated: true };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  return { body: Buffer.concat(chunks, total), truncated };
}

type ToolSummaryPayload = {
  text: string;
  metadata: {
    toolName: string;
    url?: string;
    status?: number;
    contentType?: string | null;
    truncated?: boolean;
  };
  apply: (summary: string) => unknown;
};

function toolSummaryMatches(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const normalized = name.toLowerCase();
  for (const pattern of patterns) {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (normalized.startsWith(prefix)) return true;
    } else if (normalized === pattern) {
      return true;
    }
  }
  return false;
}

function getToolSummaryPayload(name: string, result: unknown): ToolSummaryPayload | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;

  if (name === 'WebFetch' && typeof record.content === 'string') {
    return {
      text: record.content,
      metadata: {
        toolName: name,
        url: typeof record.url === 'string' ? record.url : undefined,
        status: typeof record.status === 'number' ? record.status : undefined,
        contentType: typeof record.contentType === 'string' ? record.contentType : undefined,
        truncated: Boolean(record.truncated)
      },
      apply: (summary) => ({
        ...record,
        content: summary,
        truncated: true
      })
    };
  }

  if (name.startsWith('plugin__') && typeof record.body === 'string') {
    return {
      text: record.body,
      metadata: {
        toolName: name,
        status: typeof record.status === 'number' ? record.status : undefined,
        contentType: typeof record.contentType === 'string' ? record.contentType : undefined,
        truncated: Boolean(record.truncated)
      },
      apply: (summary) => ({
        ...record,
        body: summary,
        truncated: true
      })
    };
  }

  return null;
}

function buildOpenRouterHeaders(runtime: ToolRuntime): Record<string, string> | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (runtime.openrouter.siteUrl) {
    headers['HTTP-Referer'] = runtime.openrouter.siteUrl;
  }
  if (runtime.openrouter.siteName) {
    headers['X-Title'] = runtime.openrouter.siteName;
  }
  return headers;
}

async function summarizeToolOutput(payload: ToolSummaryPayload, runtime: ToolRuntime, maxInputBytes: number): Promise<string | null> {
  const headers = buildOpenRouterHeaders(runtime);
  if (!headers) return null;

  const { text, truncated: inputTruncated } = limitText(payload.text, maxInputBytes);
  if (!text.trim()) return null;

  const metadataLines = [
    `Tool: ${payload.metadata.toolName}`,
    payload.metadata.url ? `URL: ${payload.metadata.url}` : null,
    typeof payload.metadata.status === 'number' ? `Status: ${payload.metadata.status}` : null,
    payload.metadata.contentType ? `Content-Type: ${payload.metadata.contentType}` : null,
    `Original bytes: ${Buffer.byteLength(payload.text, 'utf-8')}`,
    `Original truncated: ${payload.metadata.truncated ? 'true' : 'false'}`,
    `Input truncated for summary: ${inputTruncated ? 'true' : 'false'}`
  ].filter(Boolean).join('\n');

  const systemPrompt = [
    'You summarize tool output for downstream reasoning.',
    'Return a concise, factual summary with key entities, products, and dates.',
    'Use short bullet points when helpful.',
    'If the content is incomplete or truncated, mention that clearly.'
  ].join(' ');

  const userPrompt = `${metadataLines}\n\nContent:\n${text}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtime.toolSummary.timeoutMs);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: runtime.toolSummary.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_completion_tokens: runtime.toolSummary.maxOutputTokens,
        temperature: 0.2,
        reasoning_effort: 'low'
      }),
      signal: controller.signal
    });
    const bodyText = await response.text();
    if (!response.ok) {
      console.error(`[agent-runner] Tool summary failed (${response.status}): ${bodyText.slice(0, 300)}`);
      return null;
    }
    const data = JSON.parse(bodyText);
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
    if (!content || !String(content).trim()) return null;
    const summary = String(content).trim();
    return `Summary:\n${summary}`;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error('[agent-runner] Tool summary timed out');
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function maybeSummarizeToolResult<T>(name: string, result: T, runtime: ToolRuntime): Promise<T> {
  if (!runtime.toolSummary.enabled) return result;
  if (!toolSummaryMatches(name, runtime.toolSummary.tools)) return result;
  const payload = getToolSummaryPayload(name, result);
  if (!payload) return result;
  const contentBytes = Buffer.byteLength(payload.text, 'utf-8');
  if (!Number.isFinite(runtime.toolSummary.maxBytes) || contentBytes <= runtime.toolSummary.maxBytes) {
    return result;
  }
  const summary = await summarizeToolOutput(payload, runtime, runtime.toolSummary.maxBytes);
  if (!summary) return result;
  const limited = limitText(summary, runtime.outputLimitBytes);
  return payload.apply(limited.text) as T;
}

export function createTools(
  ctx: IpcContext,
  config: AgentRuntimeConfig['agent'],
  options?: { onToolCall?: ToolCallLogger; policy?: ToolPolicy; jobProgress?: { jobId?: string; enabled?: boolean } }
) {
  const runtime = buildToolRuntime(config);
  const ipc = createIpcHandlers(ctx, config.ipc);
  const isMain = ctx.isMain;
  const onToolCall = options?.onToolCall;
  const policy = options?.policy;
  const progressConfig = runtime.progress;
  const progressJobId = options?.jobProgress?.jobId;
  const progressEnabled = Boolean(progressJobId && progressConfig.enabled && options?.jobProgress?.enabled !== false);
  const progressNotifyTools = new Set(
    (progressConfig.notifyTools || []).map(item => item.trim().toLowerCase()).filter(Boolean)
  );
  let lastProgressNotifyAt = 0;
  const hasAllowPolicy = Array.isArray(policy?.allow);
  const allowList = (policy?.allow || []).map(item => item.toLowerCase());
  const denyList = (policy?.deny || []).map(item => item.toLowerCase());
  const maxPerRunConfig = policy?.max_per_run || {};
  const maxPerRun = new Map<string, number>();
  for (const [key, value] of Object.entries(maxPerRunConfig)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      maxPerRun.set(key.toLowerCase(), value);
    }
  }
  const defaultMax = policy?.default_max_per_run ?? 12;
  const usageCounts = new Map<string, number>();

  const enableBash = runtime.enableBash;
  const enableWebSearch = runtime.enableWebSearch;
  const enableWebFetch = runtime.enableWebFetch;
  const blockPrivate = runtime.webfetchBlockPrivate;
  const webFetchAllowlist = runtime.webfetchAllowlist;
  const webFetchBlocklist = runtime.webfetchBlocklist;

  const shouldNotifyTool = (name: string) => {
    if (!progressEnabled) return false;
    if (!progressNotifyTools || progressNotifyTools.size === 0) return false;
    return progressNotifyTools.has(name.toLowerCase());
  };

  const sendJobUpdate = (payload: { message: string; level?: 'info' | 'progress' | 'warn' | 'error'; notify?: boolean; data?: Record<string, unknown> }) => {
    if (!progressEnabled || !progressJobId) return;
    void ipc.jobUpdate({
      job_id: progressJobId,
      message: payload.message,
      level: payload.level,
      notify: payload.notify,
      data: payload.data
    }).catch(() => undefined);
  };

  const wrapExecute = <TInput, TOutput>(name: string, execute: (args: TInput) => Promise<TOutput>) => {
    return async (args: TInput): Promise<TOutput> => {
      const start = Date.now();
      const normalizedName = name.toLowerCase();
      const isSystemTool = normalizedName.startsWith('mcp__');
      try {
        if (denyList.includes(normalizedName)) {
          throw new Error(`Tool is disabled by policy: ${name}`);
        }
        if (hasAllowPolicy && !allowList.includes(normalizedName)) {
          throw new Error(`Tool not allowed by policy: ${name}`);
        }
        const currentCount = usageCounts.get(name) || 0;
        const maxAllowed = maxPerRun.get(normalizedName) ?? defaultMax;
        if (Number.isFinite(maxAllowed) && maxAllowed > 0 && currentCount >= maxAllowed) {
          throw new Error(`Tool usage limit reached for ${name} (max ${maxAllowed} per run)`);
        }
        usageCounts.set(name, currentCount + 1);

        if (!isSystemTool && shouldNotifyTool(name) && progressConfig.notifyOnStart) {
          const now = Date.now();
          if (now - lastProgressNotifyAt >= progressConfig.minIntervalMs) {
            lastProgressNotifyAt = now;
            sendJobUpdate({
              message: `Running ${name}...`,
              level: 'progress',
              notify: true,
              data: { tool: name, stage: 'start' }
            });
          } else {
            sendJobUpdate({
              message: `Running ${name}...`,
              level: 'progress',
              notify: false,
              data: { tool: name, stage: 'start' }
            });
          }
        }

        const rawResult = await execute(args);
        const result = await maybeSummarizeToolResult(name, rawResult, runtime);
        let outputBytes: number | undefined;
        let outputTruncated: boolean | undefined;
        try {
          const serialized = JSON.stringify(result);
          outputBytes = Buffer.byteLength(serialized, 'utf-8');
        } catch {
          // ignore serialization failure
        }
        if (result && typeof result === 'object' && 'truncated' in (result as Record<string, unknown>)) {
          outputTruncated = Boolean((result as Record<string, unknown>).truncated);
        }
        onToolCall?.({
          name,
          args: sanitizeToolArgs(args),
          ok: true,
          duration_ms: Date.now() - start,
          output_bytes: outputBytes,
          output_truncated: outputTruncated
        });
        if (!isSystemTool && shouldNotifyTool(name)) {
          sendJobUpdate({
            message: `${name} finished.`,
            level: 'info',
            notify: false,
            data: { tool: name, stage: 'end', ok: true, duration_ms: Date.now() - start }
          });
        }
        return result;
      } catch (err) {
        onToolCall?.({
          name,
          args: sanitizeToolArgs(args),
          ok: false,
          duration_ms: Date.now() - start,
          error: err instanceof Error ? err.message : String(err)
        });
        if (!isSystemTool && shouldNotifyTool(name) && progressConfig.notifyOnError) {
          sendJobUpdate({
            message: `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
            level: 'error',
            notify: true,
            data: { tool: name, stage: 'end', ok: false, duration_ms: Date.now() - start }
          });
        }
        throw err;
      }
    };
  };

  const bashTool = tool({
    name: 'Bash',
    description: 'Run a shell command inside the container. CWD is /workspace/group.',
    inputSchema: z.object({
      command: z.string().describe('Command to run'),
      timeoutMs: z.number().int().positive().optional().describe('Timeout in milliseconds')
    }),
    outputSchema: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number(),
      truncated: z.boolean()
    }),
    execute: wrapExecute('Bash', async ({ command, timeoutMs }: { command: string; timeoutMs?: number }) => {
      return runCommand(command, timeoutMs || runtime.bashTimeoutMs, runtime.bashOutputLimitBytes);
    })
  });

  const pythonTool = tool({
    name: 'Python',
    description: 'Execute Python code in a sandboxed environment. Available packages: pandas, numpy, requests, beautifulsoup4, matplotlib. CWD is /workspace/group.',
    inputSchema: z.object({
      code: z.string().describe('Python code to execute'),
      timeoutMs: z.number().int().positive().optional().describe('Timeout in milliseconds (default 30000)')
    }),
    outputSchema: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number(),
      truncated: z.boolean()
    }),
    execute: wrapExecute('Python', async ({ code, timeoutMs }: { code: string; timeoutMs?: number }) => {
      // Write code to a temp file and execute it
      const tempFile = path.join(WORKSPACE_GROUP, `.tmp_script_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
      fs.writeFileSync(tempFile, code);
      try {
        const result = await runCommand(`python3 ${tempFile}`, timeoutMs || 30000, runtime.bashOutputLimitBytes);
        return result;
      } finally {
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    })
  });

  const gitCloneTool = tool({
    name: 'GitClone',
    description: 'Clone a git repository into the workspace.',
    inputSchema: z.object({
      repo: z.string().describe('Git repository URL'),
      dest: z.string().optional().describe('Destination path (relative to /workspace/group)'),
      depth: z.number().int().positive().optional().describe('Shallow clone depth'),
      branch: z.string().optional().describe('Branch or tag to checkout')
    }),
    outputSchema: z.object({
      path: z.string(),
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number(),
      truncated: z.boolean()
    }),
    execute: wrapExecute('GitClone', async ({ repo, dest, depth, branch }: { repo: string; dest?: string; depth?: number; branch?: string }) => {
      const targetPath = dest
        ? resolvePath(dest, isMain, false)
        : resolvePath(path.basename(repo.replace(/\.git$/, '')) || 'repo', isMain, false);
      if (fs.existsSync(targetPath)) {
        throw new Error(`Destination already exists: ${targetPath}`);
      }
      const args = [
        'git', 'clone',
        depth ? `--depth ${Math.floor(depth)}` : '',
        branch ? `--branch ${shellEscape(branch)}` : '',
        shellEscape(repo),
        shellEscape(targetPath)
      ].filter(Boolean).join(' ');
      return runCommand(args, runtime.bashTimeoutMs, runtime.bashOutputLimitBytes);
    })
  });

  const npmInstallTool = tool({
    name: 'NpmInstall',
    description: 'Install npm packages in the workspace.',
    inputSchema: z.object({
      packages: z.array(z.string()).optional().describe('Packages to install (default: install from package.json)'),
      dev: z.boolean().optional().describe('Install as dev dependencies'),
      path: z.string().optional().describe('Working directory (relative to /workspace/group)')
    }),
    outputSchema: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number(),
      truncated: z.boolean()
    }),
    execute: wrapExecute('NpmInstall', async ({ packages, dev, path: workdir }: { packages?: string[]; dev?: boolean; path?: string }) => {
      const cwd = workdir ? resolvePath(workdir, isMain, true) : WORKSPACE_GROUP;
      const pkgList = packages && packages.length > 0 ? packages.map(shellEscape).join(' ') : '';
      const devFlag = dev ? '--save-dev' : '';
      const command = `npm install ${devFlag} ${pkgList}`.trim();
      return runCommand(command, runtime.bashTimeoutMs, runtime.bashOutputLimitBytes, cwd);
    })
  });

  const readTool = tool({
    name: 'Read',
    description: 'Read a file from the mounted workspace.',
    inputSchema: z.object({
      path: z.string().describe('File path (relative to /workspace/group or absolute within mounts)'),
      maxBytes: z.number().int().positive().optional().describe('Maximum bytes to read')
    }),
    outputSchema: z.object({
      path: z.string(),
      content: z.string(),
      truncated: z.boolean(),
      size: z.number()
    }),
    execute: wrapExecute('Read', async ({ path: inputPath, maxBytes }: { path: string; maxBytes?: number }) => {
      const resolved = resolvePath(inputPath, isMain, true);
      const { content, truncated, size } = await readFileSafe(resolved, Math.min(maxBytes || runtime.outputLimitBytes, runtime.outputLimitBytes));
      return { path: resolved, content, truncated, size };
    })
  });

  const writeTool = tool({
    name: 'Write',
    description: 'Write a file to the mounted workspace.',
    inputSchema: z.object({
      path: z.string().describe('File path (relative to /workspace/group or absolute within mounts)'),
      content: z.string().describe('File contents'),
      overwrite: z.boolean().optional().describe('Overwrite if file exists (default true)')
    }),
    outputSchema: z.object({
      path: z.string(),
      bytesWritten: z.number()
    }),
    execute: wrapExecute('Write', async ({ path: inputPath, content, overwrite }: { path: string; content: string; overwrite?: boolean }) => {
      const resolved = resolvePath(inputPath, isMain, false);
      if (fs.existsSync(resolved) && overwrite === false) {
        throw new Error(`File already exists: ${resolved}`);
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content);
      return { path: resolved, bytesWritten: Buffer.byteLength(content, 'utf-8') };
    })
  });

  const editTool = tool({
    name: 'Edit',
    description: 'Replace a substring in a file.',
    inputSchema: z.object({
      path: z.string().describe('File path (relative to /workspace/group or absolute within mounts)'),
      old_text: z.string().describe('Text to replace'),
      new_text: z.string().describe('Replacement text')
    }),
    outputSchema: z.object({
      path: z.string(),
      replaced: z.boolean(),
      occurrences: z.number()
    }),
    execute: wrapExecute('Edit', async ({ path: inputPath, old_text, new_text }: { path: string; old_text: string; new_text: string }) => {
      if (!old_text) {
        throw new Error('old_text must be non-empty');
      }
      const resolved = resolvePath(inputPath, isMain, true);
      const content = fs.readFileSync(resolved, 'utf-8');
      const occurrences = content.split(old_text).length - 1;
      if (occurrences === 0) {
        return { path: resolved, replaced: false, occurrences: 0 };
      }
      const updated = content.replaceAll(old_text, new_text);
      fs.writeFileSync(resolved, updated);
      return { path: resolved, replaced: true, occurrences };
    })
  });

  const globTool = tool({
    name: 'Glob',
    description: 'List files matching a glob pattern (relative to /workspace/group).',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern'),
      maxResults: z.number().int().positive().optional().describe('Maximum results')
    }),
    outputSchema: z.object({
      matches: z.array(z.string())
    }),
    execute: wrapExecute('Glob', async ({ pattern, maxResults }: { pattern: string; maxResults?: number }) => {
      const roots = getAllowedRoots(isMain);
      const absolutePattern = path.isAbsolute(pattern)
        ? resolvePath(pattern, isMain, false)
        : path.resolve(WORKSPACE_GROUP, pattern);
      const patternPosix = toPosixPath(absolutePattern);

      if (!roots.some(root => isWithinRoot(absolutePattern, root))) {
        throw new Error(`Glob pattern is outside allowed roots: ${pattern}`);
      }

      if (!/[*?]/.test(patternPosix)) {
        if (!fs.existsSync(absolutePattern)) {
          return { matches: [] };
        }
        return { matches: [absolutePattern] };
      }

      const searchRoot = getSearchRoot(patternPosix);
      if (!roots.some(root => isWithinRoot(searchRoot, root))) {
        throw new Error(`Glob search root is outside allowed roots: ${searchRoot}`);
      }

      const regex = globToRegex(patternPosix);
      const limit = Math.min(maxResults || 200, 2000);
      const candidates = walkFileTree(searchRoot, {
        includeFiles: true,
        includeDirs: true,
        maxResults: limit * 5
      });

      const matches = candidates.filter(candidate => {
        const posixCandidate = toPosixPath(candidate);
        return regex.test(posixCandidate);
      });

      return { matches: matches.slice(0, limit) };
    })
  });

  const grepTool = tool({
    name: 'Grep',
    description: 'Search for a pattern in files.',
    inputSchema: z.object({
      pattern: z.string().describe('Search pattern (plain text or regex)'),
      path: z.string().optional().describe('File or directory path (default /workspace/group)'),
      glob: z.string().optional().describe('Glob pattern to filter files (default **/*)'),
      regex: z.boolean().optional().describe('Treat pattern as regex'),
      maxResults: z.number().int().positive().optional().describe('Maximum matches')
    }),
    outputSchema: z.object({
      matches: z.array(z.object({
        path: z.string(),
        lineNumber: z.number(),
        line: z.string()
      }))
    }),
    execute: wrapExecute('Grep', async ({
      pattern,
      path: targetPath,
      glob,
      regex,
      maxResults
    }: { pattern: string; path?: string; glob?: string; regex?: boolean; maxResults?: number }) => {
      const basePath = resolvePath(targetPath || WORKSPACE_GROUP, isMain, true);
      const stats = fs.statSync(basePath);
      const limit = Math.min(maxResults || 200, 2000);
      const results: Array<{ path: string; lineNumber: number; line: string }> = [];

      const matcher = regex ? new RegExp(pattern, 'i') : null;
      const globPattern = glob || '**/*';
      const globRegex = globToRegex(toPosixPath(globPattern));

      const files = stats.isFile()
        ? [basePath]
        : walkFileTree(basePath, {
          includeFiles: true,
          includeDirs: false,
          maxResults: limit * 50
        });

      for (const file of files) {
        if (results.length >= limit) break;
        const relative = toPosixPath(path.relative(basePath, file) || '');
        if (relative && !globRegex.test(relative)) continue;
        let content: string;
        try {
          const stat = fs.statSync(file);
          if (stat.size > runtime.grepMaxFileBytes) continue;
          content = fs.readFileSync(file, 'utf-8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          const match = matcher ? matcher.test(line) : line.includes(pattern);
          if (match) {
            results.push({ path: file, lineNumber: i + 1, line });
            if (results.length >= limit) break;
          }
        }
      }

      return { matches: results };
    })
  });

  const webFetchTool = tool({
    name: 'WebFetch',
    description: 'Fetch a URL and return its contents.',
    inputSchema: z.object({
      url: z.string().describe('URL to fetch'),
      maxBytes: z.number().int().positive().optional().describe('Max bytes to read')
    }),
    outputSchema: z.object({
      url: z.string(),
      status: z.number(),
      contentType: z.string().nullable(),
      content: z.string(),
      truncated: z.boolean()
    }),
    execute: wrapExecute('WebFetch', async ({ url, maxBytes }: { url: string; maxBytes?: number }) => {
      await assertUrlAllowed({
        url,
        allowlist: webFetchAllowlist,
        blocklist: webFetchBlocklist,
        blockPrivate
      });

      const response = await fetchWithRedirects({
        url,
        options: {
          headers: {
            'User-Agent': 'DotClaw/1.0',
            'Accept': 'text/html,application/json,text/plain,*/*'
          }
        },
        timeoutMs: runtime.webfetchTimeoutMs,
        label: 'WebFetch',
        allowlist: webFetchAllowlist,
        blocklist: webFetchBlocklist,
        blockPrivate
      });
      const { body, truncated } = await readResponseWithLimit(response, maxBytes || runtime.webfetchMaxBytes);
      const contentType = response.headers.get('content-type');
      let content = '';
      if (contentType && (contentType.includes('text') || contentType.includes('json'))) {
        content = body.toString('utf-8');
      } else {
        content = body.toString('utf-8');
      }
      const limited = limitText(content, runtime.outputLimitBytes);
      return {
        url: response.url || url,
        status: response.status,
        contentType,
        content: limited.text,
        truncated: truncated || limited.truncated
      };
    })
  });

  const webSearchInputSchema = z.object({
    query: z.string().describe('Search query'),
    count: z.number().int().positive().optional().describe('Number of results (default 5)'),
    offset: z.number().int().nonnegative().optional().describe('Offset for pagination'),
    safesearch: z.enum(['off', 'moderate', 'strict']).optional().describe('Safe search setting')
  });
  const webSearchOutputSchema = z.object({
    query: z.string(),
    results: z.array(z.object({
      title: z.string().nullable(),
      url: z.string().nullable(),
      description: z.string().nullable()
    }))
  });
  type WebSearchInput = z.infer<typeof webSearchInputSchema>;
  type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;

  const webSearchTool = tool({
    name: 'WebSearch',
    description: 'Search the web using Brave Search API.',
    inputSchema: webSearchInputSchema,
    outputSchema: webSearchOutputSchema,
    execute: wrapExecute('WebSearch', async ({
      query,
      count,
      offset,
      safesearch
    }: WebSearchInput): Promise<WebSearchOutput> => {
      const apiKey = process.env.BRAVE_SEARCH_API_KEY;
      if (!apiKey) {
        throw new Error('BRAVE_SEARCH_API_KEY is not set');
      }
      const params = new URLSearchParams({
        q: query,
        count: String(Math.min(count || 5, 20)),
        offset: String(offset || 0),
        safesearch: safesearch || 'moderate'
      });
      const response = await fetchWithTimeout(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey
        }
      }, runtime.websearchTimeoutMs, 'WebSearch');
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Brave search error (${response.status}): ${text}`);
      }
      const data = await response.json() as { web?: { results?: Array<Record<string, unknown>> } };
      const toMaybeString = (value: unknown): string | null =>
        typeof value === 'string' ? value : null;
      const results: WebSearchOutput['results'] = (data?.web?.results || []).map((result) => ({
        title: toMaybeString(result?.title),
        url: toMaybeString(result?.url),
        description: toMaybeString(result?.description) ?? toMaybeString(result?.snippet)
      }));
      return { query, results };
    })
  });

  const pluginTools = loadPluginConfigs(runtime.pluginDirs).map((config) => {
    const inputSchema = buildInputSchema(config);
    const toolName = `plugin__${config.name}`;

    if (config.type === 'http') {
      return tool({
        name: toolName,
        description: config.description,
        inputSchema,
        outputSchema: z.object({
          status: z.number(),
          contentType: z.string().nullable(),
          body: z.string(),
          truncated: z.boolean()
        }),
        execute: wrapExecute(toolName, async (args: Record<string, unknown>) => {
          if (!config.url) {
            throw new Error(`Plugin ${config.name} missing url`);
          }
          const method = (config.method || 'GET').toUpperCase();
          let url = interpolateTemplate(config.url, args);

          const queryParams = config.query_params || {};
          const queryEntries: Record<string, string> = {};
          for (const [key, value] of Object.entries(queryParams)) {
            queryEntries[key] = interpolateTemplate(String(value), args);
          }
          const queryString = new URLSearchParams(queryEntries).toString();
          if (queryString) {
            url += (url.includes('?') ? '&' : '?') + queryString;
          }

          await assertUrlAllowed({
            url,
            allowlist: webFetchAllowlist,
            blocklist: webFetchBlocklist,
            blockPrivate
          });

          const headers: Record<string, string> = {};
          if (config.headers) {
            for (const [key, value] of Object.entries(config.headers)) {
              headers[key] = interpolateTemplate(String(value), args);
            }
          }

          let body: string | undefined;
          if (config.body && method !== 'GET') {
            const payload: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(config.body)) {
              if (typeof value === 'string') {
                payload[key] = interpolateTemplate(value, args);
              } else {
                payload[key] = value;
              }
            }
            body = JSON.stringify(payload);
            headers['Content-Type'] = headers['Content-Type'] || 'application/json';
          }

          const response = await fetchWithRedirects({
            url,
            options: { method, headers, body },
            timeoutMs: runtime.pluginHttpTimeoutMs,
            label: 'Plugin HTTP',
            allowlist: webFetchAllowlist,
            blocklist: webFetchBlocklist,
            blockPrivate
          });
          const { body: responseBody, truncated } = await readResponseWithLimit(response, runtime.pluginMaxBytes);
          const contentType = response.headers.get('content-type');
          const text = responseBody.toString('utf-8');
          const limited = limitText(text, runtime.outputLimitBytes);
          return {
            status: response.status,
            contentType,
            body: limited.text,
            truncated: truncated || limited.truncated
          };
        })
      });
    }

    if (config.type === 'bash') {
      return tool({
        name: toolName,
        description: config.description,
        inputSchema,
        outputSchema: z.object({
          stdout: z.string(),
          stderr: z.string(),
          exitCode: z.number().int().nullable(),
          durationMs: z.number(),
          truncated: z.boolean()
        }),
        execute: wrapExecute(toolName, async (args: Record<string, unknown>) => {
          if (!config.command) {
            throw new Error(`Plugin ${config.name} missing command`);
          }
          const escaped: Record<string, unknown> = {};
          for (const [key, val] of Object.entries(args)) {
            escaped[key] = typeof val === 'string' ? shellEscape(val) : val;
          }
          const command = interpolateTemplate(config.command, escaped);
          return runCommand(command, runtime.bashTimeoutMs, runtime.bashOutputLimitBytes);
        })
      });
    }

    return null;
  }).filter(Boolean) as Tool[];

  const requiredTelegramText = z.string().trim().min(1);
  const requiredTelegramSingleMessageText = z.string().trim().min(1).max(4096);
  const optionalTelegramCaption = z.string().trim().min(1).max(1024).optional();
  const requiredWorkspacePath = z.string().trim().min(1);
  const optionalNameField = z.string().trim().min(1).max(128).optional();

  const sendMessageTool = tool({
    name: 'mcp__dotclaw__send_message',
    description: 'Send a message to the current Telegram chat.',
    inputSchema: z.object({
      text: requiredTelegramText.describe('The message text to send'),
      reply_to_message_id: z.number().int().positive().optional().describe('Message ID to reply to')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__send_message', async ({ text, reply_to_message_id }: { text: string; reply_to_message_id?: number }) =>
      ipc.sendMessage(text, reply_to_message_id ? { reply_to_message_id } : undefined))
  });

  const sendFileTool = tool({
    name: 'mcp__dotclaw__send_file',
    description: 'Send a file/document to the current Telegram chat. The file must exist under /workspace/group.',
    inputSchema: z.object({
      path: requiredWorkspacePath.describe('File path (relative to /workspace/group or absolute under /workspace/group)'),
      caption: optionalTelegramCaption.describe('Optional caption text'),
      reply_to_message_id: z.number().int().positive().optional().describe('Message ID to reply to')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__send_file', async ({ path: inputPath, caption, reply_to_message_id }: { path: string; caption?: string; reply_to_message_id?: number }) => {
      const resolved = resolveGroupPath(inputPath, true);
      return ipc.sendFile({ path: resolved, caption, reply_to_message_id });
    })
  });

  const sendPhotoTool = tool({
    name: 'mcp__dotclaw__send_photo',
    description: 'Send a photo/image to the current Telegram chat with compression. The file must exist under /workspace/group.',
    inputSchema: z.object({
      path: requiredWorkspacePath.describe('Image file path (relative to /workspace/group or absolute under /workspace/group)'),
      caption: optionalTelegramCaption.describe('Optional caption text'),
      reply_to_message_id: z.number().int().positive().optional().describe('Message ID to reply to')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__send_photo', async ({ path: inputPath, caption, reply_to_message_id }: { path: string; caption?: string; reply_to_message_id?: number }) => {
      const resolved = resolveGroupPath(inputPath, true);
      return ipc.sendPhoto({ path: resolved, caption, reply_to_message_id });
    })
  });

  const sendVoiceTool = tool({
    name: 'mcp__dotclaw__send_voice',
    description: 'Send a voice message to the current Telegram chat. File must be .ogg format with Opus codec.',
    inputSchema: z.object({
      path: requiredWorkspacePath.describe('Voice file path (relative to /workspace/group or absolute under /workspace/group)'),
      caption: optionalTelegramCaption.describe('Optional caption text'),
      duration: z.number().int().positive().optional().describe('Duration in seconds'),
      reply_to_message_id: z.number().int().positive().optional().describe('Message ID to reply to')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__send_voice', async ({ path: inputPath, caption, duration, reply_to_message_id }: { path: string; caption?: string; duration?: number; reply_to_message_id?: number }) => {
      const resolved = resolveGroupPath(inputPath, true);
      return ipc.sendVoice({ path: resolved, caption, duration, reply_to_message_id });
    })
  });

  const sendAudioTool = tool({
    name: 'mcp__dotclaw__send_audio',
    description: 'Send an audio file to the current Telegram chat (mp3, m4a, etc.).',
    inputSchema: z.object({
      path: requiredWorkspacePath.describe('Audio file path (relative to /workspace/group or absolute under /workspace/group)'),
      caption: optionalTelegramCaption.describe('Optional caption text'),
      duration: z.number().int().positive().optional().describe('Duration in seconds'),
      performer: optionalNameField.describe('Audio performer/artist'),
      title: optionalNameField.describe('Audio title'),
      reply_to_message_id: z.number().int().positive().optional().describe('Message ID to reply to')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__send_audio', async ({ path: inputPath, caption, duration, performer, title, reply_to_message_id }: { path: string; caption?: string; duration?: number; performer?: string; title?: string; reply_to_message_id?: number }) => {
      const resolved = resolveGroupPath(inputPath, true);
      return ipc.sendAudio({ path: resolved, caption, duration, performer, title, reply_to_message_id });
    })
  });

  const sendLocationTool = tool({
    name: 'mcp__dotclaw__send_location',
    description: 'Send a location pin to the current Telegram chat.',
    inputSchema: z.object({
      latitude: z.number().min(-90).max(90).describe('Latitude'),
      longitude: z.number().min(-180).max(180).describe('Longitude'),
      reply_to_message_id: z.number().int().positive().optional().describe('Message ID to reply to')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__send_location', async ({ latitude, longitude, reply_to_message_id }: { latitude: number; longitude: number; reply_to_message_id?: number }) =>
      ipc.sendLocation({ latitude, longitude, reply_to_message_id }))
  });

  const sendContactTool = tool({
    name: 'mcp__dotclaw__send_contact',
    description: 'Send a contact card to the current Telegram chat.',
    inputSchema: z.object({
      phone_number: z.string().trim().min(1).max(64).describe('Phone number with country code'),
      first_name: z.string().trim().min(1).max(64).describe('First name'),
      last_name: z.string().trim().min(1).max(64).optional().describe('Last name'),
      reply_to_message_id: z.number().int().positive().optional().describe('Message ID to reply to')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__send_contact', async ({ phone_number, first_name, last_name, reply_to_message_id }: { phone_number: string; first_name: string; last_name?: string; reply_to_message_id?: number }) =>
      ipc.sendContact({ phone_number, first_name, last_name, reply_to_message_id }))
  });

  const sendPollTool = tool({
    name: 'mcp__dotclaw__send_poll',
    description: 'Create a Telegram poll in the current chat.',
    inputSchema: z.object({
      question: z.string().trim().min(1).max(300).describe('Poll question'),
      options: z.array(z.string().trim().min(1).max(100)).min(2).max(10).describe('Poll options (2-10)'),
      is_anonymous: z.boolean().optional().describe('Anonymous poll (default true)'),
      allows_multiple_answers: z.boolean().optional().describe('Allow multiple answers'),
      type: z.enum(['regular', 'quiz']).optional().describe('Poll type'),
      correct_option_id: z.number().int().nonnegative().optional().describe('Correct option index for quiz polls'),
      reply_to_message_id: z.number().int().positive().optional().describe('Message ID to reply to')
    }).superRefine((value, ctx) => {
      const uniqueCount = new Set(value.options.map(option => option.toLowerCase())).size;
      if (uniqueCount !== value.options.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options'],
          message: 'Poll options must be unique.'
        });
      }
      if (value.type === 'quiz' && value.correct_option_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['correct_option_id'],
          message: 'Quiz polls must specify correct_option_id.'
        });
      }
      if (value.type !== 'quiz' && value.correct_option_id !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['correct_option_id'],
          message: 'correct_option_id is only valid for quiz polls.'
        });
      }
      if (value.correct_option_id !== undefined && value.correct_option_id >= value.options.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['correct_option_id'],
          message: 'correct_option_id must be less than options length.'
        });
      }
      if (value.type === 'quiz' && value.allows_multiple_answers) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allows_multiple_answers'],
          message: 'Quiz polls cannot allow multiple answers.'
        });
      }
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__send_poll', async (args: { question: string; options: string[]; is_anonymous?: boolean; allows_multiple_answers?: boolean; type?: string; correct_option_id?: number; reply_to_message_id?: number }) =>
      ipc.sendPoll(args))
  });

  const sendButtonsTool = tool({
    name: 'mcp__dotclaw__send_buttons',
    description: 'Send a message with inline keyboard buttons. Each button can be a URL link or a callback button.',
    inputSchema: z.object({
      text: requiredTelegramSingleMessageText.describe('Message text above the buttons'),
      buttons: z.array(z.array(z.object({
        text: z.string().trim().min(1).max(64).describe('Button label'),
        url: z.string().trim().min(1).optional().describe('URL to open (for link buttons)'),
        callback_data: z.string().trim().min(1).max(64).optional().describe('Callback data (for interactive buttons)')
      }).superRefine((button, ctx) => {
        const hasUrl = typeof button.url === 'string' && button.url.trim().length > 0;
        const hasCallback = typeof button.callback_data === 'string' && button.callback_data.length > 0;
        if (hasUrl === hasCallback) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['url'],
            message: 'Each button must provide exactly one of url or callback_data.'
          });
          return;
        }
        if (hasUrl) {
          try {
            const parsed = new URL(button.url!);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'tg:') {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['url'],
                message: 'Button URL must use http, https, or tg protocol.'
              });
            }
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['url'],
              message: 'Button URL is invalid.'
            });
          }
        }
      })).min(1)).min(1).describe('2D array of buttons (rows × columns)'),
      reply_to_message_id: z.number().int().positive().optional().describe('Message ID to reply to')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__send_buttons', async (args: { text: string; buttons: Array<Array<{ text: string; url?: string; callback_data?: string }>>; reply_to_message_id?: number }) =>
      ipc.sendButtons(args))
  });

  const editMessageTool = tool({
    name: 'mcp__dotclaw__edit_message',
    description: 'Edit a previously sent message by message ID.',
    inputSchema: z.object({
      message_id: z.number().int().positive().describe('The message ID to edit'),
      text: requiredTelegramSingleMessageText.describe('New message text'),
      chat_jid: z.string().optional().describe('Target chat ID (defaults to current chat)')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__edit_message', async ({ message_id, text, chat_jid }: { message_id: number; text: string; chat_jid?: string }) =>
      ipc.editMessage({ message_id, text, chat_jid }))
  });

  const deleteMessageTool = tool({
    name: 'mcp__dotclaw__delete_message',
    description: 'Delete a message by message ID.',
    inputSchema: z.object({
      message_id: z.number().int().positive().describe('The message ID to delete'),
      chat_jid: z.string().optional().describe('Target chat ID (defaults to current chat)')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__delete_message', async ({ message_id, chat_jid }: { message_id: number; chat_jid?: string }) =>
      ipc.deleteMessage({ message_id, chat_jid }))
  });

  const downloadUrlTool = tool({
    name: 'mcp__dotclaw__download_url',
    description: 'Download a URL to the workspace as a file.',
    inputSchema: z.object({
      url: z.string().describe('URL to download'),
      filename: z.string().optional().describe('Output filename (auto-detected from URL if omitted)'),
      output_dir: z.string().optional().describe('Output directory under /workspace/group (default: /workspace/group/downloads)')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      path: z.string().optional(),
      size: z.number().optional(),
      content_type: z.string().nullable().optional(),
      truncated: z.boolean().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__download_url', async ({ url, filename, output_dir }: { url: string; filename?: string; output_dir?: string }) => {
      await assertUrlAllowed({
        url,
        allowlist: webFetchAllowlist,
        blocklist: webFetchBlocklist,
        blockPrivate
      });

      const response = await fetchWithRedirects({
        url,
        options: {
          headers: {
            'User-Agent': 'DotClaw/1.0',
            'Accept': '*/*'
          }
        },
        timeoutMs: runtime.webfetchTimeoutMs,
        label: 'download_url',
        allowlist: webFetchAllowlist,
        blocklist: webFetchBlocklist,
        blockPrivate
      });

      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const { body, truncated } = await readResponseWithLimit(response, runtime.webfetchMaxBytes);

      let outputFilename = filename;
      if (!outputFilename) {
        try {
          const urlPath = new URL(url).pathname;
          const basename = path.basename(urlPath);
          outputFilename = basename && basename !== '/' ? basename : `download_${Date.now()}`;
        } catch {
          outputFilename = `download_${Date.now()}`;
        }
      }
      outputFilename = outputFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!outputFilename || outputFilename === '.' || outputFilename === '..') {
        outputFilename = `download_${Date.now()}`;
      }

      const outputDirectory = output_dir
        ? resolveGroupPath(output_dir, false)
        : resolveGroupPath('downloads', false);
      fs.mkdirSync(outputDirectory, { recursive: true });

      const outputPath = path.join(outputDirectory, outputFilename);
      fs.writeFileSync(outputPath, body);

      const contentType = response.headers.get('content-type');
      return {
        ok: true,
        path: outputPath,
        size: body.length,
        content_type: contentType,
        truncated
      };
    })
  });

  const scheduleTaskTool = tool({
    name: 'mcp__dotclaw__schedule_task',
    description: 'Schedule a recurring or one-time task.',
    inputSchema: z.object({
      prompt: z.string().describe('Task prompt'),
      schedule_type: z.enum(['cron', 'interval', 'once']),
      schedule_value: z.string(),
      timezone: z.string().optional().describe('Optional IANA timezone (e.g., America/New_York)'),
      context_mode: z.enum(['group', 'isolated']).optional(),
      target_group: z.string().optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__schedule_task', async (args: { prompt: string; schedule_type: 'cron' | 'interval' | 'once'; schedule_value: string; timezone?: string; context_mode?: 'group' | 'isolated'; target_group?: string }) =>
      ipc.scheduleTask(args))
  });

  const runTaskTool = tool({
    name: 'mcp__dotclaw__run_task',
    description: 'Run an existing scheduled task immediately without modifying its schedule.',
    inputSchema: z.object({
      task_id: z.string()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__run_task', async ({ task_id }: { task_id: string }) => ipc.runTask(task_id))
  });

  const listTasksTool = tool({
    name: 'mcp__dotclaw__list_tasks',
    description: 'List all scheduled tasks.',
    inputSchema: z.object({}),
    outputSchema: z.object({
      ok: z.boolean(),
      tasks: z.array(z.any())
    }),
    execute: wrapExecute('mcp__dotclaw__list_tasks', async () => ipc.listTasks())
  });

  const pauseTaskTool = tool({
    name: 'mcp__dotclaw__pause_task',
    description: 'Pause a scheduled task.',
    inputSchema: z.object({
      task_id: z.string()
    }),
    outputSchema: z.object({
      ok: z.boolean()
    }),
    execute: wrapExecute('mcp__dotclaw__pause_task', async ({ task_id }: { task_id: string }) => ipc.pauseTask(task_id))
  });

  const resumeTaskTool = tool({
    name: 'mcp__dotclaw__resume_task',
    description: 'Resume a paused task.',
    inputSchema: z.object({
      task_id: z.string()
    }),
    outputSchema: z.object({
      ok: z.boolean()
    }),
    execute: wrapExecute('mcp__dotclaw__resume_task', async ({ task_id }: { task_id: string }) => ipc.resumeTask(task_id))
  });

  const cancelTaskTool = tool({
    name: 'mcp__dotclaw__cancel_task',
    description: 'Cancel a scheduled task.',
    inputSchema: z.object({
      task_id: z.string()
    }),
    outputSchema: z.object({
      ok: z.boolean()
    }),
    execute: wrapExecute('mcp__dotclaw__cancel_task', async ({ task_id }: { task_id: string }) => ipc.cancelTask(task_id))
  });

  const updateTaskTool = tool({
    name: 'mcp__dotclaw__update_task',
    description: 'Update a scheduled task (state, prompt, schedule, or status).',
    inputSchema: z.object({
      task_id: z.string(),
      state_json: z.string().optional(),
      prompt: z.string().optional(),
      schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
      schedule_value: z.string().optional(),
      timezone: z.string().optional(),
      context_mode: z.enum(['group', 'isolated']).optional(),
      status: z.enum(['active', 'paused', 'completed']).optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__update_task', async (args: { task_id: string; state_json?: string; prompt?: string; schedule_type?: string; schedule_value?: string; timezone?: string; context_mode?: string; status?: string }) =>
      ipc.updateTask(args))
  });

  const spawnJobTool = tool({
    name: 'mcp__dotclaw__spawn_job',
    description: 'Start a background job that runs asynchronously and reports results later.',
    inputSchema: z.object({
      prompt: z.string(),
      context_mode: z.enum(['group', 'isolated']).optional(),
      timeout_ms: z.number().optional(),
      max_tool_steps: z.number().optional(),
      tool_allow: z.array(z.string()).optional(),
      tool_deny: z.array(z.string()).optional(),
      model_override: z.string().optional(),
      priority: z.number().optional(),
      tags: z.array(z.string()).optional(),
      target_group: z.string().optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__spawn_job', async (args: {
      prompt: string;
      context_mode?: 'group' | 'isolated';
      timeout_ms?: number;
      max_tool_steps?: number;
      tool_allow?: string[];
      tool_deny?: string[];
      model_override?: string;
      priority?: number;
      tags?: string[];
      target_group?: string;
    }) => ipc.spawnJob(args))
  });

  const jobStatusTool = tool({
    name: 'mcp__dotclaw__job_status',
    description: 'Get the status of a background job.',
    inputSchema: z.object({
      job_id: z.string()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__job_status', async ({ job_id }: { job_id: string }) => ipc.jobStatus(job_id))
  });

  const listJobsTool = tool({
    name: 'mcp__dotclaw__list_jobs',
    description: 'List background jobs for the group.',
    inputSchema: z.object({
      status: z.string().optional(),
      limit: z.number().optional(),
      target_group: z.string().optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__list_jobs', async (args: { status?: string; limit?: number; target_group?: string }) => ipc.listJobs(args))
  });

  const cancelJobTool = tool({
    name: 'mcp__dotclaw__cancel_job',
    description: 'Cancel a background job.',
    inputSchema: z.object({
      job_id: z.string()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__cancel_job', async ({ job_id }: { job_id: string }) => ipc.cancelJob(job_id))
  });

  const jobUpdateTool = tool({
    name: 'mcp__dotclaw__job_update',
    description: 'Log progress or send a notification for a background job.',
    inputSchema: z.object({
      job_id: z.string(),
      message: z.string(),
      level: z.enum(['info', 'progress', 'warn', 'error']).optional(),
      notify: z.boolean().optional(),
      data: z.record(z.string(), z.any()).optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__job_update', async (args: { job_id: string; message: string; level?: string; notify?: boolean; data?: Record<string, unknown> }) =>
      ipc.jobUpdate(args))
  });

  const registerGroupTool = tool({
    name: 'mcp__dotclaw__register_group',
    description: 'Register a new Telegram chat (main group only).',
    inputSchema: z.object({
      jid: z.string(),
      name: z.string(),
      folder: z.string(),
      trigger: z.string().optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__register_group', async ({ jid, name, folder, trigger }: { jid: string; name: string; folder: string; trigger?: string }) =>
      ipc.registerGroup({ jid, name, folder, trigger }))
  });

  const removeGroupTool = tool({
    name: 'mcp__dotclaw__remove_group',
    description: 'Remove a registered Telegram chat by chat id, name, or folder (main group only).',
    inputSchema: z.object({
      identifier: z.string().describe('Chat id, group name, or folder')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__remove_group', async ({ identifier }: { identifier: string }) =>
      ipc.removeGroup({ identifier }))
  });

  const listGroupsTool = tool({
    name: 'mcp__dotclaw__list_groups',
    description: 'List registered groups (main group only).',
    inputSchema: z.object({}),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__list_groups', async () => ipc.listGroups())
  });

  const setModelTool = tool({
    name: 'mcp__dotclaw__set_model',
    description: 'Set the active OpenRouter model (main group only).',
    inputSchema: z.object({
      model: z.string().describe('OpenRouter model ID (e.g., moonshotai/kimi-k2.5)'),
      scope: z.enum(['global', 'group', 'user']).optional(),
      target_id: z.string().optional().describe('Optional group folder or user id for scoped overrides')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__set_model', async ({ model, scope, target_id }: { model: string; scope?: 'global' | 'group' | 'user'; target_id?: string }) =>
      ipc.setModel({ model, scope, target_id }))
  });

  const memoryUpsertTool = tool({
    name: 'mcp__dotclaw__memory_upsert',
    description: 'Upsert long-term memory items (use for durable user or group facts/preferences).',
    inputSchema: z.object({
      items: z.array(z.object({
        scope: z.enum(['user', 'group', 'global']),
        subject_id: z.string().optional(),
        type: z.enum(['identity', 'preference', 'fact', 'relationship', 'project', 'task', 'note', 'archive']),
        kind: z.enum(['semantic', 'episodic', 'procedural', 'preference']).optional(),
        conflict_key: z.string().optional(),
        content: z.string(),
        importance: z.number().min(0).max(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
        tags: z.array(z.string()).optional(),
        ttl_days: z.number().optional()
      })),
      source: z.string().optional(),
      target_group: z.string().optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__memory_upsert', async ({ items, source, target_group }: { items: unknown[]; source?: string; target_group?: string }) =>
      ipc.memoryUpsert({ items, source, target_group }))
  });

  const memoryForgetTool = tool({
    name: 'mcp__dotclaw__memory_forget',
    description: 'Forget long-term memory items by id or content.',
    inputSchema: z.object({
      ids: z.array(z.string()).optional(),
      content: z.string().optional(),
      scope: z.enum(['user', 'group', 'global']).optional(),
      userId: z.string().optional(),
      target_group: z.string().optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__memory_forget', async (args: { ids?: string[]; content?: string; scope?: string; userId?: string; target_group?: string }) =>
      ipc.memoryForget(args))
  });

  const memoryListTool = tool({
    name: 'mcp__dotclaw__memory_list',
    description: 'List long-term memory items for the current group/user.',
    inputSchema: z.object({
      scope: z.enum(['user', 'group', 'global']).optional(),
      type: z.enum(['identity', 'preference', 'fact', 'relationship', 'project', 'task', 'note', 'archive']).optional(),
      userId: z.string().optional(),
      limit: z.number().int().positive().optional(),
      target_group: z.string().optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__memory_list', async (args: { scope?: string; type?: string; userId?: string; limit?: number; target_group?: string }) =>
      ipc.memoryList(args))
  });

  const memorySearchTool = tool({
    name: 'mcp__dotclaw__memory_search',
    description: 'Search long-term memory items.',
    inputSchema: z.object({
      query: z.string(),
      userId: z.string().optional(),
      limit: z.number().int().positive().optional(),
      target_group: z.string().optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__memory_search', async (args: { query: string; userId?: string; limit?: number; target_group?: string }) =>
      ipc.memorySearch(args))
  });

  const memoryStatsTool = tool({
    name: 'mcp__dotclaw__memory_stats',
    description: 'Get memory stats for the group/user.',
    inputSchema: z.object({
      userId: z.string().optional(),
      target_group: z.string().optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      result: z.any().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__memory_stats', async (args: { userId?: string; target_group?: string }) =>
      ipc.memoryStats(args))
  });

  const tools: Tool[] = [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    gitCloneTool,
    npmInstallTool,
    sendMessageTool,
    sendFileTool,
    sendPhotoTool,
    sendVoiceTool,
    sendAudioTool,
    sendLocationTool,
    sendContactTool,
    sendPollTool,
    sendButtonsTool,
    editMessageTool,
    deleteMessageTool,
    scheduleTaskTool,
    runTaskTool,
    listTasksTool,
    pauseTaskTool,
    resumeTaskTool,
    cancelTaskTool,
    updateTaskTool,
    spawnJobTool,
    jobStatusTool,
    listJobsTool,
    cancelJobTool,
    jobUpdateTool,
    memoryUpsertTool,
    memoryForgetTool,
    memoryListTool,
    memorySearchTool,
    memoryStatsTool,
    registerGroupTool,
    removeGroupTool,
    listGroupsTool,
    setModelTool,
    ...pluginTools
  ];

  if (enableBash) {
    tools.push(bashTool as Tool);
    tools.push(pythonTool as Tool);
  }
  if (enableWebSearch) tools.push(webSearchTool as Tool);
  if (enableWebFetch) {
    tools.push(webFetchTool as Tool);
    tools.push(downloadUrlTool as Tool);
  }

  return tools;
}
