import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distPath, importFresh } from './test-helpers.js';

test('parseYamlWorkflow parses a basic workflow', async () => {
  const { parseYamlWorkflow } = await importFresh(distPath('workflow-engine.js'));
  const yaml = `
name: test-workflow
steps:
  - name: step1
    prompt: "Do something"
  - name: step2
    prompt: "Do another thing"
    depends_on:
      - step1
`;
  const result = parseYamlWorkflow(yaml);
  assert.ok(result);
  assert.equal(result.name, 'test-workflow');
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].name, 'step1');
  assert.equal(result.steps[0].prompt, 'Do something');
  assert.equal(result.steps[1].name, 'step2');
  assert.deepEqual(result.steps[1].depends_on, ['step1']);
});

test('parseYamlWorkflow handles multiline prompts', async () => {
  const { parseYamlWorkflow } = await importFresh(distPath('workflow-engine.js'));
  const yaml = `
name: multiline-test
steps:
  - name: analyze
    prompt: |
      Please analyze the following data.
      Consider multiple factors.
      Return a summary.
`;
  const result = parseYamlWorkflow(yaml);
  assert.ok(result);
  assert.equal(result.steps.length, 1);
  assert.ok(result.steps[0].prompt.includes('Please analyze the following data.'));
  assert.ok(result.steps[0].prompt.includes('Consider multiple factors.'));
  assert.ok(result.steps[0].prompt.includes('Return a summary.'));
});

test('parseYamlWorkflow parses trigger and on_error', async () => {
  const { parseYamlWorkflow } = await importFresh(distPath('workflow-engine.js'));
  const yaml = `
name: scheduled-workflow
trigger:
  schedule: "0 9 * * *"
  timezone: "America/New_York"
on_error:
  notify: true
  retry: 3
steps:
  - name: step1
    prompt: "Run daily task"
`;
  const result = parseYamlWorkflow(yaml);
  assert.ok(result);
  assert.equal(result.trigger.schedule, '0 9 * * *');
  assert.equal(result.trigger.timezone, 'America/New_York');
  assert.equal(result.on_error.notify, true);
  assert.equal(result.on_error.retry, 3);
});

test('parseYamlWorkflow parses tools and condition', async () => {
  const { parseYamlWorkflow } = await importFresh(distPath('workflow-engine.js'));
  const yaml = `
name: tool-workflow
steps:
  - name: search
    prompt: "Search the web"
    tools:
      - WebSearch
      - WebFetch
    timeout_ms: 60000
    model_override: "deepseek/deepseek-v3.2"
  - name: summarize
    prompt: "Summarize results"
    condition: "steps.search.result == 'found'"
    depends_on:
      - search
`;
  const result = parseYamlWorkflow(yaml);
  assert.ok(result);
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps[0].tools, ['WebSearch', 'WebFetch']);
  assert.equal(result.steps[0].timeout_ms, 60000);
  assert.equal(result.steps[0].model_override, 'deepseek/deepseek-v3.2');
  assert.equal(result.steps[1].condition, "steps.search.result == 'found'");
  assert.deepEqual(result.steps[1].depends_on, ['search']);
});

test('parseYamlWorkflow handles comments', async () => {
  const { parseYamlWorkflow } = await importFresh(distPath('workflow-engine.js'));
  const yaml = `
# This is a workflow with comments
name: comment-test
steps:
  # First step
  - name: step1
    prompt: "Do it" # inline comment
`;
  const result = parseYamlWorkflow(yaml);
  assert.ok(result);
  assert.equal(result.name, 'comment-test');
  assert.equal(result.steps[0].prompt, 'Do it');
});

test('parseYamlWorkflow returns null for invalid YAML', async () => {
  const { parseYamlWorkflow } = await importFresh(distPath('workflow-engine.js'));
  assert.equal(parseYamlWorkflow(':::invalid'), null);
  assert.equal(parseYamlWorkflow(''), null);
  assert.equal(parseYamlWorkflow('name: test'), null); // no steps
});

test('parseYamlWorkflow handles quoted strings with colons', async () => {
  const { parseYamlWorkflow } = await importFresh(distPath('workflow-engine.js'));
  const yaml = `
name: colon-test
steps:
  - name: step1
    prompt: "Time is: 10:30 AM"
`;
  const result = parseYamlWorkflow(yaml);
  assert.ok(result);
  assert.equal(result.steps[0].prompt, 'Time is: 10:30 AM');
});
