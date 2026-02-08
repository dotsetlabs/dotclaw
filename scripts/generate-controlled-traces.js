#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    dir: '',
    fixture: path.join(process.cwd(), 'test', 'fixtures', 'benchmark', 'scenario-traces.jsonl'),
    repeat: 8,
    stepMs: 30_000,
    startMs: Date.now(),
    reset: false,
    seedDir: '',
    seedDays: 14,
    seedLimit: 400,
    chatPrefix: 'controlled',
    skipErrorRows: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir' && i + 1 < argv.length) {
      args.dir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--fixture' && i + 1 < argv.length) {
      args.fixture = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--repeat' && i + 1 < argv.length) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value >= 0) args.repeat = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--step-ms' && i + 1 < argv.length) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.stepMs = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--start' && i + 1 < argv.length) {
      const parsed = Date.parse(argv[i + 1]);
      if (Number.isFinite(parsed)) args.startMs = parsed;
      i += 1;
      continue;
    }
    if (arg === '--reset') {
      args.reset = true;
      continue;
    }
    if (arg === '--seed-dir' && i + 1 < argv.length) {
      args.seedDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--seed-days' && i + 1 < argv.length) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.seedDays = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--seed-limit' && i + 1 < argv.length) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.seedLimit = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--chat-prefix' && i + 1 < argv.length) {
      args.chatPrefix = String(argv[i + 1] || '').trim() || args.chatPrefix;
      i += 1;
      continue;
    }
    if (arg === '--skip-error-rows') {
      args.skipErrorRows = true;
      continue;
    }
  }

  return args;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {
      // ignore malformed lines
    }
  }
  return rows;
}

function traceFileName(ms) {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `trace-${year}-${month}-${day}.jsonl`;
}

function loadSeedRows(seedDir, seedDays, seedLimit) {
  if (!seedDir || !fs.existsSync(seedDir)) return [];
  const sinceMs = Date.now() - (seedDays * 24 * 60 * 60 * 1000);
  const files = fs.readdirSync(seedDir)
    .filter(name => /^trace-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort();
  const rows = [];
  for (const fileName of files) {
    const fileRows = readJsonl(path.join(seedDir, fileName));
    for (const row of fileRows) {
      const ts = Date.parse(String(row.timestamp || ''));
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      rows.push(row);
    }
  }
  if (!Number.isFinite(seedLimit) || seedLimit <= 0 || rows.length <= seedLimit) return rows;
  return rows.slice(rows.length - seedLimit);
}

function synthesizeScenarioRows(fixtureRows, params) {
  const {
    repeat,
    startMs,
    stepMs,
    chatPrefix,
  } = params;

  const rows = [];
  let cursor = startMs;
  for (let r = 0; r < repeat; r += 1) {
    for (const sourceRow of fixtureRows) {
      const timestamp = new Date(cursor).toISOString();
      const chatId = String(sourceRow.chat_id || `chat-${r}`);
      rows.push({
        ...sourceRow,
        timestamp,
        created_at: cursor,
        chat_id: `${chatPrefix}:${r}:${chatId}`
      });
      cursor += stepMs;
    }
  }
  return rows;
}

function writeRows(traceDir, rows) {
  fs.mkdirSync(traceDir, { recursive: true });
  const byFile = new Map();
  for (const row of rows) {
    const ts = Date.parse(String(row.timestamp || ''));
    const fileName = traceFileName(Number.isFinite(ts) ? ts : Date.now());
    if (!byFile.has(fileName)) byFile.set(fileName, []);
    byFile.get(fileName).push(row);
  }

  for (const [fileName, fileRows] of byFile.entries()) {
    const filePath = path.join(traceDir, fileName);
    const lines = fileRows.map(row => JSON.stringify(row)).join('\n');
    fs.appendFileSync(filePath, `${lines}\n`, 'utf-8');
  }
}

function clearTraceDir(traceDir) {
  if (!fs.existsSync(traceDir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(traceDir)) {
    if (!/^trace-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    fs.rmSync(path.join(traceDir, name), { force: true });
    removed += 1;
  }
  return removed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Usage: node scripts/generate-controlled-traces.js --dir <trace-dir> [options]');
    process.exit(1);
  }

  const traceDir = path.resolve(args.dir);
  const fixturePath = path.resolve(args.fixture);
  if (!fs.existsSync(fixturePath)) {
    console.error(`Fixture not found: ${fixturePath}`);
    process.exit(1);
  }

  let clearedFiles = 0;
  if (args.reset) {
    clearedFiles = clearTraceDir(traceDir);
  }

  const seededRows = loadSeedRows(args.seedDir ? path.resolve(args.seedDir) : '', args.seedDays, args.seedLimit);
  const fixtureRows = readJsonl(fixturePath);
  const filteredFixtureRows = args.skipErrorRows
    ? fixtureRows.filter((row) => !(typeof row.error_code === 'string' && row.error_code.trim().length > 0))
    : fixtureRows;
  const scenarioRows = synthesizeScenarioRows(filteredFixtureRows, args);

  writeRows(traceDir, seededRows);
  writeRows(traceDir, scenarioRows);

  const summary = {
    trace_dir: traceDir,
    fixture: fixturePath,
    cleared_files: clearedFiles,
    seeded_rows: seededRows.length,
    scenario_rows: scenarioRows.length,
    total_rows_written: seededRows.length + scenarioRows.length,
    repeat: args.repeat,
    step_ms: args.stepMs,
    chat_prefix: args.chatPrefix
    ,
    skip_error_rows: args.skipErrorRows
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
