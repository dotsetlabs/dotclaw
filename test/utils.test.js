import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSafeGroupFolder, loadJson, saveJson } from '../dist/utils.js';

// --- isSafeGroupFolder ---

test('isSafeGroupFolder rejects invalid names and traversal', () => {
  const base = '/tmp/groups';
  assert.equal(isSafeGroupFolder('valid-name', base), true);
  assert.equal(isSafeGroupFolder('INVALID', base), false);
  assert.equal(isSafeGroupFolder('../escape', base), false);
});

test('isSafeGroupFolder accepts lowercase with numbers and hyphens', () => {
  const base = '/tmp/groups';
  assert.equal(isSafeGroupFolder('my-group', base), true);
  assert.equal(isSafeGroupFolder('group123', base), true);
  assert.equal(isSafeGroupFolder('a-b-c-1-2-3', base), true);
  assert.equal(isSafeGroupFolder('main', base), true);
});

test('isSafeGroupFolder rejects invalid characters', () => {
  const base = '/tmp/groups';
  assert.equal(isSafeGroupFolder('has space', base), false);
  assert.equal(isSafeGroupFolder('has.dot', base), false);
  assert.equal(isSafeGroupFolder('has_underscore', base), false);
  assert.equal(isSafeGroupFolder('HAS-CAPS', base), false);
  assert.equal(isSafeGroupFolder('has/slash', base), false);
  assert.equal(isSafeGroupFolder('has\\backslash', base), false);
  assert.equal(isSafeGroupFolder('has@symbol', base), false);
});

test('isSafeGroupFolder rejects empty and special values', () => {
  const base = '/tmp/groups';
  assert.equal(isSafeGroupFolder('', base), false);
  assert.equal(isSafeGroupFolder('.', base), false);
  assert.equal(isSafeGroupFolder('..', base), false);
  assert.equal(isSafeGroupFolder('.hidden', base), false);
});

test('isSafeGroupFolder rejects path traversal attempts', () => {
  const base = '/tmp/groups';
  assert.equal(isSafeGroupFolder('../etc', base), false);
  assert.equal(isSafeGroupFolder('../../root', base), false);
  assert.equal(isSafeGroupFolder('foo/../bar', base), false);
});

// --- loadJson ---

test('loadJson returns default when file does not exist', () => {
  const result = loadJson('/tmp/nonexistent-dotclaw-test-file.json', { fallback: true });
  assert.deepEqual(result, { fallback: true });
});

test('loadJson returns default when file contains invalid JSON', () => {
  const tmpFile = path.join(os.tmpdir(), `dotclaw-test-invalid-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, 'not valid json {{{');
    const result = loadJson(tmpFile, { fallback: true });
    assert.deepEqual(result, { fallback: true });
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('loadJson returns parsed JSON when file is valid', () => {
  const tmpFile = path.join(os.tmpdir(), `dotclaw-test-valid-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify({ name: 'test', count: 42 }));
    const result = loadJson(tmpFile, {});
    assert.deepEqual(result, { name: 'test', count: 42 });
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('loadJson handles array default values', () => {
  const result = loadJson('/tmp/nonexistent-dotclaw-test-file.json', []);
  assert.deepEqual(result, []);
});

// --- saveJson ---

test('saveJson creates parent directories', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-savejson-'));
  const nested = path.join(tmpDir, 'a', 'b', 'c', 'test.json');
  try {
    saveJson(nested, { saved: true });
    assert.ok(fs.existsSync(nested), 'File should be created');
    const content = JSON.parse(fs.readFileSync(nested, 'utf-8'));
    assert.deepEqual(content, { saved: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('saveJson writes formatted JSON', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-savejson-'));
  const filePath = path.join(tmpDir, 'formatted.json');
  try {
    saveJson(filePath, { key: 'value' });
    const raw = fs.readFileSync(filePath, 'utf-8');
    // Should be pretty-printed with 2-space indent
    assert.ok(raw.includes('\n'), 'Should contain newlines (pretty-printed)');
    assert.equal(JSON.parse(raw).key, 'value');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('saveJson overwrites existing file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-savejson-'));
  const filePath = path.join(tmpDir, 'overwrite.json');
  try {
    saveJson(filePath, { version: 1 });
    saveJson(filePath, { version: 2 });
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(content.version, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('saveJson handles complex data structures', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-savejson-'));
  const filePath = path.join(tmpDir, 'complex.json');
  try {
    const data = {
      string: 'hello',
      number: 42,
      boolean: true,
      null_value: null,
      array: [1, 'two', { three: 3 }],
      nested: { deep: { value: 'found' } }
    };
    saveJson(filePath, data);
    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.deepEqual(loaded, data);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
