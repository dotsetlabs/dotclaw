import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateId } from '../dist/id.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('generateId includes the given prefix', () => {
  const id = generateId('task');
  assert.ok(id.startsWith('task-'), `Expected "${id}" to start with "task-"`);
});

test('generateId produces a valid UUID after the prefix', () => {
  const id = generateId('job');
  const uuid = id.slice('job-'.length);
  assert.match(uuid, UUID_RE, `Expected UUID format, got "${uuid}"`);
});

test('generateId produces unique IDs', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    ids.add(generateId('test'));
  }
  assert.equal(ids.size, 100, 'All 100 generated IDs should be unique');
});

test('generateId with empty prefix returns a bare UUID', () => {
  const id = generateId('');
  assert.match(id, UUID_RE, `Expected bare UUID, got "${id}"`);
});

test('generateId works with long prefix', () => {
  const prefix = 'very-long-prefix-name';
  const id = generateId(prefix);
  assert.ok(id.startsWith(`${prefix}-`));
  const uuid = id.slice(prefix.length + 1);
  assert.match(uuid, UUID_RE, `Expected UUID after prefix, got "${uuid}"`);
});
