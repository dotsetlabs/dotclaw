import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildReport, loadTraces } from '../scripts/benchmark-baseline.js';

function traceFileName(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `trace-${year}-${month}-${day}.jsonl`;
}

test('benchmark baseline reclassifies canary-marked rows from dotclaw source', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-baseline-source-'));
  const traceDir = path.join(tempDir, 'traces');
  fs.mkdirSync(traceDir, { recursive: true });

  const now = new Date();
  const tracePath = path.join(traceDir, traceFileName(now));
  const rows = [
    {
      timestamp: now.toISOString(),
      source: 'dotclaw',
      chat_id: 'chat:1',
      input_text: '[CANARY:LIVE] [SCENARIO:tool_heavy] Round 1',
      output_text: 'ok',
      error_code: ''
    },
    {
      timestamp: now.toISOString(),
      source: 'dotclaw',
      chat_id: 'chat:1',
      input_text: 'normal user prompt',
      output_text: null,
      error_code: 'some error'
    }
  ];
  fs.writeFileSync(tracePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');

  const records = loadTraces(traceDir, {
    sinceMs: now.getTime() - 1_000,
    untilMs: now.getTime() + 1_000
  });
  assert.equal(records.length, 2);
  assert.equal(records[0].source, 'live-canary');
  assert.equal(records[1].source, 'dotclaw');

  const report = buildReport(records, traceDir, 7);
  const liveBucket = report.records_by_source.find(item => item.source === 'live-canary');
  const dotclawBucket = report.records_by_source.find(item => item.source === 'dotclaw');
  assert.equal(liveBucket?.records, 1);
  assert.equal(dotclawBucket?.records, 1);
});
