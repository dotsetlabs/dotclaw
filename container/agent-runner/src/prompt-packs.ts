import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const PROMPT_PACK_SCHEMA = z.object({
  name: z.string(),
  version: z.string(),
  behavior: z.string(),
  instructions: z.string(),
  demos: z.array(z.object({
    input: z.string(),
    output: z.any()
  })).default([]),
  metric: z.object({
    name: z.string(),
    model: z.string(),
    score: z.number()
  }).optional(),
  metadata: z.record(z.string(), z.any()).optional()
});

export type PromptPack = z.infer<typeof PROMPT_PACK_SCHEMA>;

export type PromptPackSource = 'group' | 'global';

export type PromptPackLoadResult = {
  pack: PromptPack;
  source: PromptPackSource;
  isCanary?: boolean;
};

function readPromptPack(filePath: string, behavior: string): PromptPack | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const parsed = PROMPT_PACK_SCHEMA.parse(raw);
    if (parsed.behavior !== behavior) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  if (rate > 1) return Math.min(rate / 100, 1);
  return Math.max(0, Math.min(rate, 1));
}

function shouldUseCanary(rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

function getCanaryRate(pack: PromptPack, fallbackRate: number): number {
  const percent = pack.metadata?.canaryPercent;
  if (typeof percent === 'number') {
    return clampRate(percent / 100);
  }
  return clampRate(fallbackRate);
}

export function loadPromptPackWithCanary(params: {
  behavior: string;
  groupDir: string;
  globalDir?: string;
  sharedDir?: string;
  canaryRate: number;
}): PromptPackLoadResult | null {
  const groupPack = readPromptPack(path.join(params.groupDir, 'prompts', `${params.behavior}.json`), params.behavior);
  if (groupPack) return { pack: groupPack, source: 'group' };

  if (params.globalDir) {
    const globalPack = readPromptPack(path.join(params.globalDir, 'prompts', `${params.behavior}.json`), params.behavior);
    if (globalPack) return { pack: globalPack, source: 'global' };
  }

  if (params.sharedDir) {
    const canaryPath = path.join(params.sharedDir, `${params.behavior}.canary.json`);
    const sharedPath = path.join(params.sharedDir, `${params.behavior}.json`);
    const canaryPack = readPromptPack(canaryPath, params.behavior);
    const sharedPack = readPromptPack(sharedPath, params.behavior);

    if (canaryPack && !sharedPack) {
      return { pack: canaryPack, source: 'global', isCanary: true };
    }

    if (canaryPack) {
      const rate = getCanaryRate(canaryPack, params.canaryRate);
      if (shouldUseCanary(rate)) {
        return { pack: canaryPack, source: 'global', isCanary: true };
      }
    }

    if (sharedPack) return { pack: sharedPack, source: 'global', isCanary: false };
  }

  return null;
}

export function formatPromptPack(params: {
  label: string;
  pack: PromptPack;
  maxDemos: number;
  maxChars: number;
}): string {
  const header = `${params.label} (Autotune):`;
  const instructions = params.pack.instructions.trim();
  const demos = params.pack.demos.slice(0, params.maxDemos);

  const demoLines = demos.map((demo) => {
    const output = demo.output === null ? 'null' : JSON.stringify(demo.output);
    return `Input: ${demo.input}\nOutput: ${output}`;
  });

  const block = [
    header,
    instructions,
    demoLines.length > 0 ? `Examples:\n${demoLines.join('\n\n')}` : ''
  ].filter(Boolean).join('\n\n');

  if (block.length <= params.maxChars) return block;

  let trimmed = [header, instructions].join('\n\n');
  if (trimmed.length > params.maxChars) {
    return trimmed.slice(0, params.maxChars);
  }

  for (const demo of demoLines) {
    const candidate = `${trimmed}\n\nExamples:\n${demo}`;
    if (candidate.length > params.maxChars) break;
    trimmed = candidate;
  }

  return trimmed;
}
