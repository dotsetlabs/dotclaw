import path from 'path';
import fs from 'fs';
import { getDotclawHome } from './paths.js';
import { logger } from './logger.js';

const MODELS_DIR = path.join(getDotclawHome(), 'data', 'models');
const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

type Pipeline = (texts: string[], options?: { pooling: string; normalize: boolean }) => Promise<{ tolist: () => number[][] }>;

let pipeline: Pipeline | null = null;
let loadingPromise: Promise<Pipeline> | null = null;

async function loadPipeline(model: string): Promise<Pipeline> {
  if (pipeline) return pipeline;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    fs.mkdirSync(MODELS_DIR, { recursive: true });

    // Dynamic import to avoid requiring the dependency at startup
    const { pipeline: createPipeline, env } = await import('@huggingface/transformers');

    // Cache models in our data directory
    env.cacheDir = MODELS_DIR;
    // Disable remote model fetching warnings in production
    env.allowRemoteModels = true;

    logger.info({ model }, 'Loading local embedding model');
    const pipe = await createPipeline('feature-extraction', model);
    logger.info({ model }, 'Local embedding model loaded');

    pipeline = pipe as unknown as Pipeline;
    return pipeline;
  })();

  try {
    return await loadingPromise;
  } catch (err) {
    loadingPromise = null;
    throw err;
  }
}

export class LocalEmbeddingProvider {
  private model: string;

  constructor(model?: string) {
    this.model = model || DEFAULT_MODEL;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const pipe = await loadPipeline(this.model);
    const output = await pipe(texts, { pooling: 'mean', normalize: true });
    return output.tolist();
  }

  async dispose(): Promise<void> {
    // Wait for any in-flight loading to complete before disposing
    if (loadingPromise) {
      try { await loadingPromise; } catch { /* ignore load errors during dispose */ }
    }
    pipeline = null;
    loadingPromise = null;
  }
}
