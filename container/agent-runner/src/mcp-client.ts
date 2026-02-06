/**
 * Minimal MCP (Model Context Protocol) client implementation.
 * Supports stdio transport for connecting to MCP-compatible tool servers.
 */

import { spawn, ChildProcess } from 'child_process';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class McpStdioClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private buffer = '';
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private command: string;
  private args: string[];
  private env: Record<string, string>;
  private timeoutMs: number;

  constructor(options: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    timeoutMs?: number;
  }) {
    this.command = options.command;
    this.args = options.args || [];
    this.env = options.env || {};
    this.timeoutMs = options.timeoutMs || 10_000;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    // Resolve env vars that reference process.env
    const resolvedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env)) {
      resolvedEnv[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, envKey: string) => {
        return process.env[envKey] || '';
      });
    }

    this.proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...resolvedEnv }
    });

    this.proc.stdout!.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.proc.stderr!.on('data', (data: Buffer) => {
      console.error(`[mcp-client] stderr: ${data.toString().slice(0, 200)}`);
    });

    this.proc.on('close', () => {
      this.connected = false;
      for (const [, pending] of this.pending) {
        pending.reject(new Error('MCP server process closed'));
      }
      this.pending.clear();
    });

    this.proc.on('error', (err) => {
      console.error(`[mcp-client] process error: ${err.message}`);
      this.connected = false;
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`MCP server process error: ${err.message}`));
      }
      this.pending.clear();
    });

    // Initialize MCP connection
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dotclaw', version: '2.0.0' }
    });

    // Send initialized notification
    this.sendNotification('notifications/initialized');

    this.connected = true;
  }

  private processBuffer(): void {
    // Try to parse JSON-RPC messages from the buffer
    // MCP uses newline-delimited JSON
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const handler = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(msg.error.message));
          } else {
            handler.resolve(msg.result);
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin) {
        reject(new Error('MCP client not connected'));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      this.proc.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin) return;
    const notification = {
      jsonrpc: '2.0',
      method,
      params
    };
    this.proc.stdin.write(JSON.stringify(notification) + '\n');
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.sendRequest('tools/list') as { tools?: McpTool[] };
    return result?.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args
    }) as McpCallResult;
    return result;
  }

  async close(): Promise<void> {
    this.connected = false;
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    for (const [, pending] of this.pending) {
      pending.reject(new Error('MCP client closed'));
    }
    this.pending.clear();
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
