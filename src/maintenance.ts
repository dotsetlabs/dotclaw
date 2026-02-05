import fs from 'fs';
import path from 'path';
import { MAINTENANCE_INTERVAL_MS, TRACE_DIR, TRACE_RETENTION_DAYS, DATA_DIR } from './config.js';
import { runMemoryMaintenance } from './memory-store.js';
import { cleanupCompletedMessages } from './db.js';
import { logger } from './logger.js';

const IPC_FILE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const IPC_ERROR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours for error files

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

/**
 * Cleanup orphaned IPC files older than the max age
 * Cleans up requests, responses, messages, and tasks directories
 */
export function cleanupOrphanedIpcFiles(): number {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  if (!fs.existsSync(ipcBaseDir)) return 0;

  const now = Date.now();
  let removed = 0;
  const subDirs = ['requests', 'responses', 'messages', 'tasks', 'agent_requests', 'agent_responses'];

  try {
    // Get all group IPC directories
    const groupDirs = fs.readdirSync(ipcBaseDir).filter(f => {
      try {
        return fs.statSync(path.join(ipcBaseDir, f)).isDirectory() && f !== 'errors';
      } catch {
        return false;
      }
    });

    for (const groupDir of groupDirs) {
      for (const subDir of subDirs) {
        const dirPath = path.join(ipcBaseDir, groupDir, subDir);
        if (!fs.existsSync(dirPath)) continue;

        try {
          const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
          for (const file of files) {
            const filePath = path.join(dirPath, file);
            try {
              const stat = fs.statSync(filePath);
              if (now - stat.mtimeMs > IPC_FILE_MAX_AGE_MS) {
                fs.unlinkSync(filePath);
                removed += 1;
              }
            } catch {
              // Skip files we can't stat
            }
          }
        } catch {
          // Skip directories we can't read
        }
      }
    }

    if (removed > 0) {
      logger.debug({ removed }, 'Cleaned up orphaned IPC files');
    }
  } catch (err) {
    logger.warn({ err }, 'Error during IPC cleanup');
  }

  return removed;
}

/**
 * Cleanup old IPC error files
 * Error files are kept longer (24h) for debugging purposes
 */
export function cleanupIpcErrorFiles(): number {
  const errorsDir = path.join(DATA_DIR, 'ipc', 'errors');
  if (!fs.existsSync(errorsDir)) return 0;

  const now = Date.now();
  let removed = 0;

  try {
    const files = fs.readdirSync(errorsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(errorsDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > IPC_ERROR_MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          removed += 1;
        }
      } catch {
        // Skip files we can't stat
      }
    }

    if (removed > 0) {
      logger.debug({ removed }, 'Cleaned up old IPC error files');
    }
  } catch (err) {
    logger.warn({ err }, 'Error during IPC error cleanup');
  }

  return removed;
}

let maintenanceTimer: NodeJS.Timeout | null = null;

export function startMaintenanceLoop(): void {
  const run = () => {
    const memResult = runMemoryMaintenance();
    const traceRemoved = cleanupTraceFiles(TRACE_RETENTION_DAYS);
    const ipcRemoved = cleanupOrphanedIpcFiles();
    const ipcErrorsRemoved = cleanupIpcErrorFiles();
    const queuePurged = cleanupCompletedMessages(24 * 60 * 60 * 1000);

    if (memResult.expired > 0 || memResult.pruned > 0 || memResult.decayed > 0 || traceRemoved > 0 || ipcRemoved > 0 || ipcErrorsRemoved > 0 || queuePurged > 0) {
      logger.info({
        expired: memResult.expired,
        pruned: memResult.pruned,
        decayed: memResult.decayed,
        vacuumed: memResult.vacuumed,
        traceRemoved,
        ipcRemoved,
        ipcErrorsRemoved,
        queuePurged
      }, 'Maintenance completed');
    }
  };

  run();
  maintenanceTimer = setInterval(run, MAINTENANCE_INTERVAL_MS);
}

export function stopMaintenanceLoop(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}
