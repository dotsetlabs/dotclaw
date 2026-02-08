import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildToolExecutionNudgePrompt,
  classifyToolCallClass,
  detectToolExecutionRequirement,
  isNonRetryableToolError,
  isRetryableToolError,
  normalizeToolCallArguments,
  parseCreateReadFileInstruction,
  parseListReadNewestInstruction,
  shouldRetryIdempotentToolCall,
  normalizeToolCallSignature,
  normalizeToolRoundSignature,
  buildForcedSynthesisPrompt,
  buildToolOutcomeFallback,
  compactToolConversationItems,
} from '../dist/tool-loop-policy.js';

test('classifyToolCallClass separates idempotent and mutating tools', () => {
  assert.equal(classifyToolCallClass('WebFetch'), 'idempotent');
  assert.equal(classifyToolCallClass('mcp__dotclaw__memory_search'), 'idempotent');
  assert.equal(classifyToolCallClass('Write'), 'mutating');
  assert.equal(classifyToolCallClass('mcp__dotclaw__send_message'), 'mutating');
  assert.equal(classifyToolCallClass('Process'), 'unknown');
});

test('isRetryableToolError detects transient tool failures', () => {
  assert.equal(isRetryableToolError('HTTP 429 rate limit'), true);
  assert.equal(isRetryableToolError('request timed out'), true);
  assert.equal(isRetryableToolError('Tool not allowed by policy: Write'), false);
  assert.equal(isRetryableToolError('invalid input schema'), false);
});

test('isNonRetryableToolError detects deterministic tool failures', () => {
  assert.equal(isNonRetryableToolError('Tool not allowed by policy: Write'), true);
  assert.equal(isNonRetryableToolError('Path is required'), true);
  assert.equal(isNonRetryableToolError('The value of "size" is out of range. Received -5'), true);
  assert.equal(isNonRetryableToolError('HTTP 503 Service Unavailable'), false);
});

test('shouldRetryIdempotentToolCall retries only idempotent transient failures', () => {
  assert.equal(shouldRetryIdempotentToolCall({
    toolName: 'WebFetch',
    error: 'HTTP 503',
    attempt: 1,
    maxAttempts: 2
  }), true);

  assert.equal(shouldRetryIdempotentToolCall({
    toolName: 'Write',
    error: 'HTTP 503',
    attempt: 1,
    maxAttempts: 2
  }), false);

  assert.equal(shouldRetryIdempotentToolCall({
    toolName: 'WebFetch',
    error: 'invalid input',
    attempt: 1,
    maxAttempts: 2
  }), false);
});

test('normalizeToolCallSignature is stable for object key order', () => {
  const a = normalizeToolCallSignature({
    name: 'WebFetch',
    arguments: { url: 'https://example.com', options: { a: 1, b: 2 } }
  });
  const b = normalizeToolCallSignature({
    name: 'WebFetch',
    arguments: { options: { b: 2, a: 1 }, url: 'https://example.com' }
  });
  assert.equal(a, b);
});

test('normalizeToolRoundSignature sorts signatures by content', () => {
  const signature = normalizeToolRoundSignature([
    { name: 'WebSearch', arguments: { q: 'b' } },
    { name: 'WebFetch', arguments: { url: 'https://a.example' } }
  ]);
  assert.ok(signature.includes('webfetch'));
  assert.ok(signature.includes('websearch'));
});

test('normalizeToolCallArguments parses json payloads and scalar fallbacks', () => {
  const parsed = normalizeToolCallArguments({
    toolName: 'Write',
    rawArguments: '{"path":"notes.txt","content":"hello"}'
  });
  assert.equal(parsed.malformedReason, undefined);
  assert.deepEqual(parsed.arguments, { path: 'notes.txt', content: 'hello' });

  const scalar = normalizeToolCallArguments({
    toolName: 'Bash',
    rawArguments: 'ls -la'
  });
  assert.equal(scalar.malformedReason, undefined);
  assert.deepEqual(scalar.arguments, { command: 'ls -la' });

  const malformed = normalizeToolCallArguments({
    toolName: 'Write',
    rawArguments: '{"path":"notes.txt","content":"unterminated'
  });
  assert.equal(typeof malformed.malformedReason, 'string');
});

test('normalizeToolCallArguments sanitizes invalid optional numeric fields', () => {
  const globArgs = normalizeToolCallArguments({
    toolName: 'Glob',
    rawArguments: { pattern: 'inbox/*', maxResults: -2000 }
  });
  assert.equal(globArgs.malformedReason, undefined);
  assert.deepEqual(globArgs.arguments, { pattern: 'inbox/*' });

  const webSearchArgs = normalizeToolCallArguments({
    toolName: 'WebSearch',
    rawArguments: { query: 'dotclaw', count: '5', offset: '-3' }
  });
  assert.equal(webSearchArgs.malformedReason, undefined);
  assert.deepEqual(webSearchArgs.arguments, { query: 'dotclaw', count: 5 });
});

test('normalizeToolCallArguments rejects shell-style path payloads', () => {
  const suspicious = normalizeToolCallArguments({
    toolName: 'Read',
    rawArguments: { path: 'inbox/$(ls -1t inbox/ | head -1)' }
  });
  assert.equal(typeof suspicious.malformedReason, 'string');
  assert.ok(String(suspicious.malformedReason).includes('path'));

  const benign = normalizeToolCallArguments({
    toolName: 'Read',
    rawArguments: { path: 'inbox/sample.txt' }
  });
  assert.equal(benign.malformedReason, undefined);
});

test('forced synthesis and fallback text include tool context', () => {
  const prompt = buildForcedSynthesisPrompt({
    reason: 'stuck_loop',
    pendingCalls: [{ name: 'WebFetch', arguments: { url: 'https://example.com' } }],
    toolOutputs: [{ name: 'WebSearch', ok: true, output: 'Found 3 relevant docs.' }]
  });
  assert.ok(prompt.includes('stuck_loop'));
  assert.ok(prompt.includes('WebFetch'));
  assert.ok(prompt.includes('WebSearch'));

  const fallback = buildToolOutcomeFallback({
    reason: 'empty_after_tools',
    pendingCalls: [{ name: 'WebFetch' }],
    toolOutputs: [{ name: 'WebSearch', ok: true, output: 'Found docs.' }]
  });
  assert.ok(fallback.includes('empty_after_tools'));
  assert.ok(fallback.includes('WebSearch'));
  assert.ok(fallback.includes('Unresolved tool calls'));
});

test('compactToolConversationItems trims oversized tool outputs and arguments', () => {
  const payload = [
    {
      type: 'function_call',
      id: 'fc-1',
      name: 'Write',
      arguments: {
        path: 'notes.txt',
        content: 'x'.repeat(5000)
      }
    },
    {
      type: 'function_call_output',
      callId: 'fc-1',
      output: JSON.stringify({ ok: true, body: 'y'.repeat(10000) })
    }
  ];

  const compacted = compactToolConversationItems(payload, {
    maxOutputChars: 1200,
    outputHeadChars: 400,
    outputTailChars: 200,
    maxArgumentChars: 600
  });

  assert.equal(compacted.compacted, 2);
  const compactedCall = compacted.items[0];
  const compactedOutput = compacted.items[1];
  assert.ok(String(compactedCall.arguments.content).includes('omitted'));
  assert.ok(String(compactedOutput.output).includes('Tool output trimmed'));
});

test('detectToolExecutionRequirement identifies high-confidence tool-required prompts', () => {
  const scenario = detectToolExecutionRequirement('[SCENARIO:tool_heavy] Round 1: List newest files.');
  assert.equal(scenario.required, true);
  assert.equal(scenario.reason, 'scenario_tool_heavy');

  const fileAction = detectToolExecutionRequirement('Create file "inbox/demo.txt" then read it back.');
  assert.equal(fileAction.required, true);
  assert.equal(fileAction.reason, 'workspace_file_action');

  const recallPrompt = detectToolExecutionRequirement(
    'From this same conversation session, what exact filename did you just create and what was line 2?'
  );
  assert.equal(recallPrompt.required, false);

  const plainQ = detectToolExecutionRequirement('What is 2 + 2?');
  assert.equal(plainQ.required, false);
});

test('buildToolExecutionNudgePrompt enforces tool evidence in continuation', () => {
  const prompt = buildToolExecutionNudgePrompt({ reason: 'workspace_file_action' });
  assert.ok(prompt.includes('workspace_file_action'));
  assert.ok(prompt.includes('did not execute tools'));
  assert.ok(prompt.includes('Do not claim file/system/web actions'));
});

test('parseCreateReadFileInstruction extracts deterministic create/read instructions', () => {
  const parsed = parseCreateReadFileInstruction(
    'Round 3: Create file "inbox/live-canary-r03.txt" with 3 lines: alpha-3, beta-3, gamma-3. Then read it back and return summary.'
  );
  assert.deepEqual(parsed, {
    path: 'inbox/live-canary-r03.txt',
    lines: ['alpha-3', 'beta-3', 'gamma-3']
  });

  const missing = parseCreateReadFileInstruction('List newest files in inbox/');
  assert.equal(missing, null);
});

test('parseListReadNewestInstruction extracts deterministic list/read instructions', () => {
  const parsed = parseListReadNewestInstruction(
    'Round 2: List the 5 newest files under inbox/, read the newest one, and return exactly 2 bullet points with key details.'
  );
  assert.deepEqual(parsed, {
    directory: 'inbox/',
    count: 5,
    bulletCount: 2
  });

  const parsedDefaultCount = parseListReadNewestInstruction(
    'List newest files in inbox/, read the newest one, and summarize.'
  );
  assert.deepEqual(parsedDefaultCount, {
    directory: 'inbox/',
    count: 5,
    bulletCount: undefined
  });

  const missing = parseListReadNewestInstruction('Create file "inbox/demo.txt" with 2 lines: a, b.');
  assert.equal(missing, null);
});
