import http from 'http';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

const messagesTotal = new Counter({
  name: 'dotclaw_messages_total',
  help: 'Total messages processed',
  labelNames: ['source']
});

const errorsTotal = new Counter({
  name: 'dotclaw_errors_total',
  help: 'Total errors',
  labelNames: ['type']
});

const toolCallsTotal = new Counter({
  name: 'dotclaw_tool_calls_total',
  help: 'Total tool calls',
  labelNames: ['tool', 'ok']
});

const taskRunsTotal = new Counter({
  name: 'dotclaw_task_runs_total',
  help: 'Total scheduled task runs',
  labelNames: ['status']
});

const tokensPromptTotal = new Counter({
  name: 'dotclaw_tokens_prompt_total',
  help: 'Total prompt tokens (estimated)',
  labelNames: ['model', 'source']
});

const tokensCompletionTotal = new Counter({
  name: 'dotclaw_tokens_completion_total',
  help: 'Total completion tokens (estimated)',
  labelNames: ['model', 'source']
});

const costTotal = new Counter({
  name: 'dotclaw_cost_usd_total',
  help: 'Total estimated cost in USD',
  labelNames: ['model', 'source']
});

const memoryRecallTotal = new Counter({
  name: 'dotclaw_memory_recall_total',
  help: 'Total memory recall items added to context',
  labelNames: ['source']
});

const memoryUpsertTotal = new Counter({
  name: 'dotclaw_memory_upserts_total',
  help: 'Total memory items upserted',
  labelNames: ['source']
});

const memoryExtractTotal = new Counter({
  name: 'dotclaw_memory_extract_total',
  help: 'Total memory items extracted',
  labelNames: ['source']
});

const responseLatency = new Histogram({
  name: 'dotclaw_response_latency_ms',
  help: 'Agent response latency in ms',
  buckets: [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]
});

registry.registerMetric(messagesTotal);
registry.registerMetric(errorsTotal);
registry.registerMetric(toolCallsTotal);
registry.registerMetric(taskRunsTotal);
registry.registerMetric(tokensPromptTotal);
registry.registerMetric(tokensCompletionTotal);
registry.registerMetric(costTotal);
registry.registerMetric(memoryRecallTotal);
registry.registerMetric(memoryUpsertTotal);
registry.registerMetric(memoryExtractTotal);
registry.registerMetric(responseLatency);

export function recordMessage(source: 'telegram' | 'scheduler'): void {
  messagesTotal.inc({ source });
}

export function recordError(type: string): void {
  errorsTotal.inc({ type });
}

export function recordToolCall(tool: string, ok: boolean): void {
  toolCallsTotal.inc({ tool, ok: ok ? 'true' : 'false' });
}

export function recordTaskRun(status: 'success' | 'error'): void {
  taskRunsTotal.inc({ status });
}

export function recordLatency(ms: number): void {
  if (Number.isFinite(ms)) responseLatency.observe(ms);
}

export function recordTokenUsage(model: string, source: 'telegram' | 'scheduler', promptTokens: number, completionTokens: number): void {
  if (Number.isFinite(promptTokens)) tokensPromptTotal.inc({ model, source }, promptTokens);
  if (Number.isFinite(completionTokens)) tokensCompletionTotal.inc({ model, source }, completionTokens);
}

export function recordCost(model: string, source: 'telegram' | 'scheduler', costUsd: number): void {
  if (Number.isFinite(costUsd)) costTotal.inc({ model, source }, costUsd);
}

export function recordMemoryRecall(source: 'telegram' | 'scheduler', count: number): void {
  if (Number.isFinite(count)) memoryRecallTotal.inc({ source }, count);
}

export function recordMemoryUpsert(source: 'telegram' | 'scheduler', count: number): void {
  if (Number.isFinite(count)) memoryUpsertTotal.inc({ source }, count);
}

export function recordMemoryExtract(source: 'telegram' | 'scheduler', count: number): void {
  if (Number.isFinite(count)) memoryExtractTotal.inc({ source }, count);
}

export function startMetricsServer(): void {
  const port = parseInt(process.env.DOTCLAW_METRICS_PORT || '3001', 10);
  const server = http.createServer(async (_req, res) => {
    try {
      const metrics = await registry.metrics();
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(metrics);
    } catch {
      res.writeHead(500);
      res.end('metrics error');
    }
  });
  server.listen(port, () => {
    console.log(`Metrics server listening on :${port}`);
  });
}
