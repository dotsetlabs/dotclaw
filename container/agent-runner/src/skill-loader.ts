/**
 * Skill Loader — parses SKILL.md frontmatter, builds a catalog of
 * name+description summaries for the system prompt.
 *
 * Skills use YAML frontmatter in SKILL.md files:
 *   skills/<name>/SKILL.md   (directory form)
 *   skills/<name>.md          (single-file form, with frontmatter)
 *
 * Plain .md files without frontmatter are ignored.
 */

import fs from 'fs';
import path from 'path';

// ── Types ────────────────────────────────────────────────────────────

export type SkillFrontmatter = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: { author?: string; version?: string; tags?: string[] };
  plugins?: string[];
};

export type SkillEntry = {
  scope: 'group' | 'global';
  name: string;
  description: string;
  directory: string;
  skillMdPath: string;
  frontmatter: SkillFrontmatter;
};

export type SkillCatalog = {
  entries: SkillEntry[];
};

// ── Frontmatter parser ───────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Minimal YAML-subset parser for SKILL.md frontmatter.
 * Handles simple key: value, multiline `>`, and `- item` arrays.
 * Returns null if the content has no frontmatter block.
 */
export function parseFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const yaml = match[1];
  const result: Record<string, unknown> = {};
  let currentKey = '';
  let currentIndent = 0;
  let collectingMultiline = false;
  let multilineValue = '';
  let collectingArray = false;
  let arrayItems: string[] = [];
  let nestedObject: Record<string, unknown> = {};
  let collectingNested = false;
  let nestedKey = '';

  const flushMultiline = () => {
    if (collectingMultiline && currentKey) {
      result[currentKey] = multilineValue.trim();
      collectingMultiline = false;
      multilineValue = '';
    }
  };

  const flushArray = () => {
    if (collectingArray && currentKey) {
      result[currentKey] = arrayItems;
      collectingArray = false;
      arrayItems = [];
    }
  };

  const flushNested = () => {
    if (collectingNested && nestedKey) {
      result[nestedKey] = { ...nestedObject };
      collectingNested = false;
      nestedObject = {};
      nestedKey = '';
    }
  };

  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Blank line in multiline block
    if (!trimmed && collectingMultiline) {
      multilineValue += '\n';
      continue;
    }

    // Array item continuation
    if (collectingArray && indent > currentIndent && trimmed.startsWith('- ')) {
      // First array item disambiguates: this is an array, not a nested object
      if (collectingNested) {
        collectingNested = false;
        nestedObject = {};
        nestedKey = '';
      }
      const item = trimmed.slice(2).trim();
      const unquoted = item.replace(/^["']|["']$/g, '');
      arrayItems.push(unquoted);
      continue;
    }

    // Nested object key: value
    if (collectingNested && indent > currentIndent && trimmed.includes(':') && !trimmed.startsWith('- ')) {
      // First nested key disambiguates: this is a nested object, not an array
      if (collectingArray) {
        collectingArray = false;
        arrayItems = [];
      }
      const colonIdx = trimmed.indexOf(':');
      const nk = trimmed.slice(0, colonIdx).trim();
      let nv: unknown = trimmed.slice(colonIdx + 1).trim();
      // Handle inline arrays: ["tag1", "tag2"]
      if (typeof nv === 'string' && (nv as string).startsWith('[')) {
        try {
          nv = JSON.parse(nv as string);
        } catch {
          // leave as string
        }
      }
      // Unquote strings
      if (typeof nv === 'string') {
        nv = (nv as string).replace(/^["']|["']$/g, '');
      }
      nestedObject[nk] = nv;
      continue;
    }

    // Multiline continuation
    if (collectingMultiline && indent > currentIndent) {
      multilineValue += (multilineValue ? ' ' : '') + trimmed;
      continue;
    }

    // End of any multiline/array/nested collection
    flushMultiline();
    flushArray();
    flushNested();

    // Skip empty or comment lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Parse "key: value" line
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();
    currentKey = key;
    currentIndent = indent;

    if (rawValue === '>' || rawValue === '|') {
      collectingMultiline = true;
      multilineValue = '';
      continue;
    }

    if (rawValue === '') {
      // Could be a nested object or array — peek at next line
      // We set up for both; the first continuation line determines which
      collectingNested = true;
      nestedKey = key;
      nestedObject = {};
      collectingArray = true;
      // Array items also collected, we'll pick whichever gets data
      continue;
    }

    // Inline array: [a, b, c]
    if (rawValue.startsWith('[')) {
      try {
        result[key] = JSON.parse(rawValue);
      } catch {
        result[key] = rawValue;
      }
      continue;
    }

    // Unquote
    result[key] = rawValue.replace(/^["']|["']$/g, '');
  }

  flushMultiline();
  flushArray();
  flushNested();

  // Validate required fields
  const name = typeof result.name === 'string' ? result.name.trim() : '';
  const description = typeof result.description === 'string' ? result.description.trim() : '';
  if (!name || !description) return null;

  // Build typed result
  const fm: SkillFrontmatter = { name, description };
  if (typeof result.license === 'string') fm.license = result.license;
  if (typeof result.compatibility === 'string') fm.compatibility = result.compatibility;

  // Metadata
  if (result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)) {
    const m = result.metadata as Record<string, unknown>;
    fm.metadata = {};
    if (typeof m.author === 'string') fm.metadata.author = m.author;
    if (typeof m.version === 'string') fm.metadata.version = m.version;
    if (Array.isArray(m.tags)) fm.metadata.tags = m.tags.filter((t): t is string => typeof t === 'string');
  }

  // Plugins
  if (Array.isArray(result.plugins)) {
    fm.plugins = result.plugins.filter((p): p is string => typeof p === 'string');
  }

  return fm;
}

// ── Filesystem helpers ───────────────────────────────────────────────

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectorySafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFileSafe(p: string): boolean {
  try {
    const stat = fs.lstatSync(p);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function readFileSafe(p: string, maxChars: number): string | null {
  try {
    const content = fs.readFileSync(p, 'utf-8');
    return content.length > maxChars ? content.slice(0, maxChars) : content;
  } catch {
    return null;
  }
}

// ── Catalog builder ──────────────────────────────────────────────────

const DEFAULT_MAX_SKILLS = 32;

export function buildSkillCatalog(params: {
  groupDir: string;
  globalDir: string;
  maxSkills?: number;
}): SkillCatalog {
  const maxSkills = params.maxSkills ?? DEFAULT_MAX_SKILLS;
  const entries: SkillEntry[] = [];

  const scanScope = (scope: 'group' | 'global', rootDir: string) => {
    const skillsDir = path.join(rootDir, 'skills');
    if (!isDirectorySafe(skillsDir)) return;

    const items = readdirSafe(skillsDir).sort();
    for (const item of items) {
      if (entries.length >= maxSkills) break;

      const itemPath = path.join(skillsDir, item);

      // Directory form: skills/<name>/SKILL.md
      if (isDirectorySafe(itemPath)) {
        const skillMdPath = path.join(itemPath, 'SKILL.md');
        if (!isFileSafe(skillMdPath)) continue;

        const content = readFileSafe(skillMdPath, 8000);
        if (!content) continue;

        const fm = parseFrontmatter(content);
        if (fm) {
          entries.push({
            scope,
            name: fm.name,
            description: fm.description,
            directory: itemPath,
            skillMdPath,
            frontmatter: fm,
          });
        }
        continue;
      }

      // Single-file form: skills/<name>.md (must have frontmatter)
      if (item.endsWith('.md') && isFileSafe(itemPath)) {
        const content = readFileSafe(itemPath, 8000);
        if (!content) continue;

        const fm = parseFrontmatter(content);
        if (fm) {
          entries.push({
            scope,
            name: fm.name,
            description: fm.description,
            directory: path.dirname(itemPath),
            skillMdPath: itemPath,
            frontmatter: fm,
          });
        }
      }
    }
  };

  scanScope('group', params.groupDir);
  scanScope('global', params.globalDir);

  return { entries };
}

// ── Formatters ───────────────────────────────────────────────────────

export function formatSkillCatalog(catalog: SkillCatalog): string {
  if (catalog.entries.length === 0) return '';

  const lines = [
    'Skills available (use Read tool to load full instructions when needed):',
  ];
  for (const entry of catalog.entries) {
    const scopePrefix = entry.scope === 'global' ? '/workspace/global' : '/workspace/group';
    const dir = path.basename(entry.directory);
    const readPath = entry.skillMdPath.startsWith('/')
      ? entry.skillMdPath  // already absolute container path
      : `${scopePrefix}/skills/${dir}/SKILL.md`;
    lines.push(`- ${entry.name}: ${entry.description} (${readPath})`);
  }
  lines.push('');
  lines.push('When a task matches a skill, read its SKILL.md for full instructions.');
  return lines.join('\n');
}

// ── Skill plugin directory collector ─────────────────────────────────

export function collectSkillPluginDirs(params: {
  groupDir: string;
  globalDir: string;
}): string[] {
  const dirs: string[] = [];

  const scan = (rootDir: string) => {
    const skillsDir = path.join(rootDir, 'skills');
    if (!isDirectorySafe(skillsDir)) return;

    for (const entry of readdirSafe(skillsDir)) {
      const pluginDir = path.join(skillsDir, entry, 'plugins');
      if (isDirectorySafe(pluginDir)) {
        dirs.push(pluginDir);
      }
    }
  };

  scan(params.groupDir);
  scan(params.globalDir);
  return dirs;
}
