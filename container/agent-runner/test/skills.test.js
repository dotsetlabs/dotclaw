import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSkillNotesFromRoots } from '../dist/index.js';

test('loadSkillNotesFromRoots loads group and global skill markdown files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-agent-skills-'));
  const groupDir = path.join(tempRoot, 'group');
  const globalDir = path.join(tempRoot, 'global');
  fs.mkdirSync(path.join(groupDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(globalDir, 'skills'), { recursive: true });

  fs.writeFileSync(path.join(groupDir, 'SKILL.md'), '# Group skill\nAlways run tests.');
  fs.writeFileSync(path.join(groupDir, 'skills', 'research.md'), '# Research skill\nSummarize sources.');
  fs.writeFileSync(path.join(globalDir, 'skills', 'formatting.md'), '# Formatting\nUse markdown.');

  const notes = loadSkillNotesFromRoots({ groupDir, globalDir });
  assert.equal(notes.length, 3);
  assert.equal(notes[0].scope, 'group');
  assert.equal(notes[0].path, 'SKILL.md');
  assert.equal(notes.some(note => note.path === 'skills/research.md' && note.scope === 'group'), true);
  assert.equal(notes.some(note => note.path === 'skills/formatting.md' && note.scope === 'global'), true);
});

test('loadSkillNotesFromRoots respects file and total size limits', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-agent-skills-limit-'));
  const groupDir = path.join(tempRoot, 'group');
  const globalDir = path.join(tempRoot, 'global');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });

  const longContent = 'x'.repeat(5000);
  fs.writeFileSync(path.join(groupDir, 'SKILL.md'), longContent);
  fs.writeFileSync(path.join(globalDir, 'SKILL.md'), longContent);

  const notes = loadSkillNotesFromRoots({
    groupDir,
    globalDir,
    maxCharsPerFile: 300,
    maxTotalChars: 450
  });

  assert.equal(notes.length >= 1, true);
  const total = notes.reduce((sum, note) => sum + note.content.length, 0);
  assert.equal(total <= 520, true);
});
