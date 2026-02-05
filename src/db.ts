import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  NewMessage,
  MessageAttachment,
  ScheduledTask,
  TaskRunLog,
  BackgroundJob,
  BackgroundJobRunLog,
  BackgroundJobEvent,
  BackgroundJobStatus,
  QueuedMessage
} from './types.js';
import { STORE_DIR } from './config.js';
import { generateId } from './id.js';

let db: Database.Database;
let dbInitialized = false;

export function closeDatabase(): void {
  if (db && dbInitialized) {
    db.close();
    dbInitialized = false;
  }
}

export function initDatabase(): void {
  if (dbInitialized) return;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  dbInitialized = true;
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      timezone TEXT,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      state_json TEXT,
      retry_count INTEGER DEFAULT 0,
      last_error TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      context_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      timeout_ms INTEGER,
      max_tool_steps INTEGER,
      tool_policy_json TEXT,
      model_override TEXT,
      priority INTEGER DEFAULT 0,
      tags TEXT,
      parent_trace_id TEXT,
      parent_message_id TEXT,
      result_summary TEXT,
      output_path TEXT,
      output_truncated INTEGER DEFAULT 0,
      last_error TEXT,
      lease_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_background_jobs_group ON background_jobs(group_folder, created_at);

    CREATE TABLE IF NOT EXISTS background_job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result_summary TEXT,
      error TEXT,
      FOREIGN KEY (job_id) REFERENCES background_jobs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_background_job_runs ON background_job_runs(job_id, run_at);

    CREATE TABLE IF NOT EXISTS background_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT,
      FOREIGN KEY (job_id) REFERENCES background_jobs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_background_job_events ON background_job_events(job_id, created_at);

    CREATE TABLE IF NOT EXISTS chat_state (
      chat_jid TEXT PRIMARY KEY,
      last_agent_timestamp TEXT,
      last_agent_message_id TEXT
    );

    CREATE TABLE IF NOT EXISTS group_sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT,
      chat_jid TEXT,
      group_folder TEXT,
      user_id TEXT,
      tool_name TEXT NOT NULL,
      ok INTEGER NOT NULL,
      duration_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_audit_trace ON tool_audit(trace_id);
    CREATE INDEX IF NOT EXISTS idx_tool_audit_group ON tool_audit(group_folder, created_at);

    CREATE TABLE IF NOT EXISTS user_feedback (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      message_id TEXT,
      chat_jid TEXT,
      feedback_type TEXT NOT NULL,
      user_id TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_trace ON user_feedback(trace_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_chat ON user_feedback(chat_jid, created_at);

    CREATE TABLE IF NOT EXISTS message_traces (
      message_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_message_traces ON message_traces(trace_id);

    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      is_group INTEGER NOT NULL DEFAULT 0,
      chat_type TEXT NOT NULL DEFAULT 'private',
      message_thread_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mq_chat_status ON message_queue(chat_jid, status);
  `);

  // Add columns if they don't exist (migrations for existing DBs).
  // Only suppress "duplicate column" errors; re-throw anything else.
  const addColumnIfMissing = (sql: string) => {
    try {
      db.exec(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column')) throw err;
    }
  };

  addColumnIfMissing(`ALTER TABLE messages ADD COLUMN sender_name TEXT`);
  addColumnIfMissing(`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`);
  addColumnIfMissing(`ALTER TABLE scheduled_tasks ADD COLUMN state_json TEXT`);
  addColumnIfMissing(`ALTER TABLE scheduled_tasks ADD COLUMN retry_count INTEGER DEFAULT 0`);
  addColumnIfMissing(`ALTER TABLE scheduled_tasks ADD COLUMN last_error TEXT`);
  addColumnIfMissing(`ALTER TABLE tool_audit ADD COLUMN user_id TEXT`);
  addColumnIfMissing(`ALTER TABLE scheduled_tasks ADD COLUMN running_since TEXT`);
  addColumnIfMissing(`ALTER TABLE scheduled_tasks ADD COLUMN timezone TEXT`);
  addColumnIfMissing(`ALTER TABLE message_queue ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`);
  addColumnIfMissing(`ALTER TABLE messages ADD COLUMN attachments_json TEXT`);
}

/**
 * Store a message with full content (generic version).
 * Works with any messaging platform.
 */
export function storeMessage(
  msgId: string,
  chatId: string,
  senderId: string,
  senderName: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
  attachments?: MessageAttachment[]
): void {
  const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;
  db.prepare(`INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, attachments_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(msgId, chatId, senderId, senderName, content, timestamp, isFromMe ? 1 : 0, attachmentsJson);
}

export function upsertChat(params: { chatId: string; name?: string | null; lastMessageTime?: string | null }): void {
  const name = params.name?.trim() || null;
  const lastMessageTime = params.lastMessageTime ?? null;

  db.prepare(`INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`)
    .run(params.chatId, name, lastMessageTime);

  db.prepare(`
    UPDATE chats
    SET
      name = COALESCE(?, name),
      last_message_time = CASE
        WHEN ? IS NULL THEN last_message_time
        WHEN last_message_time IS NULL OR last_message_time < ? THEN ?
        ELSE last_message_time
      END
    WHERE jid = ?
  `).run(name, lastMessageTime, lastMessageTime, lastMessageTime, params.chatId);
}

export function getMessagesSinceCursor(
  chatJid: string,
  sinceTimestamp: string | null,
  sinceMessageId: string | null
): NewMessage[] {
  const timestamp = sinceTimestamp || '1970-01-01T00:00:00.000Z';
  const messageId = sinceMessageId || '0';
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, attachments_json
    FROM messages
    WHERE chat_jid = ? AND is_from_me = 0 AND (
      timestamp > ? OR (timestamp = ? AND CAST(id AS INTEGER) > CAST(? AS INTEGER))
    )
    ORDER BY timestamp, CAST(id AS INTEGER)
  `;
  return db.prepare(sql).all(chatJid, timestamp, timestamp, messageId) as NewMessage[];
}

export interface ChatState {
  chat_jid: string;
  last_agent_timestamp: string | null;
  last_agent_message_id: string | null;
}

export function getChatState(chatJid: string): ChatState | null {
  const row = db.prepare(`
    SELECT chat_jid, last_agent_timestamp, last_agent_message_id
    FROM chat_state
    WHERE chat_jid = ?
  `).get(chatJid) as ChatState | undefined;
  return row || null;
}

export function updateChatState(chatJid: string, timestamp: string, messageId: string): void {
  db.prepare(`
    INSERT INTO chat_state (chat_jid, last_agent_timestamp, last_agent_message_id)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_jid) DO UPDATE SET
      last_agent_timestamp = excluded.last_agent_timestamp,
      last_agent_message_id = excluded.last_agent_message_id
  `).run(chatJid, timestamp, messageId);
}

export interface GroupSession {
  group_folder: string;
  session_id: string;
  updated_at: string;
}

export function getAllGroupSessions(): GroupSession[] {
  return db.prepare(`SELECT group_folder, session_id, updated_at FROM group_sessions`).all() as GroupSession[];
}

export function setGroupSession(groupFolder: string, sessionId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO group_sessions (group_folder, session_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(group_folder) DO UPDATE SET
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
  `).run(groupFolder, sessionId, now);
}

export function deleteGroupSession(groupFolder: string): void {
  db.prepare(`DELETE FROM group_sessions WHERE group_folder = ?`).run(groupFolder);
}

export function pauseTasksForGroup(groupFolder: string): number {
  const info = db.prepare(`
    UPDATE scheduled_tasks
    SET status = 'paused'
    WHERE group_folder = ? AND status != 'completed'
  `).run(groupFolder);
  return info.changes;
}

export function createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void {
  db.prepare(`
    INSERT INTO scheduled_tasks (
      id, group_folder, chat_jid, prompt, schedule_type, schedule_value, timezone, context_mode,
      next_run, status, created_at, state_json, retry_count, last_error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.timezone ?? null,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.state_json ?? null,
    task.retry_count ?? 0,
    task.last_error ?? null
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
}

export function getAllTasks(): ScheduledTask[] {
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[];
}

export function updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'timezone' | 'next_run' | 'status' | 'state_json' | 'retry_count' | 'last_error' | 'context_mode' | 'running_since'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
  if (updates.schedule_type !== undefined) { fields.push('schedule_type = ?'); values.push(updates.schedule_type); }
  if (updates.schedule_value !== undefined) { fields.push('schedule_value = ?'); values.push(updates.schedule_value); }
  if (updates.timezone !== undefined) { fields.push('timezone = ?'); values.push(updates.timezone); }
  if (updates.next_run !== undefined) { fields.push('next_run = ?'); values.push(updates.next_run); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.context_mode !== undefined) { fields.push('context_mode = ?'); values.push(updates.context_mode); }
  if (updates.state_json !== undefined) { fields.push('state_json = ?'); values.push(updates.state_json); }
  if (updates.retry_count !== undefined) { fields.push('retry_count = ?'); values.push(updates.retry_count); }
  if (updates.last_error !== undefined) { fields.push('last_error = ?'); values.push(updates.last_error); }
  if (updates.running_since !== undefined) { fields.push('running_since = ?'); values.push(updates.running_since); }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTask(id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  })();
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `).all(now) as ScheduledTask[];
}

export function claimDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  const staleThreshold = new Date(Date.now() - 900_000).toISOString();
  const claim = db.transaction(() => {
    const tasks = db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
        AND (running_since IS NULL OR running_since < ?)
      ORDER BY next_run
    `).all(now, staleThreshold) as ScheduledTask[];

    for (const task of tasks) {
      db.prepare(`UPDATE scheduled_tasks SET running_since = ? WHERE id = ?`).run(now, task.id);
    }
    return tasks;
  });
  return claim();
}

const VALID_TASK_TRANSITIONS: Record<string, string[]> = {
  active: ['paused', 'completed', 'deleted'],
  paused: ['active', 'deleted'],
  completed: ['active', 'deleted'],
  deleted: [],
};

export function transitionTaskStatus(id: string, newStatus: string): boolean {
  const task = db.prepare('SELECT status FROM scheduled_tasks WHERE id = ?').get(id) as { status: string } | undefined;
  if (!task) return false;
  const allowed = VALID_TASK_TRANSITIONS[task.status] || [];
  if (!allowed.includes(newStatus)) return false;
  db.prepare('UPDATE scheduled_tasks SET status = ?, running_since = NULL WHERE id = ?')
    .run(newStatus, id);
  return true;
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
  lastError: string | null,
  retryCount: number
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, last_error = ?, retry_count = ?,
        status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END,
        running_since = NULL
    WHERE id = ?
  `).run(nextRun, now, lastResult, lastError, retryCount, nextRun, id);
}

export function updateTaskRunStatsOnly(
  id: string,
  lastResult: string,
  lastError: string | null
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE scheduled_tasks
    SET last_run = ?, last_result = ?, last_error = ?
    WHERE id = ?
  `).run(now, lastResult, lastError, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error);
}

export function createBackgroundJob(job: {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  context_mode: 'group' | 'isolated';
  status?: BackgroundJobStatus;
  created_at?: string;
  updated_at?: string;
  timeout_ms?: number | null;
  max_tool_steps?: number | null;
  tool_policy_json?: string | null;
  model_override?: string | null;
  priority?: number | null;
  tags?: string | null;
  parent_trace_id?: string | null;
  parent_message_id?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO background_jobs (
      id, group_folder, chat_jid, prompt, context_mode, status, created_at, updated_at,
      started_at, finished_at, timeout_ms, max_tool_steps, tool_policy_json, model_override,
      priority, tags, parent_trace_id, parent_message_id, result_summary, output_path,
      output_truncated, last_error, lease_expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id,
    job.group_folder,
    job.chat_jid,
    job.prompt,
    job.context_mode,
    job.status || 'queued',
    job.created_at || now,
    job.updated_at || now,
    null,
    null,
    job.timeout_ms ?? null,
    job.max_tool_steps ?? null,
    job.tool_policy_json ?? null,
    job.model_override ?? null,
    job.priority ?? 0,
    job.tags ?? null,
    job.parent_trace_id ?? null,
    job.parent_message_id ?? null,
    null,
    null,
    0,
    null,
    null
  );
}

export function getBackgroundJobById(id: string): BackgroundJob | undefined {
  return db.prepare('SELECT * FROM background_jobs WHERE id = ?').get(id) as BackgroundJob | undefined;
}

export function getBackgroundJobQueuePosition(params: { jobId: string; groupFolder?: string }): { position: number; total: number } | null {
  const job = getBackgroundJobById(params.jobId);
  if (!job) return null;
  const groupClause = params.groupFolder ? 'AND group_folder = ?' : '';
  const groupArgs = params.groupFolder ? [params.groupFolder] : [];
  const aheadRow = db.prepare(`
    SELECT COUNT(*) as count
    FROM background_jobs
    WHERE status = 'queued'
      ${groupClause}
      AND (priority > ? OR (priority = ? AND created_at < ?))
  `).get(...groupArgs, job.priority ?? 0, job.priority ?? 0, job.created_at) as { count: number };
  const totalRow = db.prepare(`
    SELECT COUNT(*) as count
    FROM background_jobs
    WHERE status = 'queued'
    ${groupClause}
  `).get(...groupArgs) as { count: number };
  const ahead = aheadRow?.count || 0;
  const total = totalRow?.count || 0;
  return { position: ahead + 1, total };
}

export function getBackgroundJobQueueDepth(params: { groupFolder?: string; includeRunning?: boolean } = {}): number {
  const statuses = params.includeRunning ? ['queued', 'running'] : ['queued'];
  const placeholders = statuses.map(() => '?').join(', ');
  const groupClause = params.groupFolder ? 'AND group_folder = ?' : '';
  const args = params.groupFolder ? [...statuses, params.groupFolder] : statuses;
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM background_jobs
    WHERE status IN (${placeholders})
    ${groupClause}
  `).get(...args) as { count: number };
  return row?.count || 0;
}

export function listBackgroundJobs(params: { groupFolder?: string; status?: BackgroundJobStatus; limit?: number } = {}): BackgroundJob[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (params.groupFolder) {
    clauses.push('group_folder = ?');
    values.push(params.groupFolder);
  }
  if (params.status) {
    clauses.push('status = ?');
    values.push(params.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = params.limit && params.limit > 0 ? `LIMIT ${Math.floor(params.limit)}` : '';
  return db.prepare(`
    SELECT * FROM background_jobs
    ${where}
    ORDER BY created_at DESC
    ${limit}
  `).all(...values) as BackgroundJob[];
}

export function updateBackgroundJob(id: string, updates: Partial<Pick<BackgroundJob,
  'status' | 'updated_at' | 'started_at' | 'finished_at' | 'timeout_ms' | 'max_tool_steps' |
  'tool_policy_json' | 'model_override' | 'priority' | 'tags' | 'parent_trace_id' |
  'parent_message_id' | 'result_summary' | 'output_path' | 'output_truncated' |
  'last_error' | 'lease_expires_at'
>>): void {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];

  const setIfDefined = (field: keyof typeof updates, column: string) => {
    if (updates[field] !== undefined) {
      fields.push(`${column} = ?`);
      values.push(updates[field] as string | number | null);
    }
  };

  setIfDefined('status', 'status');
  setIfDefined('updated_at', 'updated_at');
  setIfDefined('started_at', 'started_at');
  setIfDefined('finished_at', 'finished_at');
  setIfDefined('timeout_ms', 'timeout_ms');
  setIfDefined('max_tool_steps', 'max_tool_steps');
  setIfDefined('tool_policy_json', 'tool_policy_json');
  setIfDefined('model_override', 'model_override');
  setIfDefined('priority', 'priority');
  setIfDefined('tags', 'tags');
  setIfDefined('parent_trace_id', 'parent_trace_id');
  setIfDefined('parent_message_id', 'parent_message_id');
  setIfDefined('result_summary', 'result_summary');
  setIfDefined('output_path', 'output_path');
  setIfDefined('output_truncated', 'output_truncated');
  setIfDefined('last_error', 'last_error');
  setIfDefined('lease_expires_at', 'lease_expires_at');

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE background_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function claimNextBackgroundJob(params: { now: string; defaultLeaseMs: number }): BackgroundJob | null {
  const select = db.prepare(`
    SELECT * FROM background_jobs
    WHERE status = 'queued'
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `);
  const update = db.prepare(`
    UPDATE background_jobs
    SET status = 'running', started_at = ?, updated_at = ?, lease_expires_at = ?
    WHERE id = ? AND status = 'queued'
  `);

  const txn = db.transaction(() => {
    const job = select.get() as BackgroundJob | undefined;
    if (!job) return null;
    const leaseMs = typeof job.timeout_ms === 'number' && job.timeout_ms > 0
      ? job.timeout_ms
      : params.defaultLeaseMs;
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const info = update.run(params.now, params.now, leaseExpiresAt, job.id);
    if (info.changes === 0) return null;
    return {
      ...job,
      status: 'running',
      started_at: params.now,
      updated_at: params.now,
      lease_expires_at: leaseExpiresAt
    } as BackgroundJob;
  });

  return txn();
}

export function failExpiredBackgroundJobs(nowIso: string): number {
  const info = db.prepare(`
    UPDATE background_jobs
    SET status = 'timed_out',
        finished_at = ?,
        updated_at = ?,
        last_error = COALESCE(last_error, 'Job lease expired')
    WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).run(nowIso, nowIso, nowIso);
  return info.changes;
}

export function resetStalledBackgroundJobs(): number {
  const now = new Date().toISOString();
  const info = db.prepare(`
    UPDATE background_jobs
    SET status = 'queued',
        updated_at = ?,
        started_at = NULL,
        lease_expires_at = NULL,
        last_error = CASE
          WHEN last_error IS NULL OR last_error = '' THEN 'Recovered after restart'
          ELSE last_error || '; recovered after restart'
        END
    WHERE status = 'running'
  `).run(now);
  return info.changes;
}

export function logBackgroundJobRun(log: BackgroundJobRunLog): void {
  db.prepare(`
    INSERT INTO background_job_runs (job_id, run_at, duration_ms, status, result_summary, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(log.job_id, log.run_at, log.duration_ms, log.status, log.result_summary, log.error);
}

export function logBackgroundJobEvent(event: BackgroundJobEvent): void {
  db.prepare(`
    INSERT INTO background_job_events (job_id, created_at, level, message, data_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(event.job_id, event.created_at, event.level, event.message, event.data_json ?? null);
}

export function logToolCalls(params: {
  traceId: string;
  chatJid: string;
  groupFolder: string;
  userId?: string | null;
  toolCalls: Array<{ name: string; ok: boolean; duration_ms?: number; error?: string; output_bytes?: number; output_truncated?: boolean }>;
  source: string;
}): void {
  if (!params.toolCalls || params.toolCalls.length === 0) return;
  if (!dbInitialized) {
    initDatabase();
  }
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO tool_audit (trace_id, chat_jid, group_folder, user_id, tool_name, ok, duration_ms, error, created_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const transaction = db.transaction((calls: typeof params.toolCalls) => {
    for (const call of calls) {
      stmt.run(
        params.traceId,
        params.chatJid,
        params.groupFolder,
        params.userId || null,
        call.name,
        call.ok ? 1 : 0,
        call.duration_ms ?? null,
        call.error ?? null,
        now,
        params.source
      );
    }
  });
  transaction(params.toolCalls);
}

export function getToolUsageCounts(params: {
  groupFolder: string;
  userId?: string | null;
  since: string;
}): Array<{ tool_name: string; count: number }> {
  if (!dbInitialized) {
    initDatabase();
  }
  const clauses = ['group_folder = ?', 'created_at >= ?'];
  const values: unknown[] = [params.groupFolder, params.since];
  if (params.userId) {
    clauses.push('user_id = ?');
    values.push(params.userId);
  }
  const rows = db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM tool_audit
    WHERE ${clauses.join(' AND ')}
    GROUP BY tool_name
  `).all(...values) as Array<{ tool_name: string; count: number }>;
  return rows;
}

export function getToolReliability(params: {
  groupFolder: string;
  limit?: number;
}): Array<{ tool_name: string; total: number; ok_count: number; avg_duration_ms: number | null }> {
  const limit = params.limit && params.limit > 0 ? params.limit : 200;
  const rows = db.prepare(`
    SELECT tool_name,
           COUNT(*) as total,
           SUM(ok) as ok_count,
           AVG(duration_ms) as avg_duration_ms
    FROM (
      SELECT tool_name, ok, duration_ms
      FROM tool_audit
      WHERE group_folder = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
    GROUP BY tool_name
  `).all(params.groupFolder, limit) as Array<{ tool_name: string; total: number; ok_count: number; avg_duration_ms: number | null }>;
  return rows;
}

// User feedback functions

export interface UserFeedback {
  id: string;
  trace_id: string;
  message_id?: string;
  chat_jid?: string;
  feedback_type: 'positive' | 'negative';
  user_id?: string;
  reason?: string;
  created_at: string;
}

/**
 * Link a message to its trace ID for feedback lookup
 */
export function linkMessageToTrace(messageId: string, chatJid: string, traceId: string): void {
  if (!dbInitialized) initDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO message_traces (message_id, chat_jid, trace_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(messageId, chatJid, traceId, now);
}

/**
 * Get trace ID for a message
 */
export function getTraceIdForMessage(messageId: string, chatJid: string): string | null {
  if (!dbInitialized) initDatabase();
  const row = db.prepare(`
    SELECT trace_id FROM message_traces
    WHERE message_id = ? AND chat_jid = ?
  `).get(messageId, chatJid) as { trace_id: string } | undefined;
  return row?.trace_id ?? null;
}

/**
 * Record user feedback (thumbs up/down reaction)
 */
export function recordUserFeedback(feedback: Omit<UserFeedback, 'id' | 'created_at'>): string {
  if (!dbInitialized) initDatabase();
  const id = generateId('fb');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_feedback (id, trace_id, message_id, chat_jid, feedback_type, user_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    feedback.trace_id,
    feedback.message_id ?? null,
    feedback.chat_jid ?? null,
    feedback.feedback_type,
    feedback.user_id ?? null,
    feedback.reason ?? null,
    now
  );
  return id;
}

/**
 * Get feedback for a trace
 */
export function getFeedbackForTrace(traceId: string): UserFeedback | null {
  if (!dbInitialized) initDatabase();
  const row = db.prepare(`
    SELECT * FROM user_feedback
    WHERE trace_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(traceId) as UserFeedback | undefined;
  return row ?? null;
}

/**
 * Get recent feedback for analytics
 */
export function getRecentFeedback(params: {
  chatJid?: string;
  limit?: number;
  since?: string;
}): UserFeedback[] {
  if (!dbInitialized) initDatabase();
  const limit = params.limit || 100;
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (params.chatJid) {
    clauses.push('chat_jid = ?');
    values.push(params.chatJid);
  }
  if (params.since) {
    clauses.push('created_at >= ?');
    values.push(params.since);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `
    SELECT * FROM user_feedback
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...values, limit) as UserFeedback[];
}

// ── Message Queue Functions ──────────────────────────────────────────

export function enqueueMessageItem(item: {
  chat_jid: string;
  message_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_group: boolean;
  chat_type: string;
  message_thread_id?: number;
}): number {
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO message_queue (chat_jid, message_id, sender_id, sender_name, content, timestamp, is_group, chat_type, message_thread_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    item.chat_jid,
    item.message_id,
    item.sender_id,
    item.sender_name,
    item.content,
    item.timestamp,
    item.is_group ? 1 : 0,
    item.chat_type,
    item.message_thread_id ?? null,
    now
  );
  return Number(info.lastInsertRowid);
}

export function claimBatchForChat(chatJid: string, windowMs: number, maxBatchSize: number = 50): QueuedMessage[] {
  const select = db.prepare(`
    SELECT * FROM message_queue
    WHERE chat_jid = ? AND status = 'pending'
    ORDER BY id ASC
    LIMIT 1
  `);
  const selectWindow = db.prepare(`
    SELECT * FROM message_queue
    WHERE chat_jid = ? AND status = 'pending' AND created_at <= ?
    ORDER BY id ASC
    LIMIT ?
  `);
  const update = db.prepare(`
    UPDATE message_queue
    SET status = 'processing', started_at = ?, attempt_count = COALESCE(attempt_count, 0) + 1
    WHERE id = ?
  `);

  const txn = db.transaction(() => {
    const oldest = select.get(chatJid) as QueuedMessage | undefined;
    if (!oldest) return [];
    const cutoff = new Date(new Date(oldest.created_at).getTime() + windowMs).toISOString();
    const batch = selectWindow.all(chatJid, cutoff, maxBatchSize) as QueuedMessage[];
    const now = new Date().toISOString();
    for (const row of batch) {
      update.run(now, row.id);
    }
    return batch;
  });

  return txn();
}

export function completeQueuedMessages(ids: number[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE message_queue SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'processing'`);
  const txn = db.transaction((idList: number[]) => {
    for (const id of idList) {
      stmt.run(now, id);
    }
  });
  txn(ids);
}

export function failQueuedMessages(ids: number[], error: string): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE message_queue SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND status = 'processing'`);
  const txn = db.transaction((idList: number[]) => {
    for (const id of idList) {
      stmt.run(now, error, id);
    }
  });
  txn(ids);
}

export function requeueQueuedMessages(ids: number[], error: string): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(`
    UPDATE message_queue
    SET status = 'pending',
        started_at = NULL,
        completed_at = NULL,
        error = ?
    WHERE id = ? AND status = 'processing'
  `);
  const txn = db.transaction((idList: number[]) => {
    for (const id of idList) {
      stmt.run(error, id);
    }
  });
  txn(ids);
}

export function getChatsWithPendingMessages(): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT chat_jid FROM message_queue WHERE status = 'pending'
  `).all() as Array<{ chat_jid: string }>;
  return rows.map(r => r.chat_jid);
}

export function resetStalledMessages(olderThanMs: number = 300_000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare(`
    UPDATE message_queue SET status = 'pending', started_at = NULL
    WHERE status = 'processing' AND started_at < ?
  `).run(cutoff);
  return info.changes;
}

export function cleanupCompletedMessages(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare(`
    DELETE FROM message_queue
    WHERE status IN ('completed', 'failed') AND created_at < ?
  `).run(cutoff);
  return info.changes;
}

export function cleanupCompletedBackgroundJobs(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return db.transaction(() => {
    const jobIds = db.prepare(`
      SELECT id FROM background_jobs
      WHERE status IN ('succeeded', 'failed', 'canceled', 'timed_out')
        AND updated_at < ?
    `).all(cutoff) as { id: string }[];
    if (jobIds.length === 0) return 0;
    const ids = jobIds.map(j => j.id);
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM background_job_runs WHERE job_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM background_job_events WHERE job_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM background_jobs WHERE id IN (${ph})`).run(...ids);
    return ids.length;
  })();
}

export function cleanupOldTaskRunLogs(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare('DELETE FROM task_run_logs WHERE run_at < ?').run(cutoff);
  return info.changes;
}

export function cleanupOldToolAudit(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare('DELETE FROM tool_audit WHERE created_at < ?').run(cutoff);
  return info.changes;
}

export function cleanupOldMessageTraces(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare('DELETE FROM message_traces WHERE created_at < ?').run(cutoff);
  return info.changes;
}

export function cleanupOldUserFeedback(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare('DELETE FROM user_feedback WHERE created_at < ?').run(cutoff);
  return info.changes;
}

export function getPendingMessageCount(): number {
  try {
    const row = db.prepare("SELECT COUNT(*) as count FROM message_queue WHERE status = 'pending'").get() as { count: number };
    return row.count;
  } catch { return 0; }
}
