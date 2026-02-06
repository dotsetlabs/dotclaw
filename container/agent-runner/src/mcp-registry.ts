/**
 * MCP Tool Registry — discovers tools from MCP servers and creates SDK Tool definitions.
 * Tools are prefixed with mcp_ext__<server>__<tool> to avoid collisions with built-in tools.
 */

import { tool as sdkTool, type Tool } from '@openrouter/sdk';
import { z } from 'zod';
import { McpStdioClient, type McpTool, type McpCallResult } from './mcp-client.js';
import type { AgentRuntimeConfig } from './agent-config.js';

type ToolConfig = {
  name: string;
  description?: string;
  inputSchema: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  execute: unknown;
};

const tool = sdkTool as unknown as (config: ToolConfig) => Tool;

type McpServerConfig = NonNullable<AgentRuntimeConfig['agent']['mcp']['servers']>[number];

// Convert JSON Schema to a Zod object schema (best-effort)
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.any();

  const type = schema.type as string | undefined;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (schema.required as string[]) || [];

  if (type === 'object' && properties) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      let field = jsonSchemaToZod(propSchema);
      if (!required.includes(key)) {
        field = field.optional();
      }
      if (propSchema.description && typeof propSchema.description === 'string') {
        field = field.describe(propSchema.description);
      }
      shape[key] = field;
    }
    return z.object(shape).passthrough();
  }

  switch (type) {
    case 'string': {
      if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
        return z.enum(schema.enum as [string, ...string[]]);
      }
      return z.string();
    }
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      return z.array(items ? jsonSchemaToZod(items) : z.any());
    }
    default:
      return z.any();
  }
}

export class McpToolRegistry {
  private clients = new Map<string, McpStdioClient>();
  private serverConfigs: McpServerConfig[];
  private connectionTimeoutMs: number;
  private discoveredTools: Tool[] = [];

  constructor(config: AgentRuntimeConfig['agent']['mcp']) {
    this.serverConfigs = config.servers || [];
    this.connectionTimeoutMs = config.connectionTimeoutMs;
  }

  async discoverTools(wrapExecute: <TInput, TOutput>(name: string, execute: (args: TInput) => Promise<TOutput>) => (args: TInput) => Promise<TOutput>): Promise<Tool[]> {
    if (this.serverConfigs.length === 0) return [];

    const tools: Tool[] = [];

    for (const serverConfig of this.serverConfigs) {
      if (!serverConfig.command) continue;

      try {
        const client = new McpStdioClient({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
          timeoutMs: this.connectionTimeoutMs
        });

        this.clients.set(serverConfig.name, client);

        const mcpTools = await this.discoverServerTools(client);

        for (const mcpTool of mcpTools) {
          const toolName = `mcp_ext__${serverConfig.name}__${mcpTool.name}`;
          const inputSchema = jsonSchemaToZod(mcpTool.inputSchema);

          const sdkToolInstance = tool({
            name: toolName,
            description: mcpTool.description || `MCP tool from ${serverConfig.name}`,
            inputSchema,
            outputSchema: z.object({
              content: z.array(z.object({
                type: z.string(),
                text: z.string().optional()
              })).optional(),
              isError: z.boolean().optional(),
              error: z.string().optional()
            }),
            execute: wrapExecute(toolName, async (args: Record<string, unknown>) => {
              return this.callMcpTool(serverConfig.name, mcpTool.name, args);
            })
          });

          tools.push(sdkToolInstance as Tool);
        }

        console.log(`[mcp-registry] Discovered ${mcpTools.length} tools from ${serverConfig.name}`);
      } catch (err) {
        console.error(`[mcp-registry] Failed to connect to MCP server ${serverConfig.name}: ${err instanceof Error ? err.message : String(err)}`);
        const failedClient = this.clients.get(serverConfig.name);
        this.clients.delete(serverConfig.name);
        if (failedClient) { try { await failedClient.close(); } catch { /* ignore */ } }
      }
    }

    this.discoveredTools = tools;
    return tools;
  }

  private async discoverServerTools(client: McpStdioClient): Promise<McpTool[]> {
    await client.connect();
    return client.listTools();
  }

  private async callMcpTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult & { error?: string }> {
    const client = this.clients.get(serverName);
    if (!client) {
      return { content: [], isError: true, error: `MCP server ${serverName} not found` };
    }

    if (!client.isConnected) {
      await client.connect();
    }

    return client.callTool(toolName, args);
  }

  async closeAll(): Promise<void> {
    for (const [, client] of this.clients) {
      await client.close();
    }
    this.clients.clear();
  }

  getDiscoveredTools(): Tool[] {
    return this.discoveredTools;
  }
}
