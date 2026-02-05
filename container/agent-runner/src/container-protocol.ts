export const OUTPUT_START_MARKER = '---DOTCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---DOTCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  isBackgroundTask?: boolean;
  isBackgroundJob?: boolean;
  taskId?: string;
  jobId?: string;
  userId?: string;
  userName?: string;
  maxToolSteps?: number;
  memoryRecall?: string[];
  userProfile?: string | null;
  memoryStats?: {
    total: number;
    user: number;
    group: number;
    global: number;
  };
  tokenEstimate?: {
    tokens_per_char: number;
    tokens_per_message: number;
    tokens_per_request: number;
  };
  toolReliability?: Array<{
    name: string;
    success_rate: number;
    count: number;
    avg_duration_ms: number | null;
  }>;
  behaviorConfig?: Record<string, unknown>;
  toolPolicy?: Record<string, unknown>;
  modelOverride?: string;
  modelContextTokens?: number;
  modelMaxOutputTokens?: number;
  modelTemperature?: number;
  timezone?: string;
  disablePlanner?: boolean;
  disableResponseValidation?: boolean;
  responseValidationMaxRetries?: number;
  disableMemoryExtraction?: boolean;
  attachments?: Array<{
    type: 'photo' | 'document' | 'voice' | 'video' | 'audio';
    path: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
    width?: number;
    height?: number;
  }>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  model?: string;
  prompt_pack_versions?: Record<string, string>;
  memory_summary?: string;
  memory_facts?: string[];
  tokens_prompt?: number;
  tokens_completion?: number;
  memory_recall_count?: number;
  session_recall_count?: number;
  memory_items_upserted?: number;
  memory_items_extracted?: number;
  timings?: {
    planner_ms?: number;
    response_validation_ms?: number;
    memory_extraction_ms?: number;
    tool_ms?: number;
  };
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
}
