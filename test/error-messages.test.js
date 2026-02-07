import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeError, isTransientError, getErrorSeverity } from '../dist/error-messages.js';

// --- humanizeError ---

test('humanizeError converts ECONNREFUSED to friendly message', () => {
  const msg = humanizeError('connect ECONNREFUSED 127.0.0.1:3000');
  assert.ok(msg.includes('trouble connecting'));
});

test('humanizeError converts ETIMEDOUT to friendly message', () => {
  const msg = humanizeError('connect ETIMEDOUT');
  assert.ok(msg.includes('too long'));
});

test('humanizeError converts ENOTFOUND to friendly message', () => {
  const msg = humanizeError('getaddrinfo ENOTFOUND api.example.com');
  assert.ok(msg.includes("couldn't reach"));
});

test('humanizeError converts ECONNRESET to friendly message', () => {
  const msg = humanizeError('read ECONNRESET');
  assert.ok(msg.includes('interrupted'));
});

test('humanizeError converts rate limit to friendly message', () => {
  const msg = humanizeError('Rate limit exceeded');
  assert.ok(msg.includes('slow down'));
});

test('humanizeError converts too many requests to friendly message', () => {
  const msg = humanizeError('Too Many Requests');
  assert.ok(msg.includes('rate limited'));
});

test('humanizeError converts context length to friendly message', () => {
  const msg = humanizeError("This model's maximum context length is 8192 tokens");
  assert.ok(msg.includes('too long'));
});

test('humanizeError converts invalid API key to friendly message', () => {
  const msg = humanizeError('Invalid API key provided');
  assert.ok(msg.includes('configuration issue'));
});

test('humanizeError converts 401 to friendly message', () => {
  const msg = humanizeError('HTTP error 401');
  assert.ok(msg.includes('authentication'));
});

test('humanizeError converts 403 to friendly message', () => {
  const msg = humanizeError('HTTP error 403');
  assert.ok(msg.includes('permission'));
});

test('humanizeError converts model not found to friendly message', () => {
  const msg = humanizeError('Model not found: gpt-9');
  assert.ok(msg.includes('model'));
});

test('humanizeError converts container timeout to friendly message', () => {
  const msg = humanizeError('container timeout after 300s');
  assert.ok(msg.includes('too long'));
});

test('humanizeError converts tool call limit to friendly message', () => {
  const msg = humanizeError('tool call limit reached');
  assert.ok(msg.includes('limit'));
});

test('humanizeError converts overloaded to friendly message', () => {
  const msg = humanizeError('Server overloaded');
  assert.ok(msg.includes('busy'));
});

test('humanizeError converts 500 to friendly message', () => {
  const msg = humanizeError('HTTP 500 Internal Server Error');
  assert.ok(msg.includes('server'));
});

test('humanizeError converts out of memory to friendly message', () => {
  const msg = humanizeError('out of memory');
  assert.ok(msg.includes('memory'));
});

test('humanizeError returns default for unknown errors', () => {
  const msg = humanizeError('Something totally unexpected happened');
  assert.ok(msg.includes('unexpected error'));
});

test('humanizeError accepts Error objects', () => {
  const err = new Error('ECONNREFUSED');
  const msg = humanizeError(err);
  assert.ok(msg.includes('trouble connecting'));
});

// --- isTransientError ---

test('isTransientError returns true for ECONNREFUSED', () => {
  assert.equal(isTransientError('ECONNREFUSED'), true);
});

test('isTransientError returns true for ETIMEDOUT', () => {
  assert.equal(isTransientError('ETIMEDOUT'), true);
});

test('isTransientError returns true for ECONNRESET', () => {
  assert.equal(isTransientError('ECONNRESET'), true);
});

test('isTransientError returns true for EAI_AGAIN', () => {
  assert.equal(isTransientError('EAI_AGAIN'), true);
});

test('isTransientError returns true for rate limit', () => {
  assert.equal(isTransientError('rate limit exceeded'), true);
});

test('isTransientError returns true for 429', () => {
  assert.equal(isTransientError('HTTP 429'), true);
});

test('isTransientError returns true for overloaded', () => {
  assert.equal(isTransientError('Server overloaded'), true);
});

test('isTransientError returns true for 502', () => {
  assert.equal(isTransientError('HTTP 502 Bad Gateway'), true);
});

test('isTransientError returns true for 503', () => {
  assert.equal(isTransientError('HTTP 503 Service Unavailable'), true);
});

test('isTransientError returns true for 504', () => {
  assert.equal(isTransientError('HTTP 504 Gateway Timeout'), true);
});

test('isTransientError returns false for auth errors', () => {
  assert.equal(isTransientError('Invalid API key'), false);
});

test('isTransientError returns false for unknown errors', () => {
  assert.equal(isTransientError('Something weird'), false);
});

test('isTransientError accepts Error objects', () => {
  assert.equal(isTransientError(new Error('ECONNRESET')), true);
  assert.equal(isTransientError(new Error('invalid config')), false);
});

// --- getErrorSeverity ---

test('getErrorSeverity returns warn for transient errors', () => {
  assert.equal(getErrorSeverity('ECONNREFUSED'), 'warn');
  assert.equal(getErrorSeverity('rate limit'), 'warn');
  assert.equal(getErrorSeverity('HTTP 502'), 'warn');
});

test('getErrorSeverity returns error for auth errors', () => {
  assert.equal(getErrorSeverity('Invalid API key'), 'error');
  assert.equal(getErrorSeverity('Unauthorized'), 'error');
});

test('getErrorSeverity returns info for user-caused errors', () => {
  assert.equal(getErrorSeverity('context length exceeded'), 'info');
  assert.equal(getErrorSeverity('token limit reached'), 'info');
});

test('getErrorSeverity returns error for unknown errors', () => {
  assert.equal(getErrorSeverity('something completely unknown'), 'error');
});

test('getErrorSeverity accepts Error objects', () => {
  assert.equal(getErrorSeverity(new Error('ETIMEDOUT')), 'warn');
  assert.equal(getErrorSeverity(new Error('Invalid API key')), 'error');
});

// --- payment / credit errors ---

test('humanizeError converts 402 to credits message', () => {
  const msg = humanizeError('HTTP 402 Payment Required');
  assert.ok(msg.includes('credits'), msg);
});

test('humanizeError converts insufficient credit to credits message', () => {
  const msg = humanizeError('Insufficient credit balance');
  assert.ok(msg.includes('credits'), msg);
});

test('humanizeError converts payment required to credits message', () => {
  const msg = humanizeError('payment required');
  assert.ok(msg.includes('credits'), msg);
});

// --- container errors ---

test('humanizeError converts stdout truncated', () => {
  const msg = humanizeError('stdout truncated at 1MB');
  assert.ok(msg.includes('too large'), msg);
});

test('humanizeError converts container exited', () => {
  const msg = humanizeError('container exited with code 137');
  assert.ok(msg.includes('went wrong'), msg);
});

// --- word boundary patterns ---

test('humanizeError 500 word boundary does not match port 5000', () => {
  const msg = humanizeError('listening on port 5000');
  // Should NOT match the 500 pattern — should fall through to default
  assert.ok(!msg.includes('server encountered'), msg);
});

test('humanizeError 502 word boundary does not match ID containing 502', () => {
  const msg = humanizeError('response ID gen-50234 received');
  // Should NOT match the 502 pattern
  assert.ok(!msg.includes('temporary server'), msg);
});
