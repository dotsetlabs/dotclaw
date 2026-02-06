/**
 * SQLite-backed workflow state persistence.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { STORE_DIR } from './config.js';

export interface WorkflowRun {
  id: string;
  workflow_name: string;
  group_folder: string;
  chat_jid: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled';
  current_step: string | null;
  state_json: string | null;
  params_json: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface WorkflowStepResult {
  id: number;
  run_id: string;
  step_name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  ensureTables(db);
  return db;
}

function ensureTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      current_step TEXT,
      state_json TEXT,
      params_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_group ON workflow_runs(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

    CREATE TABLE IF NOT EXISTS workflow_step_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_step_results ON workflow_step_results(run_id, step_name);
  `);
}

export function createWorkflowRun(run: Omit<WorkflowRun, 'finished_at' | 'error'>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO workflow_runs (id, workflow_name, group_folder, chat_jid, status, current_step, state_json, params_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(run.id, run.workflow_name, run.group_folder, run.chat_jid, run.status, run.current_step, run.state_json, run.params_json, run.created_at, run.updated_at);
}

export function updateWorkflowRun(id: string, updates: Partial<WorkflowRun>): void {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.current_step !== undefined) { fields.push('current_step = ?'); values.push(updates.current_step); }
  if (updates.state_json !== undefined) { fields.push('state_json = ?'); values.push(updates.state_json); }
  if (updates.finished_at !== undefined) { fields.push('finished_at = ?'); values.push(updates.finished_at); }
  if (updates.error !== undefined) { fields.push('error = ?'); values.push(updates.error); }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE workflow_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getWorkflowRun(id: string): WorkflowRun | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as WorkflowRun | undefined;
}

export function listWorkflowRunsByGroup(groupFolder: string, options?: { status?: string; limit?: number }): WorkflowRun[] {
  const db = getDb();
  let sql = 'SELECT * FROM workflow_runs WHERE group_folder = ?';
  const params: unknown[] = [groupFolder];
  if (options?.status) {
    sql += ' AND status = ?';
    params.push(options.status);
  }
  sql += ' ORDER BY created_at DESC';
  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  return db.prepare(sql).all(...params) as WorkflowRun[];
}

export function upsertStepResult(runId: string, stepName: string, updates: Partial<WorkflowStepResult>): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM workflow_step_results WHERE run_id = ? AND step_name = ?').get(runId, stepName) as { id: number } | undefined;

  if (existing) {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.result !== undefined) { fields.push('result = ?'); values.push(updates.result); }
    if (updates.error !== undefined) { fields.push('error = ?'); values.push(updates.error); }
    if (updates.started_at !== undefined) { fields.push('started_at = ?'); values.push(updates.started_at); }
    if (updates.finished_at !== undefined) { fields.push('finished_at = ?'); values.push(updates.finished_at); }
    if (fields.length > 0) {
      values.push(existing.id);
      db.prepare(`UPDATE workflow_step_results SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }
  } else {
    db.prepare(`
      INSERT INTO workflow_step_results (run_id, step_name, status, result, error, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runId, stepName, updates.status || 'pending', updates.result || null, updates.error || null, updates.started_at || null, updates.finished_at || null);
  }
}

export function getStepResults(runId: string): WorkflowStepResult[] {
  const db = getDb();
  return db.prepare('SELECT * FROM workflow_step_results WHERE run_id = ? ORDER BY id').all(runId) as WorkflowStepResult[];
}

export function cleanupOldWorkflowRuns(retentionMs: number): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const rows = db.prepare(
    `SELECT id FROM workflow_runs WHERE status IN ('completed', 'failed', 'canceled') AND finished_at < ?`
  ).all(cutoff) as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  const deleteSteps = db.prepare('DELETE FROM workflow_step_results WHERE run_id = ?');
  const deleteRun = db.prepare('DELETE FROM workflow_runs WHERE id = ?');
  const tx = db.transaction(() => {
    for (const row of rows) {
      deleteSteps.run(row.id);
      deleteRun.run(row.id);
    }
  });
  tx();
  return rows.length;
}

export function closeWorkflowStore(): void {
  if (db) {
    db.close();
    db = null;
  }
}
