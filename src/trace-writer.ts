import fs from 'fs';
import path from 'path';
import { TRACE_DIR, TRACE_SAMPLE_RATE } from './config.js';

export type TraceRecord = {
  trace_id: string;
  timestamp: string;
  created_at: number;
  chat_id: string;
  group_folder: string;
  user_id?: string;
  input_text: string;
  output_text: string | null;
  model_id: string;
  prompt_pack_versions?: Record<string, string>;
  memory_summary?: string;
  memory_facts?: string[];
  memory_recall?: string[];
  session_recall?: string[];
  tool_calls?: Array<{
    name: string;
    args?: unknown;
    ok: boolean;
    duration_ms?: number;
    error?: string;
    output_bytes?: number;
    output_truncated?: boolean;
  }>;
  latency_ms?: number;
  tokens_prompt?: number;
  tokens_completion?: number;
  cost_prompt_usd?: number;
  cost_completion_usd?: number;
  cost_total_usd?: number;
  memory_recall_count?: number;
  session_recall_count?: number;
  memory_items_upserted?: number;
  memory_items_extracted?: number;
  error_code?: string;
  source?: string;
};

function shouldSample(rate: number): boolean {
  if (!Number.isFinite(rate) || rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}

function getTraceFilePath(timestamp: Date): string {
  const date = timestamp.toISOString().slice(0, 10);
  return path.join(TRACE_DIR, `trace-${date}.jsonl`);
}

export function writeTrace(trace: TraceRecord): void {
  if (!shouldSample(TRACE_SAMPLE_RATE)) return;
  try {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
    const line = JSON.stringify(trace) + '\n';
    fs.appendFileSync(getTraceFilePath(new Date(trace.timestamp)), line, 'utf-8');
  } catch {
    // Trace failures should never crash the agent
  }
}
