import fs from 'fs';
import path from 'path';
import { MAINTENANCE_INTERVAL_MS, TRACE_DIR, TRACE_RETENTION_DAYS } from './config.js';
import { cleanupExpiredMemories } from './memory-store.js';

function parseTraceDate(filename: string): Date | null {
  const match = filename.match(/trace-(\d{4}-\d{2}-\d{2})\.jsonl$/);
  if (!match) return null;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function cleanupTraceFiles(retentionDays: number): number {
  if (!TRACE_DIR || retentionDays <= 0) return 0;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    if (!fs.existsSync(TRACE_DIR)) return 0;
    const files = fs.readdirSync(TRACE_DIR).filter(name => name.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = path.join(TRACE_DIR, file);
      const date = parseTraceDate(file);
      const stat = fs.statSync(filePath);
      const timestamp = date ? date.getTime() : stat.mtime.getTime();
      if (timestamp < cutoffMs) {
        fs.unlinkSync(filePath);
        removed += 1;
      }
    }
  } catch {
    // ignore cleanup errors
  }
  return removed;
}

export function startMaintenanceLoop(): void {
  const run = () => {
    cleanupExpiredMemories();
    cleanupTraceFiles(TRACE_RETENTION_DAYS);
  };

  run();
  setInterval(run, MAINTENANCE_INTERVAL_MS);
}
