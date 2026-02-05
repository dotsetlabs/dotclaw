import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isValidTimezone, parseScheduledTimestamp } from '../dist/timezone.js';

test('isValidTimezone validates IANA timezone identifiers', () => {
  assert.equal(isValidTimezone('America/New_York'), true);
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Not/A_Real_Timezone'), false);
});

test('parseScheduledTimestamp interprets local timestamps in provided timezone', () => {
  const local = parseScheduledTimestamp('2026-02-05T09:00:00', 'America/New_York');
  assert.equal(local?.toISOString(), '2026-02-05T14:00:00.000Z');

  const explicit = parseScheduledTimestamp('2026-02-05T09:00:00Z', 'America/New_York');
  assert.equal(explicit?.toISOString(), '2026-02-05T09:00:00.000Z');
});
