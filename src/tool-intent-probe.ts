import { loadRuntimeConfig } from './runtime-config.js';
import { logger } from './logger.js';

export type ToolIntentResult = {
  needsTools: boolean;
  latencyMs: number;
  error?: string;
};

const SYSTEM_PROMPT =
  'You are a routing classifier. Given a user message, determine if it requires tool usage ' +
  '(web search, downloading files, sending photos/files/media, creating charts or documents, ' +
  'code execution, file operations, scheduling) or can be answered with a plain text response.\n' +
  'Reply with ONLY one word: TOOLS or CHAT';

/**
 * Quick nano-model probe to check if a short message needs tool orchestration.
 * Used to upgrade "fast" routing to "standard" when tool use is likely.
 */
export async function probeToolIntent(message: string): Promise<ToolIntentResult> {
  const runtime = loadRuntimeConfig();
  const config = runtime.host.routing.toolIntentProbe;
  if (!config.enabled) {
    return { needsTools: false, latencyMs: 0 };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { needsTools: false, latencyMs: 0, error: 'OPENROUTER_API_KEY not set' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message }
        ],
        max_tokens: config.maxOutputTokens,
        temperature: 0
      }),
      signal: controller.signal
    });

    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { needsTools: false, latencyMs, error: `HTTP ${response.status}` };
    }

    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = (json.choices?.[0]?.message?.content ?? '').trim().toUpperCase();
    const needsTools = text.startsWith('TOOL');

    logger.debug({ message: message.slice(0, 100), result: text, needsTools, latencyMs }, 'Tool intent probe');
    return { needsTools, latencyMs };
  } catch (err) {
    return {
      needsTools: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    clearTimeout(timeout);
  }
}
