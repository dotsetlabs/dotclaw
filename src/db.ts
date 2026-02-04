import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { NewMessage, ScheduledTask, TaskRunLog } from './types.js';
import { STORE_DIR } from './config.js';

let db: Database.Database;
let dbInitialized = false;

export function initDatabase(): void {
  if (dbInitialized) return;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  dbInitialized = true;
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
  `);

  // Add sender_name column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN sender_name TEXT`);
  } catch { /* column already exists */ }

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`);
  } catch { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN state_json TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN retry_count INTEGER DEFAULT 0`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN last_error TEXT`);
  } catch { /* column already exists */ }

  // Add user_id column to tool_audit if it doesn't exist
  try {
    db.exec(`ALTER TABLE tool_audit ADD COLUMN user_id TEXT`);
  } catch { /* column already exists */ }
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(chatJid: string, timestamp: string, name?: string): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(`
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(`
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(`
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db.prepare(`
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `).all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db.prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`).get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`).run(now);
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
  isFromMe: boolean
): void {
  db.prepare(`INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(msgId, chatId, senderId, senderName, content, timestamp, isFromMe ? 1 : 0);
}

export function getNewMessages(jids: string[], lastTimestamp: string): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');

  // Filter by is_from_me - bot's messages are stored with is_from_me=1
  // We only want messages from users (is_from_me=0)
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders}) AND is_from_me = 0
    ORDER BY timestamp
  `;
  const params = [lastTimestamp, ...jids];

  const rows = db.prepare(sql).all(...params) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(chatJid: string, sinceTimestamp: string): NewMessage[] {
  // Filter by is_from_me - bot's messages are stored with is_from_me=1
  // We only want messages from users (is_from_me=0)
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND is_from_me = 0
    ORDER BY timestamp
  `;
  const params = [chatJid, sinceTimestamp];

  return db.prepare(sql).all(...params) as NewMessage[];
}

export function getMessagesSinceCursor(
  chatJid: string,
  sinceTimestamp: string | null,
  sinceMessageId: string | null
): NewMessage[] {
  const timestamp = sinceTimestamp || '1970-01-01T00:00:00.000Z';
  const messageId = sinceMessageId || '0';
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
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

export function getGroupSession(groupFolder: string): GroupSession | null {
  const row = db.prepare(`
    SELECT group_folder, session_id, updated_at
    FROM group_sessions
    WHERE group_folder = ?
  `).get(groupFolder) as GroupSession | undefined;
  return row || null;
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
      id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode,
      next_run, status, created_at, state_json, retry_count, last_error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
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

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC').all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[];
}

export function updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status' | 'state_json' | 'retry_count' | 'last_error' | 'context_mode'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
  if (updates.schedule_type !== undefined) { fields.push('schedule_type = ?'); values.push(updates.schedule_type); }
  if (updates.schedule_value !== undefined) { fields.push('schedule_value = ?'); values.push(updates.schedule_value); }
  if (updates.next_run !== undefined) { fields.push('next_run = ?'); values.push(updates.next_run); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.context_mode !== undefined) { fields.push('context_mode = ?'); values.push(updates.context_mode); }
  if (updates.state_json !== undefined) { fields.push('state_json = ?'); values.push(updates.state_json); }
  if (updates.retry_count !== undefined) { fields.push('retry_count = ?'); values.push(updates.retry_count); }
  if (updates.last_error !== undefined) { fields.push('last_error = ?'); values.push(updates.last_error); }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `).all(now) as ScheduledTask[];
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
        status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `).run(nextRun, now, lastResult, lastError, retryCount, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error);
}

export function getTaskRunLogs(taskId: string, limit = 10): TaskRunLog[] {
  return db.prepare(`
    SELECT task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE task_id = ?
    ORDER BY run_at DESC
    LIMIT ?
  `).all(taskId, limit) as TaskRunLog[];
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
