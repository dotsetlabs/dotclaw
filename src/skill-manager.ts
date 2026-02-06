/**
 * Skill Manager — host-side skill install/remove/list/update.
 *
 * Skills are installed into group or global skills/ directories and
 * tracked via a `.manifest.json` file alongside them.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

// ── Types ────────────────────────────────────────────────────────────

export type InstalledSkill = {
  name: string;
  source: string;
  version: string;
  installed_at: string;
  scope: 'group' | 'global';
};

type Manifest = {
  skills: Record<string, {
    source: string;
    version: string;
    installed_at: string;
  }>;
};

// ── Frontmatter parser (host-side, mirrors container skill-loader) ───

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function parseNameFromFrontmatter(content: string): string | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('name:')) {
      return trimmed.slice(5).trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

function parseVersionFromFrontmatter(content: string): string {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return '0.0.0';
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('version:')) {
      return trimmed.slice(8).trim().replace(/^["']|["']$/g, '') || '0.0.0';
    }
  }
  return '0.0.0';
}

// ── Manifest helpers ─────────────────────────────────────────────────

function manifestPath(skillsDir: string): string {
  return path.join(skillsDir, '.manifest.json');
}

function loadManifest(skillsDir: string): Manifest {
  const mp = manifestPath(skillsDir);
  try {
    if (fs.existsSync(mp)) {
      const raw = JSON.parse(fs.readFileSync(mp, 'utf-8'));
      if (raw && typeof raw === 'object' && raw.skills) return raw as Manifest;
    }
  } catch {
    // corrupt manifest — start fresh
  }
  return { skills: {} };
}

function saveManifest(skillsDir: string, manifest: Manifest): void {
  const mp = manifestPath(skillsDir);
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');
}

// ── Validation ───────────────────────────────────────────────────────

const MAX_SKILL_SIZE_BYTES = 1_048_576; // 1MB

function containsSymlinks(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return true;
      if (entry.isDirectory()) {
        if (containsSymlinks(path.join(dir, entry.name))) return true;
      }
    }
  } catch {
    // can't read — safe to proceed
  }
  return false;
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isFile()) {
        total += fs.statSync(fp).size;
      } else if (entry.isDirectory()) {
        total += dirSize(fp);
      }
    }
  } catch {
    // ignore
  }
  return total;
}

function validateSkillDir(dir: string): string | null {
  const skillMd = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    return 'SKILL.md not found in skill directory';
  }
  if (containsSymlinks(dir)) {
    return 'Skill directory contains symlinks (not allowed)';
  }
  if (dirSize(dir) > MAX_SKILL_SIZE_BYTES) {
    return `Skill exceeds ${MAX_SKILL_SIZE_BYTES} byte size limit`;
  }
  return null;
}

// ── Temp directory helpers ───────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dotclaw-skill-'));
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ── Install ──────────────────────────────────────────────────────────

export async function installSkill(params: {
  source: string;
  targetDir: string;
  scope: 'group' | 'global';
}): Promise<{ ok: boolean; name: string; error?: string }> {
  const { source, targetDir } = params;
  fs.mkdirSync(targetDir, { recursive: true });

  const isGitUrl = source.endsWith('.git') || source.includes('github.com/') || source.includes('gitlab.com/');

  let tmpDir: string | null = null;
  try {
    if (isGitUrl) {
      // Git clone
      tmpDir = makeTempDir();
      try {
        execSync(`git clone --depth 1 ${JSON.stringify(source)} ${JSON.stringify(tmpDir)}`, {
          stdio: 'pipe',
          timeout: 60_000,
        });
      } catch (err) {
        return { ok: false, name: '', error: `Git clone failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      // Validate
      const validationError = validateSkillDir(tmpDir);
      if (validationError) {
        return { ok: false, name: '', error: validationError };
      }

      // Extract name from SKILL.md
      const content = fs.readFileSync(path.join(tmpDir, 'SKILL.md'), 'utf-8');
      const name = parseNameFromFrontmatter(content);
      if (!name) {
        return { ok: false, name: '', error: 'SKILL.md must have frontmatter with a "name" field' };
      }

      const version = parseVersionFromFrontmatter(content);
      const destDir = path.join(targetDir, name);

      // Remove existing if present
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }

      // Move from temp to target
      fs.renameSync(tmpDir, destDir);
      tmpDir = null; // don't clean up — it's been moved

      // Remove .git directory from installed skill
      const gitDir = path.join(destDir, '.git');
      if (fs.existsSync(gitDir)) {
        fs.rmSync(gitDir, { recursive: true, force: true });
      }

      // Update manifest
      const manifest = loadManifest(targetDir);
      manifest.skills[name] = {
        source,
        version,
        installed_at: new Date().toISOString(),
      };
      saveManifest(targetDir, manifest);

      return { ok: true, name };
    } else {
      // Raw URL — fetch SKILL.md content
      const response = await fetch(source, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        return { ok: false, name: '', error: `HTTP ${response.status}: ${response.statusText}` };
      }
      const content = await response.text();
      if (content.length > MAX_SKILL_SIZE_BYTES) {
        return { ok: false, name: '', error: `Content exceeds ${MAX_SKILL_SIZE_BYTES} byte size limit` };
      }

      const name = parseNameFromFrontmatter(content);
      if (!name) {
        return { ok: false, name: '', error: 'Content must have YAML frontmatter with a "name" field' };
      }

      const version = parseVersionFromFrontmatter(content);
      const destDir = path.join(targetDir, name);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, 'SKILL.md'), content);

      // Update manifest
      const manifest = loadManifest(targetDir);
      manifest.skills[name] = {
        source,
        version,
        installed_at: new Date().toISOString(),
      };
      saveManifest(targetDir, manifest);

      return { ok: true, name };
    }
  } finally {
    if (tmpDir) rmrf(tmpDir);
  }
}

// ── Remove ───────────────────────────────────────────────────────────

export function removeSkill(params: {
  name: string;
  targetDir: string;
}): { ok: boolean; error?: string } {
  const { name, targetDir } = params;
  const skillDir = path.join(targetDir, name);

  if (!fs.existsSync(skillDir)) {
    return { ok: false, error: `Skill "${name}" not found` };
  }

  fs.rmSync(skillDir, { recursive: true, force: true });

  const manifest = loadManifest(targetDir);
  delete manifest.skills[name];
  saveManifest(targetDir, manifest);

  return { ok: true };
}

// ── List ─────────────────────────────────────────────────────────────

export function listSkills(targetDir: string, scope: 'group' | 'global'): InstalledSkill[] {
  const manifest = loadManifest(targetDir);
  const skills: InstalledSkill[] = [];

  for (const [name, info] of Object.entries(manifest.skills)) {
    skills.push({
      name,
      source: info.source,
      version: info.version,
      installed_at: info.installed_at,
      scope,
    });
  }

  // Also detect unmanifested skills (manually placed directories with SKILL.md)
  if (fs.existsSync(targetDir)) {
    try {
      for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (manifest.skills[entry.name]) continue; // already in manifest
        const skillMd = path.join(targetDir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          skills.push({
            name: entry.name,
            source: 'local',
            version: '0.0.0',
            installed_at: '',
            scope,
          });
        }
      }
    } catch {
      // ignore readdir errors
    }
  }

  return skills;
}

// ── Update ───────────────────────────────────────────────────────────

export async function updateSkill(params: {
  name: string;
  targetDir: string;
  scope: 'group' | 'global';
}): Promise<{ ok: boolean; error?: string }> {
  const manifest = loadManifest(params.targetDir);
  const info = manifest.skills[params.name];

  if (!info) {
    return { ok: false, error: `Skill "${params.name}" not found in manifest (cannot determine source)` };
  }

  if (info.source === 'local') {
    return { ok: false, error: `Skill "${params.name}" was installed locally (no remote source to update from)` };
  }

  const result = await installSkill({
    source: info.source,
    targetDir: params.targetDir,
    scope: params.scope,
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true };
}
