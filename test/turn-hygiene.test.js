import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyTurnHygiene } from '../dist/turn-hygiene.js';

function turn(overrides = {}) {
  return {
    id: '1',
    chat_jid: 'telegram:1',
    sender: 'user-1',
    sender_name: 'User',
    content: 'Hello',
    timestamp: '2026-01-01T00:00:00.000Z',
    attachments_json: null,
    ...overrides
  };
}

test('applyTurnHygiene drops malformed turns', () => {
  const result = applyTurnHygiene([
    turn({ id: '', content: 'bad id' }),
    turn({ id: '2', timestamp: 'not-a-date', content: 'bad timestamp' }),
    turn({ id: '3', content: 'ok' })
  ]);

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, '3');
  assert.equal(result.stats.droppedMalformed, 2);
});

test('applyTurnHygiene de-duplicates repeated chunk updates', () => {
  const result = applyTurnHygiene([
    turn({ id: '1', content: 'Investigating the issue now', timestamp: '2026-01-01T00:00:00.000Z' }),
    turn({ id: '2', content: 'Investigating the issue now with additional details and findings', timestamp: '2026-01-01T00:00:05.000Z' })
  ]);

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, '2');
  assert.equal(result.stats.droppedDuplicates, 1);
});

test('applyTurnHygiene drops stale partial placeholders', () => {
  const result = applyTurnHygiene([
    turn({ id: '1', content: '[streaming]', timestamp: '2026-01-01T00:00:00.000Z' }),
    turn({ id: '2', content: 'Final user message content', timestamp: '2026-01-01T00:00:04.000Z' })
  ]);

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, '2');
  assert.equal(result.stats.droppedStalePartials, 1);
});

test('applyTurnHygiene normalizes tool result envelopes', () => {
  const result = applyTurnHygiene([
    turn({
      id: '1',
      content: JSON.stringify({ tool: 'WebFetch', output: 'Fetched 20 rows successfully.' })
    })
  ]);

  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].content, /^Tool result \(WebFetch\): /);
  assert.equal(result.stats.normalizedToolEnvelopes, 1);
});
