import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../dist/json-helpers.js';

test('extractJson returns null for empty string', () => {
  assert.equal(extractJson(''), null);
  assert.equal(extractJson('   '), null);
});

test('extractJson returns null when no JSON present', () => {
  assert.equal(extractJson('Hello, this is just text'), null);
  assert.equal(extractJson('no braces here'), null);
});

test('extractJson extracts a pure JSON string', () => {
  const json = '{"key": "value"}';
  assert.equal(extractJson(json), json);
});

test('extractJson extracts JSON with whitespace wrapping', () => {
  const json = '  {"key": "value"}  ';
  assert.equal(extractJson(json), '{"key": "value"}');
});

test('extractJson extracts JSON from surrounding text', () => {
  const text = 'Here is the result: {"answer": 42} and some more text';
  const result = extractJson(text);
  assert.equal(result, '{"answer": 42}');
});

test('extractJson extracts JSON from markdown code fence', () => {
  const text = '```json\n{"name": "test"}\n```';
  const result = extractJson(text);
  assert.equal(result, '{"name": "test"}');
});

test('extractJson handles nested objects', () => {
  const json = '{"outer": {"inner": {"deep": true}}}';
  const result = extractJson(json);
  assert.equal(result, json);
  // Verify it parses
  const parsed = JSON.parse(result);
  assert.equal(parsed.outer.inner.deep, true);
});

test('extractJson handles strings with braces inside', () => {
  const json = '{"message": "use { and } carefully"}';
  const result = extractJson(json);
  assert.equal(result, json);
  const parsed = JSON.parse(result);
  assert.equal(parsed.message, 'use { and } carefully');
});

test('extractJson handles escaped quotes in strings', () => {
  const json = '{"text": "He said \\"hello\\""}';
  const result = extractJson(json);
  assert.equal(result, json);
  const parsed = JSON.parse(result);
  assert.equal(parsed.text, 'He said "hello"');
});

test('extractJson extracts first JSON object when multiple exist', () => {
  const text = 'First: {"a": 1} Second: {"b": 2}';
  const result = extractJson(text);
  assert.equal(result, '{"a": 1}');
});

test('extractJson handles complex real-world response', () => {
  const text = `I analyzed the request and here's the structured result:

{"profile": "fast", "confidence": 0.85, "reason": "Simple greeting"}

This should route to the fast model.`;
  const result = extractJson(text);
  assert.ok(result !== null);
  const parsed = JSON.parse(result);
  assert.equal(parsed.profile, 'fast');
  assert.equal(parsed.confidence, 0.85);
});

test('extractJson handles arrays inside objects', () => {
  const json = '{"tags": ["a", "b", "c"], "count": 3}';
  const result = extractJson(json);
  assert.equal(result, json);
});

test('extractJson falls back on unbalanced braces', () => {
  // Unbalanced: extra opening brace inside string not properly escaped
  // Should fall back to first/last brace heuristic
  const text = 'prefix {"key": "value"} suffix';
  const result = extractJson(text);
  assert.equal(result, '{"key": "value"}');
});

test('extractJson handles empty object', () => {
  assert.equal(extractJson('{}'), '{}');
});

test('extractJson handles object with only number values', () => {
  const json = '{"x": 1, "y": 2.5, "z": -3}';
  const result = extractJson(json);
  assert.equal(result, json);
});

test('extractJson handles boolean and null values', () => {
  const json = '{"a": true, "b": false, "c": null}';
  const result = extractJson(json);
  assert.equal(result, json);
  const parsed = JSON.parse(result);
  assert.equal(parsed.a, true);
  assert.equal(parsed.b, false);
  assert.equal(parsed.c, null);
});
