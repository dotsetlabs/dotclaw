import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseFrontmatter, buildSkillCatalog, formatSkillCatalog, collectSkillPluginDirs } from '../dist/skill-loader.js';

test('parseFrontmatter extracts name and description', () => {
  const content = [
    '---',
    'name: code-review',
    'description: Reviews code for bugs and style issues.',
    'license: MIT',
    '---',
    '',
    '# Instructions',
    'Review code carefully.'
  ].join('\n');

  const fm = parseFrontmatter(content);
  assert.ok(fm);
  assert.equal(fm.name, 'code-review');
  assert.equal(fm.description, 'Reviews code for bugs and style issues.');
  assert.equal(fm.license, 'MIT');
});

test('parseFrontmatter handles multiline description with >', () => {
  const content = [
    '---',
    'name: daily-digest',
    'description: >',
    '  Sends a daily summary of news,',
    '  weather, and calendar events.',
    'license: Apache-2.0',
    '---',
    '',
    '# Body'
  ].join('\n');

  const fm = parseFrontmatter(content);
  assert.ok(fm);
  assert.equal(fm.name, 'daily-digest');
  assert.equal(fm.description, 'Sends a daily summary of news, weather, and calendar events.');
});

test('parseFrontmatter extracts metadata and plugins', () => {
  const content = [
    '---',
    'name: test-skill',
    'description: A test skill.',
    'metadata:',
    '  author: test-org',
    '  version: "1.0"',
    '  tags: ["code", "review"]',
    'plugins:',
    '  - plugins/test-tool.json',
    '  - plugins/other.json',
    '---',
    ''
  ].join('\n');

  const fm = parseFrontmatter(content);
  assert.ok(fm);
  assert.equal(fm.name, 'test-skill');
  assert.ok(fm.metadata);
  assert.equal(fm.metadata.author, 'test-org');
  assert.equal(fm.metadata.version, '1.0');
  assert.deepEqual(fm.metadata.tags, ['code', 'review']);
  assert.deepEqual(fm.plugins, ['plugins/test-tool.json', 'plugins/other.json']);
});

test('parseFrontmatter returns null for missing fields', () => {
  assert.equal(parseFrontmatter('no frontmatter here'), null);
  assert.equal(parseFrontmatter('---\nname: test\n---\n'), null); // missing description
  assert.equal(parseFrontmatter('---\ndescription: test\n---\n'), null); // missing name
});

test('buildSkillCatalog finds standard skills and ignores plain .md without frontmatter', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-skill-catalog-'));
  const groupDir = path.join(tempRoot, 'group');
  const globalDir = path.join(tempRoot, 'global');

  // Standard skill (directory form)
  const skillDir = path.join(groupDir, 'skills', 'code-review');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: code-review',
    'description: Reviews code.',
    '---',
    '# Full instructions here'
  ].join('\n'));

  // Plain .md without frontmatter — should be ignored
  fs.mkdirSync(path.join(groupDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'skills', 'old-note.md'), '# Old note\nDo things.');

  // Global standard skill (single-file form)
  fs.mkdirSync(path.join(globalDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(globalDir, 'skills', 'web-search.md'), [
    '---',
    'name: web-search',
    'description: Searches the web.',
    '---',
    '# Instructions'
  ].join('\n'));

  const catalog = buildSkillCatalog({ groupDir, globalDir });

  assert.equal(catalog.entries.length, 2);
  assert.equal(catalog.entries[0].name, 'code-review');
  assert.equal(catalog.entries[0].scope, 'group');
  assert.equal(catalog.entries[1].name, 'web-search');
  assert.equal(catalog.entries[1].scope, 'global');
});

test('formatSkillCatalog includes progressive disclosure summaries', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-skill-format-'));
  const groupDir = path.join(tempRoot, 'group');
  const globalDir = path.join(tempRoot, 'global');

  const skillDir = path.join(groupDir, 'skills', 'test-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: test-skill',
    'description: A test skill for testing.',
    '---',
    '# Full content'
  ].join('\n'));

  fs.mkdirSync(globalDir, { recursive: true });

  const catalog = buildSkillCatalog({ groupDir, globalDir });
  const formatted = formatSkillCatalog(catalog);

  assert.ok(formatted.includes('Skills available'));
  assert.ok(formatted.includes('test-skill: A test skill for testing.'));
  assert.ok(formatted.includes('SKILL.md'));
  // Full content should NOT be in the formatted output
  assert.ok(!formatted.includes('# Full content'));
});

test('collectSkillPluginDirs finds plugins directories inside skills', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-skill-plugins-'));
  const groupDir = path.join(tempRoot, 'group');
  const globalDir = path.join(tempRoot, 'global');

  // Create a skill with plugins
  const pluginDir = path.join(groupDir, 'skills', 'code-review', 'plugins');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'test.json'), '{}');

  // Create a skill without plugins
  fs.mkdirSync(path.join(groupDir, 'skills', 'no-plugins'), { recursive: true });

  fs.mkdirSync(path.join(globalDir, 'skills'), { recursive: true });

  const dirs = collectSkillPluginDirs({ groupDir, globalDir });
  assert.equal(dirs.length, 1);
  assert.ok(dirs[0].endsWith(path.join('code-review', 'plugins')));
});

test('buildSkillCatalog handles empty/missing directories gracefully', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-skill-empty-'));
  const groupDir = path.join(tempRoot, 'group');
  const globalDir = path.join(tempRoot, 'global');
  // Don't create any directories

  const catalog = buildSkillCatalog({ groupDir, globalDir });
  assert.equal(catalog.entries.length, 0);
  assert.equal(formatSkillCatalog(catalog), '');
});
