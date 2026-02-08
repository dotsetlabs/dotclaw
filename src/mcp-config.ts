export type McpServerRecord = {
  name: string;
  transport: 'stdio';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpConfigRecord = {
  enabled: boolean;
  servers: McpServerRecord[];
};

export type McpConfigActionResult =
  | { ok: true; changed: boolean; mcp: McpConfigRecord }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeServer(raw: unknown): McpServerRecord | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  const args = Array.isArray(raw.args)
    ? raw.args.filter((value): value is string => typeof value === 'string')
    : undefined;
  const env = isRecord(raw.env)
    ? Object.fromEntries(
      Object.entries(raw.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
    : undefined;
  return {
    name,
    transport: 'stdio',
    command: command || undefined,
    args: args && args.length > 0 ? args : undefined,
    env: env && Object.keys(env).length > 0 ? env : undefined
  };
}

export function normalizeMcpConfig(raw: unknown): McpConfigRecord {
  if (!isRecord(raw)) {
    return { enabled: false, servers: [] };
  }
  const servers = Array.isArray(raw.servers)
    ? raw.servers.map(normalizeServer).filter((server): server is McpServerRecord => Boolean(server))
    : [];
  return {
    enabled: raw.enabled === true,
    servers
  };
}

function sameConfig(a: McpConfigRecord, b: McpConfigRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function applyMcpConfigAction(current: McpConfigRecord, payload: Record<string, unknown>): McpConfigActionResult {
  const action = typeof payload.action === 'string' ? payload.action : '';
  const next: McpConfigRecord = {
    enabled: current.enabled,
    servers: current.servers.map(server => ({ ...server }))
  };

  switch (action) {
    case 'enable':
      next.enabled = true;
      break;
    case 'disable':
      next.enabled = false;
      break;
    case 'add_server': {
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      const command = typeof payload.command === 'string' ? payload.command.trim() : '';
      if (!name || !command) {
        return { ok: false, error: 'name and command required' };
      }
      if (next.servers.some(server => server.name === name)) {
        return { ok: false, error: `Server "${name}" already exists` };
      }
      const args = Array.isArray(payload.args_list)
        ? payload.args_list.filter((value): value is string => typeof value === 'string')
        : undefined;
      const env = isRecord(payload.env)
        ? Object.fromEntries(
          Object.entries(payload.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
        : undefined;
      next.servers.push({
        name,
        transport: 'stdio',
        command,
        args: args && args.length > 0 ? args : undefined,
        env: env && Object.keys(env).length > 0 ? env : undefined
      });
      break;
    }
    case 'remove_server': {
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!name) {
        return { ok: false, error: 'name required' };
      }
      next.servers = next.servers.filter(server => server.name !== name);
      break;
    }
    default:
      return { ok: false, error: `Unknown MCP action: ${action}` };
  }

  return {
    ok: true,
    changed: !sameConfig(current, next),
    mcp: next
  };
}
