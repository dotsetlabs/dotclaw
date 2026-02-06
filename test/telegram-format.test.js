import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTelegramMessage, TELEGRAM_PARSE_MODE } from '../dist/providers/telegram/telegram-format.js';

test('TELEGRAM_PARSE_MODE is HTML', () => {
  assert.equal(TELEGRAM_PARSE_MODE, 'HTML');
});

test('formatTelegramMessage returns single chunk for short text', () => {
  const result = formatTelegramMessage('Hello world', 4096);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes('Hello world'));
});

test('formatTelegramMessage escapes HTML entities in plain text', () => {
  const result = formatTelegramMessage('Use <div> & "quotes"', 4096);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes('&lt;div&gt;'));
  assert.ok(result[0].includes('&amp;'));
});

test('formatTelegramMessage converts bold markdown to HTML', () => {
  const result = formatTelegramMessage('This is **bold** text', 4096);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes('<b>bold</b>'));
});

test('formatTelegramMessage converts italic markdown to HTML', () => {
  const result = formatTelegramMessage('This is *italic* text', 4096);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes('<i>italic</i>'));
});

test('formatTelegramMessage converts strikethrough markdown to HTML', () => {
  const result = formatTelegramMessage('This is ~~struck~~ text', 4096);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes('<s>struck</s>'));
});

test('formatTelegramMessage converts inline code to HTML', () => {
  const result = formatTelegramMessage('Use `console.log`', 4096);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes('<code>console.log</code>'));
});

test('formatTelegramMessage converts links to HTML', () => {
  const result = formatTelegramMessage('Visit [Google](https://google.com)', 4096);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes('<a href="https://google.com">Google</a>'));
});

test('formatTelegramMessage wraps code fences in pre/code tags', () => {
  const text = 'Before\n```\nconst x = 1;\n```\nAfter';
  const result = formatTelegramMessage(text, 4096);
  const joined = result.join('');
  assert.ok(joined.includes('<pre><code>'));
  assert.ok(joined.includes('const x = 1;'));
  assert.ok(joined.includes('</code></pre>'));
});

test('formatTelegramMessage escapes HTML inside code fences', () => {
  const text = '```\n<script>alert("xss")</script>\n```';
  const result = formatTelegramMessage(text, 4096);
  const joined = result.join('');
  assert.ok(joined.includes('&lt;script&gt;'));
  assert.ok(!joined.includes('<script>'));
});

test('formatTelegramMessage normalizes headings to bold', () => {
  const result = formatTelegramMessage('# Heading One\n## Heading Two', 4096);
  const joined = result.join('');
  assert.ok(joined.includes('<b>Heading One</b>'));
  assert.ok(joined.includes('<b>Heading Two</b>'));
});

test('formatTelegramMessage splits long messages into chunks', () => {
  const longText = 'A'.repeat(5000);
  const result = formatTelegramMessage(longText, 2000);
  assert.ok(result.length > 1, `Expected multiple chunks, got ${result.length}`);
  for (const chunk of result) {
    assert.ok(chunk.length <= 2000, `Chunk exceeds max length: ${chunk.length}`);
  }
});

test('formatTelegramMessage splits long code blocks into chunks', () => {
  const longCode = '```\n' + 'x = 1\n'.repeat(500) + '```';
  const result = formatTelegramMessage(longCode, 2000);
  assert.ok(result.length > 1, 'Expected multiple chunks for long code');
  // Chunk markers add ~30 chars overhead after packing, so allow small overshoot
  const markerOverhead = 50;
  for (const chunk of result) {
    assert.ok(chunk.length <= 2000 + markerOverhead, `Code chunk exceeds max length + marker overhead: ${chunk.length}`);
    // Each code chunk should be properly wrapped
    if (chunk.includes('x = 1')) {
      assert.ok(chunk.includes('<pre><code>'));
      assert.ok(chunk.includes('</code></pre>'));
    }
  }
});

test('formatTelegramMessage handles empty string', () => {
  const result = formatTelegramMessage('', 4096);
  assert.equal(result.length, 0);
});

test('formatTelegramMessage handles CRLF line endings', () => {
  const result = formatTelegramMessage('Line 1\r\nLine 2', 4096);
  const joined = result.join('');
  assert.ok(!joined.includes('\r'), 'Should not contain CR');
});

test('formatTelegramMessage handles mixed text and code', () => {
  const text = 'Here is some text\n\n```js\nfunction hello() {\n  return "hi";\n}\n```\n\nAnd more text after.';
  const result = formatTelegramMessage(text, 4096);
  const joined = result.join('');
  assert.ok(joined.includes('Here is some text'));
  assert.ok(joined.includes('<pre><code>'));
  assert.ok(joined.includes('And more text after'));
});

test('formatTelegramMessage escapes HTML in inline code', () => {
  const result = formatTelegramMessage('Use `<div>` tags', 4096);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes('<code>&lt;div&gt;</code>'));
});

test('formatTelegramMessage handles multiple inline formats', () => {
  const text = '**bold** and *italic* and `code` and ~~struck~~';
  const result = formatTelegramMessage(text, 4096);
  const joined = result.join('');
  assert.ok(joined.includes('<b>bold</b>'));
  assert.ok(joined.includes('<i>italic</i>'));
  assert.ok(joined.includes('<code>code</code>'));
  assert.ok(joined.includes('<s>struck</s>'));
});

test('formatTelegramMessage handles links with special characters in URL', () => {
  const result = formatTelegramMessage('[Search](https://google.com/search?q=hello&lang=en)', 4096);
  const joined = result.join('');
  assert.ok(joined.includes('href="https://google.com/search?q=hello&amp;lang=en"'));
});

// --- chunk numbering markers ---

test('formatTelegramMessage adds continuation hints to multi-chunk responses', () => {
  const longText = 'Word '.repeat(1000);
  const result = formatTelegramMessage(longText, 2000);
  assert.ok(result.length > 1, 'should produce multiple chunks');
  // All but the last chunk should have a continuation hint
  for (let i = 0; i < result.length - 1; i++) {
    assert.ok(result[i].includes('continued'), `chunk ${i} should have continuation hint`);
  }
  // Last chunk should NOT have a continuation hint
  assert.ok(!result[result.length - 1].includes('continued'), 'last chunk should not have continuation hint');
});

test('formatTelegramMessage prepends chunk markers to subsequent chunks', () => {
  const longText = 'Word '.repeat(1000);
  const result = formatTelegramMessage(longText, 2000);
  assert.ok(result.length > 1);
  // First chunk should NOT have a prepended marker (only continuation suffix)
  assert.ok(!result[0].startsWith('[1/'));
  // Second chunk should have a prepended marker
  assert.ok(result[1].startsWith(`[2/${result.length}]`), 'second chunk should start with [2/N]');
});

test('formatTelegramMessage single chunk has no markers', () => {
  const result = formatTelegramMessage('Short text', 4096);
  assert.equal(result.length, 1);
  assert.ok(!result[0].includes('[1/'), 'single chunk should not have markers');
  assert.ok(!result[0].includes('continued'), 'single chunk should not have continuation hint');
});
