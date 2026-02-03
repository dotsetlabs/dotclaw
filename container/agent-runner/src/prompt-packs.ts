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

export function loadPromptPack(params: {
  behavior: string;
  groupDir: string;
  globalDir?: string;
}): { pack: PromptPack; source: PromptPackSource } | null {
  const filenames = [`${params.behavior}.json`];
  const searchDirs: Array<{ dir: string; source: PromptPackSource }> = [
    { dir: path.join(params.groupDir, 'prompts'), source: 'group' }
  ];
  if (params.globalDir) {
    searchDirs.push({ dir: path.join(params.globalDir, 'prompts'), source: 'global' });
  }

  for (const { dir, source } of searchDirs) {
    for (const filename of filenames) {
      const filePath = path.join(dir, filename);
      if (!fs.existsSync(filePath)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const parsed = PROMPT_PACK_SCHEMA.parse(raw);
        if (parsed.behavior !== params.behavior) continue;
        return { pack: parsed, source };
      } catch {
        continue;
      }
    }
  }

  return null;
}

export function formatTaskExtractionPack(params: {
  pack: PromptPack;
  maxDemos: number;
  maxChars: number;
}): string {
  const instructions = params.pack.instructions.trim();
  const demos = params.pack.demos.slice(0, params.maxDemos);

  const demoLines = demos.map((demo) => {
    const output = demo.output === null ? 'null' : JSON.stringify(demo.output);
    return `Input: ${demo.input}\nOutput: ${output}`;
  });

  const block = [
    'Task Extraction Guidelines (DSTy):',
    instructions,
    demoLines.length > 0 ? `Examples:\n${demoLines.join('\n\n')}` : ''
  ].filter(Boolean).join('\n\n');

  if (block.length <= params.maxChars) return block;

  // Truncate demos if block exceeds max size
  let trimmed = ['Task Extraction Guidelines (DSTy):', instructions].join('\n\n');
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
