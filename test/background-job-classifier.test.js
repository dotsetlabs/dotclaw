import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distPath, importFresh, withTempHome } from './test-helpers.js';

function writeRuntimeConfig(tempDir, overrides) {
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify(overrides, null, 2));
}

function makeMessage(content) {
  return {
    id: '1',
    chat_jid: 'chat-1',
    sender: 'user-1',
    sender_name: 'Greg',
    content,
    timestamp: new Date().toISOString()
  };
}

async function withClassifierConfig(tempDir, fn) {
  writeRuntimeConfig(tempDir, {
    host: {
      backgroundJobs: {
        autoSpawn: {
          enabled: true,
          classifier: {
            enabled: true,
            model: 'openai/gpt-5-nano',
            timeoutMs: 3000,
            maxOutputTokens: 32,
            temperature: 0,
            confidenceThreshold: 0.6
          }
        }
      }
    }
  });
  await withTempHome(tempDir, fn);
}

test('classifyBackgroundJob returns true on confident background decision', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-classifier-'));
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"background":true,"confidence":0.82,"reason":"multi-step","estimated_minutes":8}' } }]
    })
  });
  process.env.OPENROUTER_API_KEY = 'test-key';

  try {
    await withClassifierConfig(tempDir, async () => {
      const { classifyBackgroundJob } = await importFresh(distPath('background-job-classifier.js'));
      const result = await classifyBackgroundJob({
        lastMessage: makeMessage('Can you do deep research on MCP adoption?'),
        recentMessages: [makeMessage('Can you do deep research on MCP adoption?')],
        isGroup: false,
        chatType: 'private'
      });
      assert.equal(result.shouldBackground, true);
      assert.equal(result.confidence >= 0.6, true);
    });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test('classifyBackgroundJob rejects low confidence', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-classifier-'));
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"background":true,"confidence":0.2,"reason":"maybe"}' } }]
    })
  });
  process.env.OPENROUTER_API_KEY = 'test-key';

  try {
    await withClassifierConfig(tempDir, async () => {
      const { classifyBackgroundJob } = await importFresh(distPath('background-job-classifier.js'));
      const result = await classifyBackgroundJob({
        lastMessage: makeMessage('Quick question about pricing'),
        recentMessages: [makeMessage('Quick question about pricing')],
        isGroup: false,
        chatType: 'private'
      });
      assert.equal(result.shouldBackground, false);
      assert.equal(result.confidence, 0.2);
    });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test('classifyBackgroundJob parses JSON embedded in text and handles invalid output', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-classifier-'));
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'Result:\n{"background":false,"confidence":0.7,"reason":"short"}\nThanks.' } }]
    })
  });
  process.env.OPENROUTER_API_KEY = 'test-key';

  try {
    await withClassifierConfig(tempDir, async () => {
      const { classifyBackgroundJob } = await importFresh(distPath('background-job-classifier.js'));
      const result = await classifyBackgroundJob({
        lastMessage: makeMessage('What time is it?'),
        recentMessages: [makeMessage('What time is it?')],
        isGroup: false,
        chatType: 'private'
      });
      assert.equal(result.shouldBackground, false);
      assert.equal(result.confidence, 0.7);
    });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }

  const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-classifier-'));
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'no json here' } }]
    })
  });
  process.env.OPENROUTER_API_KEY = 'test-key';

  try {
    await withClassifierConfig(tempDir2, async () => {
      const { classifyBackgroundJob } = await importFresh(distPath('background-job-classifier.js'));
      const result = await classifyBackgroundJob({
        lastMessage: makeMessage('Tell me something'),
        recentMessages: [makeMessage('Tell me something')],
        isGroup: false,
        chatType: 'private'
      });
      assert.equal(result.shouldBackground, false);
      assert.ok(result.error);
    });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});
