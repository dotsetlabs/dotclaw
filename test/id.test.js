import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateId } from '../dist/id.js';

test('generateId includes the given prefix', () => {
  const id = generateId('task');
  assert.ok(id.startsWith('task-'), `Expected "${id}" to start with "task-"`);
});

test('generateId contains a timestamp component', () => {
  const before = Date.now();
  const id = generateId('job');
  const after = Date.now();
  const parts = id.split('-');
  // parts: [prefix, timestamp, random]
  const ts = Number(parts[1]);
  assert.ok(ts >= before && ts <= after, `Timestamp ${ts} not in range [${before}, ${after}]`);
});

test('generateId contains a random suffix', () => {
  const id = generateId('x');
  const parts = id.split('-');
  const randomPart = parts[2];
  assert.ok(randomPart.length >= 1, 'Random part should exist');
  assert.ok(/^[a-z0-9]+$/.test(randomPart), 'Random part should be alphanumeric');
});

test('generateId produces unique IDs', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    ids.add(generateId('test'));
  }
  assert.equal(ids.size, 100, 'All 100 generated IDs should be unique');
});

test('generateId works with empty prefix', () => {
  const id = generateId('');
  assert.ok(id.startsWith('-'), `Expected "${id}" to start with "-"`);
  assert.ok(id.length > 5, 'Should still have timestamp and random parts');
});

test('generateId works with long prefix', () => {
  const prefix = 'very-long-prefix-name';
  const id = generateId(prefix);
  assert.ok(id.startsWith(`${prefix}-`));
});
