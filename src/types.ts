export interface AdditionalMount {
  hostPath: string;      // Absolute path on host (supports ~ for home)
  containerPath: string; // Path inside container (under /workspace/extra/)
  readonly?: boolean;    // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/dotclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;  // Falls back to container.timeoutMs (default: 900000 / 15 minutes)
  env?: Record<string, string>;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger?: string;
  added_at: string;
  containerConfig?: ContainerConfig;
}

export interface Session {
  [folder: string]: string;
}

export interface MessageAttachment {
  type: 'photo' | 'document' | 'voice' | 'video' | 'audio';
  provider_file_ref?: string;   // Opaque file reference (Telegram file_id, Discord URL)
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  local_path?: string;
  duration?: number;
  width?: number;
  height?: number;
  transcript?: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  attachments?: MessageAttachment[];
  attachments_json?: string | null;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  timezone?: string | null;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  state_json?: string | null;
  retry_count?: number | null;
  last_error?: string | null;
  running_since?: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface TokenEstimateConfig {
  tokens_per_char: number;
  tokens_per_message: number;
  tokens_per_request: number;
}

export interface QueuedMessage {
  id: number;
  chat_jid: string;
  message_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_group: number;
  chat_type: string;
  message_thread_id: number | null;
  status: string;
  created_at: string;
  attempt_count?: number | null;
}
