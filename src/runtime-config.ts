import fs from 'fs';
import path from 'path';
import {
  TRACES_DIR,
  PROMPTS_DIR,
  TOOL_BUDGETS_PATH,
} from './paths.js';
import { getDotclawHome } from './paths.js';

export type RuntimeConfig = {
  host: {
    logLevel: string;
    defaultModel: string;
    timezone: string;
    bind: string;
    scheduler: {
      pollIntervalMs: number;
      taskMaxRetries: number;
      taskRetryBaseMs: number;
      taskRetryMaxMs: number;
      taskTimeoutMs: number;
    };
    ipc: {
      pollIntervalMs: number;
    };
    container: {
      image: string;
      timeoutMs: number;
      maxOutputBytes: number;
      mode: 'daemon' | 'ephemeral';
      privileged: boolean;
      daemonPollMs: number;
      pidsLimit: number;
      memory: string;
      cpus: string;
      readOnlyRoot: boolean;
      tmpfsSize: string;
      runUid: string;
      runGid: string;
      instanceId: string;
      daemonHeartbeatIntervalMs: number;
      daemon: {
        heartbeatMaxAgeMs: number;
        healthCheckIntervalMs: number;
        gracePeriodMs: number;
      };
    };
    concurrency: {
      maxAgents: number;
      queueTimeoutMs: number;
      warmStart: boolean;
    };
    promptPacksDir: string;
    trace: {
      dir: string;
      sampleRate: number;
      retentionDays: number;
    };
    maintenance: {
      intervalMs: number;
    };
    messageQueue: {
      batchWindowMs: number;
      maxBatchSize: number;
      stalledTimeoutMs: number;
      maxRetries: number;
      retryBaseMs: number;
      retryMaxMs: number;
    };
    metrics: {
      port: number;
      enabled: boolean;
    };
    dashboard: {
      enabled: boolean;
      port: number;
    };
    memory: {
      recall: {
        maxResults: number;
        maxTokens: number;
      };
      embeddings: {
        enabled: boolean;
        provider: 'openrouter' | 'local';
        model: string;
        localModel: string;
        batchSize: number;
        minItems: number;
        minQueryChars: number;
        maxCandidates: number;
        weight: number;
        intervalMs: number;
        maxBacklog: number;
        queryCacheTtlMs: number;
        queryCacheMax: number;
        openrouterBaseUrl: string;
        openrouterSiteUrl: string;
        openrouterSiteName: string;
      };
      maintenance: {
        maxItems: number;
        pruneImportanceThreshold: number;
        vacuumEnabled: boolean;
        vacuumIntervalDays: number;
        analyzeEnabled: boolean;
      };
      personalizationCacheMs: number;
    };
    voice: {
      transcription: {
        enabled: boolean;
        model: string;
        baseUrl: string;
        language: string;
        maxDurationSec: number;
      };
      tts: {
        enabled: boolean;
        model: string;
        baseUrl: string;
        defaultVoice: string;
      };
    };
    telegram: {
      enabled: boolean;
      handlerTimeoutMs: number;
      sendRetries: number;
      sendRetryDelayMs: number;
    };
    discord: {
      enabled: boolean;
      sendRetries: number;
      sendRetryDelayMs: number;
    };
    progress: {
      enabled: boolean;
      initialMs: number;
      intervalMs: number;
      maxUpdates: number;
      messages: string[];
    };
    heartbeat: {
      enabled: boolean;
      intervalMs: number;
      groupFolder: string;
    };
    backgroundJobs: {
      enabled: boolean;
      pollIntervalMs: number;
      maxConcurrent: number;
      maxRuntimeMs: number;
      maxToolSteps: number;
      inlineMaxChars: number;
      contextModeDefault: 'group' | 'isolated';
      toolAllow: string[];
      toolDeny: string[];
      jobRetentionMs: number;
      taskLogRetentionMs: number;
      progress: {
        enabled: boolean;
        startDelayMs: number;
        intervalMs: number;
        maxUpdates: number;
      };
      autoSpawn: {
        enabled: boolean;
        foregroundTimeoutMs: number;
        onTimeout: boolean;
        onToolLimit: boolean;
        classifier: {
          enabled: boolean;
          model: string;
          timeoutMs: number;
          maxOutputTokens: number;
          temperature: number;
          confidenceThreshold: number;
          adaptive?: {
            enabled: boolean;
            minThreshold: number;
            maxThreshold: number;
            queueDepthLow: number;
            queueDepthHigh: number;
          };
        };
      };
    };
    routing: {
      enabled: boolean;
      maxFastChars: number;
      maxStandardChars: number;
      classifierFallback: {
        enabled: boolean;
      };
      plannerProbe: {
        enabled: boolean;
        model: string;
        timeoutMs: number;
        maxOutputTokens: number;
        temperature: number;
        minChars: number;
        minSteps: number;
        minTools: number;
      };
      toolIntentProbe: {
        enabled: boolean;
        model: string;
        timeoutMs: number;
        maxOutputTokens: number;
      };
      profiles: Record<string, {
        model: string;
        maxOutputTokens: number;
        maxToolSteps: number;
        recallMaxResults?: number;
        recallMaxTokens?: number;
        enablePlanner: boolean;
        enableValidation: boolean;
        responseValidationMaxRetries?: number;
        enableMemoryRecall: boolean;
        enableMemoryExtraction: boolean;
        toolAllow?: string[];
        toolDeny?: string[];
        progress?: {
          enabled?: boolean;
          initialMs?: number;
          intervalMs?: number;
          maxUpdates?: number;
          messages?: string[];
        };
      }>;
    };
    toolBudgets: {
      enabled: boolean;
      path: string;
    };
    tokenEstimate: {
      tokensPerChar: number;
      tokensPerMessage: number;
      tokensPerRequest: number;
    };
  };
  agent: {
    assistantName: string;
    openrouter: {
      timeoutMs: number;
      retry: boolean;
      siteUrl: string;
      siteName: string;
    };
    promptPacks: {
      enabled: boolean;
      maxChars: number;
      maxDemos: number;
      canaryRate: number;
    };
    context: {
      maxContextTokens: number;
      compactionTriggerTokens: number;
      recentContextTokens: number;
      summaryUpdateEveryMessages: number;
      maxOutputTokens: number;
      summaryMaxOutputTokens: number;
      temperature: number;
      maxContextMessageTokens: number;
    };
    memory: {
      maxResults: number;
      maxTokens: number;
      extraction: {
        enabled: boolean;
        async: boolean;
        maxMessages: number;
        maxOutputTokens: number;
      };
      archiveSync: boolean;
      extractScheduled: boolean;
    };
    models: {
      summary: string;
      memory: string;
      planner: string;
      responseValidation: string;
      toolSummary: string;
    };
    planner: {
      enabled: boolean;
      mode: string;
      minTokens: number;
      triggerRegex: string;
      maxOutputTokens: number;
      temperature: number;
    };
    responseValidation: {
      enabled: boolean;
      maxOutputTokens: number;
      temperature: number;
      maxRetries: number;
      allowToolCalls: boolean;
      minPromptTokens: number;
      minResponseTokens: number;
    };
    tools: {
      maxToolSteps: number;
      outputLimitBytes: number;
      enableBash: boolean;
      enableWebSearch: boolean;
      enableWebFetch: boolean;
      webfetch: {
        blockPrivate: boolean;
        allowlist: string[];
        blocklist: string[];
        maxBytes: number;
        timeoutMs: number;
      };
      websearch: {
        timeoutMs: number;
      };
      bash: {
        timeoutMs: number;
        outputLimitBytes: number;
      };
      grepMaxFileBytes: number;
      plugin: {
        dirs: string[];
        maxBytes: number;
        httpTimeoutMs: number;
      };
      progress: {
        enabled: boolean;
        minIntervalMs: number;
        notifyTools: string[];
        notifyOnStart: boolean;
        notifyOnError: boolean;
      };
      toolSummary: {
        enabled: boolean;
        maxBytes: number;
        maxOutputTokens: number;
        tools: string[];
      };
    };
    ipc: {
      requestTimeoutMs: number;
      requestPollMs: number;
    };
    tokenEstimate: {
      tokensPerChar: number;
      tokensPerMessage: number;
      tokensPerRequest: number;
    };
    tts: {
      enabled: boolean;
      model: string;
      baseUrl: string;
      defaultVoice: string;
    };
    browser: {
      enabled: boolean;
      timeoutMs: number;
      screenshotQuality: number;
    };
    mcp: {
      enabled: boolean;
      servers: Array<{
        name: string;
        transport: 'stdio';
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
      }>;
      connectionTimeoutMs: number;
    };
    skills: {
      enabled: boolean;
      maxSkills: number;
      maxSummaryChars: number;
      installEnabled: boolean;
    };
  };
  hooks: {
    enabled: boolean;
    scripts: Array<{
      event: string;
      command: string;
      blocking: boolean;
      timeoutMs: number;
    }>;
    maxConcurrent: number;
    defaultTimeoutMs: number;
  };
};

function resolveRuntimeConfigPath(): string {
  const base = getDotclawHome();
  return path.join(base, 'config', 'runtime.json');
}

const DEFAULT_CONTAINER_TIMEOUT_MS = 900_000;
const DEFAULT_TELEGRAM_HANDLER_TIMEOUT_MS = Math.max(DEFAULT_CONTAINER_TIMEOUT_MS + 30_000, 120_000);

const DEFAULT_CONFIG: RuntimeConfig = {
  host: {
    logLevel: 'info',
    defaultModel: 'moonshotai/kimi-k2.5',
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    bind: '127.0.0.1',
    scheduler: {
      pollIntervalMs: 60_000,
      taskMaxRetries: 3,
      taskRetryBaseMs: 60_000,
      taskRetryMaxMs: 3_600_000,
      taskTimeoutMs: 900_000
    },
    ipc: {
      pollIntervalMs: 1_000
    },
    container: {
      image: 'dotclaw-agent:latest',
      timeoutMs: DEFAULT_CONTAINER_TIMEOUT_MS,
      maxOutputBytes: 20 * 1024 * 1024,
      mode: 'daemon',
      privileged: true,
      daemonPollMs: 200,
      pidsLimit: 256,
      memory: '',
      cpus: '',
      readOnlyRoot: false,
      tmpfsSize: '64m',
      runUid: typeof process.getuid === 'function' ? String(process.getuid()) : '',
      runGid: typeof process.getgid === 'function' ? String(process.getgid()) : '',
      instanceId: '',
      daemonHeartbeatIntervalMs: 1_000,
      daemon: {
        heartbeatMaxAgeMs: 30_000,
        healthCheckIntervalMs: 20_000,
        gracePeriodMs: 10_000,
      },
    },
    concurrency: {
      maxAgents: 4,
      queueTimeoutMs: 0,
      warmStart: true
    },
    promptPacksDir: PROMPTS_DIR,
    trace: {
      dir: TRACES_DIR,
      sampleRate: 1,
      retentionDays: 14
    },
    maintenance: {
      intervalMs: 6 * 60 * 60 * 1000
    },
    messageQueue: {
      batchWindowMs: 2000,
      maxBatchSize: 50,
      stalledTimeoutMs: 300_000,
      maxRetries: 4,
      retryBaseMs: 3_000,
      retryMaxMs: 60_000
    },
    metrics: {
      port: 3001,
      enabled: true
    },
    dashboard: {
      enabled: true,
      port: 3002
    },
    memory: {
      recall: {
        maxResults: 8,
        maxTokens: 1000
      },
      embeddings: {
        enabled: true,
        provider: 'local',
        model: 'openai/text-embedding-3-small',
        localModel: 'Xenova/all-MiniLM-L6-v2',
        batchSize: 8,
        minItems: 50,
        minQueryChars: 40,
        maxCandidates: 1500,
        weight: 0.6,
        intervalMs: 600_000,
        maxBacklog: 1000,
        queryCacheTtlMs: 600_000,
        queryCacheMax: 200,
        openrouterBaseUrl: 'https://openrouter.ai/api/v1',
        openrouterSiteUrl: 'https://github.com/dotsetlabs/dotclaw',
        openrouterSiteName: 'DotClaw'
      },
      maintenance: {
        maxItems: 5000,
        pruneImportanceThreshold: 0.3,
        vacuumEnabled: true,
        vacuumIntervalDays: 7,
        analyzeEnabled: true
      },
      personalizationCacheMs: 300_000
    },
    voice: {
      transcription: {
        enabled: true,
        model: 'google/gemini-2.5-flash',
        baseUrl: 'https://openrouter.ai/api/v1',
        language: '',
        maxDurationSec: 300,
      },
      tts: {
        enabled: true,
        model: 'edge-tts',
        baseUrl: '',
        defaultVoice: 'en-US-AriaNeural',
      }
    },
    telegram: {
      enabled: true,
      handlerTimeoutMs: DEFAULT_TELEGRAM_HANDLER_TIMEOUT_MS,
      sendRetries: 3,
      sendRetryDelayMs: 1000,
    },
    discord: {
      enabled: false,
      sendRetries: 3,
      sendRetryDelayMs: 1000,
    },
    progress: {
      enabled: true,
      initialMs: 12_000,
      intervalMs: 45_000,
      maxUpdates: 3,
      messages: []
    },
    heartbeat: {
      enabled: false,
      intervalMs: 3_600_000,
      groupFolder: 'main'
    },
    backgroundJobs: {
      enabled: true,
      pollIntervalMs: 2000,
      maxConcurrent: 2,
      maxRuntimeMs: 2_400_000,
      maxToolSteps: 256,
      inlineMaxChars: 8000,
      contextModeDefault: 'group',
      toolAllow: [],
      toolDeny: [
        'mcp__dotclaw__schedule_task',
        'mcp__dotclaw__update_task',
        'mcp__dotclaw__pause_task',
        'mcp__dotclaw__resume_task',
        'mcp__dotclaw__cancel_task',
        'mcp__dotclaw__spawn_job'
      ],
      jobRetentionMs: 604_800_000,
      taskLogRetentionMs: 2_592_000_000,
      progress: {
        enabled: false,
        startDelayMs: 30_000,
        intervalMs: 120_000,
        maxUpdates: 3
      },
      autoSpawn: {
        enabled: true,
        foregroundTimeoutMs: 90_000,
        onTimeout: true,
        onToolLimit: true,
        classifier: {
          enabled: true,
          model: 'deepseek/deepseek-v3.2',
          timeoutMs: 3000,
          maxOutputTokens: 32,
          temperature: 0,
          confidenceThreshold: 0.6,
          adaptive: {
            enabled: true,
            minThreshold: 0.55,
            maxThreshold: 0.65,
            queueDepthLow: 0,
            queueDepthHigh: 4
          }
        }
      }
    },
    routing: {
      enabled: true,
      maxFastChars: 200,
      maxStandardChars: 1200,
      classifierFallback: {
        enabled: true,
      },
      plannerProbe: {
        enabled: true,
        model: 'deepseek/deepseek-v3.2',
        timeoutMs: 3000,
        maxOutputTokens: 120,
        temperature: 0,
        minChars: 700,
        minSteps: 4,
        minTools: 3
      },
      toolIntentProbe: {
        enabled: true,
        model: 'deepseek/deepseek-v3.2',
        timeoutMs: 2000,
        maxOutputTokens: 8,
      },
      profiles: {
        fast: {
          model: 'deepseek/deepseek-v3.2',
          maxOutputTokens: 4096,
          maxToolSteps: 12,
          recallMaxResults: 0,
          recallMaxTokens: 0,
          enablePlanner: false,
          enableValidation: false,
          responseValidationMaxRetries: 0,
          enableMemoryRecall: false,
          enableMemoryExtraction: false,
          toolAllow: [],
          toolDeny: [],
          progress: {
            enabled: false
          }
        },
        standard: {
          model: 'moonshotai/kimi-k2.5',
          maxOutputTokens: 4096,
          maxToolSteps: 48,
          recallMaxResults: 6,
          recallMaxTokens: 1500,
          enablePlanner: true,
          enableValidation: true,
          responseValidationMaxRetries: 1,
          enableMemoryRecall: true,
          enableMemoryExtraction: true,
          toolAllow: [],
          toolDeny: []
        },
        deep: {
          model: 'moonshotai/kimi-k2.5',
          maxOutputTokens: 4096,
          maxToolSteps: 128,
          recallMaxResults: 12,
          recallMaxTokens: 2500,
          enablePlanner: true,
          enableValidation: true,
          responseValidationMaxRetries: 2,
          enableMemoryRecall: true,
          enableMemoryExtraction: true,
          toolAllow: [],
          toolDeny: []
        },
        background: {
          model: 'moonshotai/kimi-k2.5',
          maxOutputTokens: 4096,
          maxToolSteps: 256,
          recallMaxResults: 16,
          recallMaxTokens: 4000,
          enablePlanner: true,
          enableValidation: true,
          responseValidationMaxRetries: 2,
          enableMemoryRecall: true,
          enableMemoryExtraction: true,
          toolAllow: [],
          toolDeny: [],
          progress: {
            enabled: true,
            initialMs: 15_000,
            intervalMs: 60_000,
            maxUpdates: 3
          }
        }
      }
    },
    toolBudgets: {
      enabled: false,
      path: TOOL_BUDGETS_PATH
    },
    tokenEstimate: {
      tokensPerChar: 0.25,
      tokensPerMessage: 3,
      tokensPerRequest: 0
    }
  },
  agent: {
    assistantName: 'Rain',
    openrouter: {
      timeoutMs: 180_000,
      retry: true,
      siteUrl: 'https://github.com/dotsetlabs/dotclaw',
      siteName: 'DotClaw'
    },
    promptPacks: {
      enabled: true,
      maxChars: 6000,
      maxDemos: 4,
      canaryRate: 0.1
    },
    context: {
      maxContextTokens: 24_000,
      compactionTriggerTokens: 20_000,
      recentContextTokens: 8000,
      summaryUpdateEveryMessages: 20,
      maxOutputTokens: 1024,
      summaryMaxOutputTokens: 2048,
      temperature: 0.2,
      maxContextMessageTokens: 3000
    },
    memory: {
      maxResults: 6,
      maxTokens: 2000,
      extraction: {
        enabled: true,
        async: true,
        maxMessages: 4,
        maxOutputTokens: 1024
      },
      archiveSync: true,
      extractScheduled: false
    },
    models: {
      summary: 'deepseek/deepseek-v3.2',
      memory: 'deepseek/deepseek-v3.2',
      planner: 'deepseek/deepseek-v3.2',
      responseValidation: 'deepseek/deepseek-v3.2',
      toolSummary: 'deepseek/deepseek-v3.2'
    },
    planner: {
      enabled: true,
      mode: 'auto',
      minTokens: 800,
      triggerRegex: '(plan|steps|roadmap|research|design|architecture|spec|strategy)',
      maxOutputTokens: 1024,
      temperature: 0.2
    },
    responseValidation: {
      enabled: true,
      maxOutputTokens: 1024,
      temperature: 0,
      maxRetries: 1,
      allowToolCalls: false,
      minPromptTokens: 400,
      minResponseTokens: 160
    },
    tools: {
      maxToolSteps: 96,
      outputLimitBytes: 400_000,
      enableBash: true,
      enableWebSearch: true,
      enableWebFetch: true,
      webfetch: {
        blockPrivate: true,
        allowlist: [],
        blocklist: ['localhost', '127.0.0.1'],
        maxBytes: 300_000,
        timeoutMs: 20_000
      },
      websearch: {
        timeoutMs: 20_000
      },
      bash: {
        timeoutMs: 120_000,
        outputLimitBytes: 200_000
      },
      grepMaxFileBytes: 1_000_000,
      plugin: {
        dirs: [],
        maxBytes: 800_000,
        httpTimeoutMs: 20_000
      },
      progress: {
        enabled: true,
        minIntervalMs: 30_000,
        notifyTools: [],
        notifyOnStart: false,
        notifyOnError: false
      },
      toolSummary: {
        enabled: true,
        maxBytes: 60_000,
        maxOutputTokens: 400,
        tools: ['WebFetch']
      }
    },
    ipc: {
      requestTimeoutMs: 30_000,
      requestPollMs: 150
    },
    tokenEstimate: {
      tokensPerChar: 0.25,
      tokensPerMessage: 3,
      tokensPerRequest: 0
    },
    tts: {
      enabled: true,
      model: 'edge-tts',
      baseUrl: '',
      defaultVoice: 'en-US-AriaNeural'
    },
    browser: {
      enabled: true,
      timeoutMs: 30_000,
      screenshotQuality: 80
    },
    mcp: {
      enabled: false,
      servers: [],
      connectionTimeoutMs: 10_000
    },
    skills: {
      enabled: true,
      maxSkills: 32,
      maxSummaryChars: 4000,
      installEnabled: true,
    }
  },
  hooks: {
    enabled: false,
    scripts: [],
    maxConcurrent: 4,
    defaultTimeoutMs: 5000
  }
};

function clampMin(value: number, min: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    console.warn(`[runtime-config] ${label} = ${value} is invalid, clamping to ${min}`);
    return min;
  }
  return value;
}

function validateRuntimeConfig(config: RuntimeConfig): void {
  const h = config.host;

  // Scheduler
  h.scheduler.pollIntervalMs = clampMin(h.scheduler.pollIntervalMs, 1000, 'host.scheduler.pollIntervalMs');
  h.scheduler.taskMaxRetries = clampMin(h.scheduler.taskMaxRetries, 0, 'host.scheduler.taskMaxRetries');
  h.scheduler.taskRetryBaseMs = clampMin(h.scheduler.taskRetryBaseMs, 100, 'host.scheduler.taskRetryBaseMs');
  h.scheduler.taskTimeoutMs = clampMin(h.scheduler.taskTimeoutMs, 1000, 'host.scheduler.taskTimeoutMs');

  // Container
  h.container.timeoutMs = clampMin(h.container.timeoutMs, 1000, 'host.container.timeoutMs');
  if (h.container.mode !== 'daemon' && h.container.mode !== 'ephemeral') {
    console.warn(`[runtime-config] host.container.mode = "${h.container.mode}" is invalid, defaulting to "daemon"`);
    h.container.mode = 'daemon';
  }
  h.container.daemon.heartbeatMaxAgeMs = clampMin(h.container.daemon.heartbeatMaxAgeMs, 1000, 'host.container.daemon.heartbeatMaxAgeMs');
  h.container.daemon.healthCheckIntervalMs = clampMin(h.container.daemon.healthCheckIntervalMs, 1000, 'host.container.daemon.healthCheckIntervalMs');

  // Concurrency
  h.concurrency.maxAgents = clampMin(h.concurrency.maxAgents, 1, 'host.concurrency.maxAgents');

  // Maintenance
  h.maintenance.intervalMs = clampMin(h.maintenance.intervalMs, 60_000, 'host.maintenance.intervalMs');

  // Message queue
  h.messageQueue.batchWindowMs = clampMin(h.messageQueue.batchWindowMs, 0, 'host.messageQueue.batchWindowMs');
  h.messageQueue.maxRetries = clampMin(h.messageQueue.maxRetries, 0, 'host.messageQueue.maxRetries');

  // Background jobs
  h.backgroundJobs.maxConcurrent = clampMin(h.backgroundJobs.maxConcurrent, 1, 'host.backgroundJobs.maxConcurrent');
  h.backgroundJobs.maxRuntimeMs = clampMin(h.backgroundJobs.maxRuntimeMs, 1000, 'host.backgroundJobs.maxRuntimeMs');

  // Hooks
  config.hooks.maxConcurrent = clampMin(config.hooks.maxConcurrent, 1, 'hooks.maxConcurrent');
  config.hooks.defaultTimeoutMs = clampMin(config.hooks.defaultTimeoutMs, 100, 'hooks.defaultTimeoutMs');

  // Model names
  if (!h.defaultModel || typeof h.defaultModel !== 'string') {
    console.warn('[runtime-config] host.defaultModel is empty, using default');
    h.defaultModel = 'moonshotai/kimi-k2.5';
  }

  // Agent IPC
  config.agent.ipc.requestTimeoutMs = clampMin(config.agent.ipc.requestTimeoutMs, 1000, 'agent.ipc.requestTimeoutMs');
  config.agent.ipc.requestPollMs = clampMin(config.agent.ipc.requestPollMs, 10, 'agent.ipc.requestPollMs');
}

let cachedConfig: RuntimeConfig | null = null;
let cachedHome: string | null = null;

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasTelegramHandlerOverride(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const host = value.host;
  if (!isPlainObject(host)) return false;
  const telegram = host.telegram;
  if (!isPlainObject(telegram)) return false;
  return typeof telegram.handlerTimeoutMs === 'number';
}

function mergeDefaults<T>(base: T, overrides: unknown): T {
  if (!isPlainObject(overrides)) return cloneConfig(base);
  const result = cloneConfig(base) as Record<string, unknown>;
  const baseObj = base as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    const current = baseObj[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = mergeDefaults(current, value);
      continue;
    }
    if (Array.isArray(current) && Array.isArray(value)) {
      result[key] = value;
      continue;
    }
    if (typeof value === typeof current) {
      result[key] = value as unknown;
    }
  }
  return result as T;
}

function readJson(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getRuntimeConfigPath(): string {
  return resolveRuntimeConfigPath();
}

export function loadRuntimeConfig(): RuntimeConfig {
  const currentHome = process.env.DOTCLAW_HOME || null;
  if (cachedConfig && cachedHome === currentHome) return cachedConfig;
  const fromFile = readJson(resolveRuntimeConfigPath());
  const merged = fromFile ? mergeDefaults(DEFAULT_CONFIG, fromFile) : cloneConfig(DEFAULT_CONFIG);
  if (!hasTelegramHandlerOverride(fromFile)) {
    merged.host.telegram.handlerTimeoutMs = Math.max(merged.host.container.timeoutMs + 30_000, 120_000);
  }
  validateRuntimeConfig(merged);
  cachedConfig = merged;
  cachedHome = currentHome;
  return merged;
}
