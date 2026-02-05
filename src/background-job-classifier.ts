import { loadRuntimeConfig } from './runtime-config.js';
import type { NewMessage } from './types.js';

type ClassifierDecision = {
  background: boolean;
  confidence: number;
  reason?: string;
  estimated_minutes?: number;
};

export type BackgroundJobClassifierResult = {
  shouldBackground: boolean;
  confidence: number;
  reason?: string;
  latencyMs?: number;
  model?: string;
  error?: string;
};

const CLASSIFIER_SYSTEM_PROMPT = [
  'You are a routing classifier for DotClaw.',
  'Decide whether the user request should be run as a long-running background job.',
  'Return JSON only: {"background":true|false,"confidence":0-1,"reason":"...","estimated_minutes":number}.',
  'Background=true if the task is likely to take more than ~2 minutes or requires multi-step research/coding or many tool calls.',
  'Background=false for quick answers, short clarifications, or simple tasks.',
  'Keep reason short.'
].join('\n');

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return null;
}

function buildClassifierPayload(params: {
  lastMessage: NewMessage;
  recentMessages: NewMessage[];
  isGroup: boolean;
  chatType: string;
}): string {
  const recent = params.recentMessages.slice(-3).map(m => ({
    sender: m.sender_name,
    content: m.content
  }));
  const payload = {
    last_message: params.lastMessage.content,
    recent_messages: recent,
    is_group: params.isGroup,
    chat_type: params.chatType
  };
  return JSON.stringify(payload);
}

async function callClassifier(params: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
  input: string;
  siteUrl?: string;
  siteName?: string;
}): Promise<{ text: string; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  const startedAt = Date.now();
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.apiKey}`
    };
    if (params.siteUrl) headers['HTTP-Referer'] = params.siteUrl;
    if (params.siteName) headers['X-Title'] = params.siteName;

    const body = {
      model: params.model,
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: params.input }
      ],
      max_tokens: params.maxOutputTokens,
      temperature: params.temperature
    };

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const json = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    return { text, latencyMs };
  } finally {
    clearTimeout(timeout);
  }
}

export async function classifyBackgroundJob(params: {
  lastMessage: NewMessage;
  recentMessages: NewMessage[];
  isGroup: boolean;
  chatType: string;
}): Promise<BackgroundJobClassifierResult> {
  const runtime = loadRuntimeConfig();
  const classifierConfig = runtime.host.backgroundJobs.autoSpawn.classifier;
  if (!classifierConfig.enabled) {
    return { shouldBackground: false, confidence: 0 };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { shouldBackground: false, confidence: 0, error: 'OPENROUTER_API_KEY is not set' };
  }

  const input = buildClassifierPayload(params);
  const model = classifierConfig.model;

  try {
    const { text, latencyMs } = await callClassifier({
      apiKey,
      model,
      timeoutMs: classifierConfig.timeoutMs,
      maxOutputTokens: classifierConfig.maxOutputTokens,
      temperature: classifierConfig.temperature,
      input,
      siteUrl: runtime.agent.openrouter.siteUrl || undefined,
      siteName: runtime.agent.openrouter.siteName || undefined
    });

    const jsonText = extractJson(text);
    if (!jsonText) {
      return { shouldBackground: false, confidence: 0, latencyMs, model, error: 'Classifier returned no JSON' };
    }

    const parsed = JSON.parse(jsonText) as ClassifierDecision;
    const confidence = Number.isFinite(parsed.confidence) ? Number(parsed.confidence) : 0;
    const shouldBackground = parsed.background === true && confidence >= classifierConfig.confidenceThreshold;
    return {
      shouldBackground,
      confidence,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      latencyMs,
      model
    };
  } catch (err) {
    return {
      shouldBackground: false,
      confidence: 0,
      error: err instanceof Error ? err.message : String(err),
      model
    };
  }
}
