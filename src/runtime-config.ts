import fs from 'fs';
import {
  RUNTIME_CONFIG_PATH,
  TRACES_DIR,
  PROMPTS_DIR,
  TOOL_BUDGETS_PATH,
} from './paths.js';

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
    };
    ipc: {
      pollIntervalMs: number;
    };
    container: {
      image: string;
      timeoutMs: number;
      maxOutputBytes: number;
      mode: 'daemon' | 'ephemeral';
      daemonPollMs: number;
      pidsLimit: number;
      memory: string;
      cpus: string;
      readOnlyRoot: boolean;
      tmpfsSize: string;
      runUid: string;
      runGid: string;
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
    metrics: {
      port: number;
      enabled: boolean;
    };
    dashboard: {
      enabled: boolean;
    };
    memory: {
      recall: {
        maxResults: number;
        maxTokens: number;
      };
      embeddings: {
        enabled: boolean;
        model: string;
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
    telegram: {
      handlerTimeoutMs: number;
      sendRetries: number;
      sendRetryDelayMs: number;
      streamMode: string;
      streamMinIntervalMs: number;
      streamMinChars: number;
      inputMessageMaxChars: number;
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
        };
      };
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
      toolSummary: {
        enabled: boolean;
        maxBytes: number;
        maxOutputTokens: number;
        tools: string[];
      };
    };
    streaming: {
      minIntervalMs: number;
      minChars: number;
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
  };
};

// CONFIG_PATH is now imported from paths.js as RUNTIME_CONFIG_PATH
const CONFIG_PATH = RUNTIME_CONFIG_PATH;

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
      taskRetryMaxMs: 3_600_000
    },
    ipc: {
      pollIntervalMs: 1_000
    },
    container: {
      image: 'dotclaw-agent:latest',
      timeoutMs: DEFAULT_CONTAINER_TIMEOUT_MS,
      maxOutputBytes: 20 * 1024 * 1024,
      mode: 'daemon',
      daemonPollMs: 200,
      pidsLimit: 256,
      memory: '',
      cpus: '',
      readOnlyRoot: false,
      tmpfsSize: '64m',
      runUid: typeof process.getuid === 'function' ? String(process.getuid()) : '',
      runGid: typeof process.getgid === 'function' ? String(process.getgid()) : ''
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
    metrics: {
      port: 3001,
      enabled: true
    },
    dashboard: {
      enabled: true
    },
    memory: {
      recall: {
        maxResults: 8,
        maxTokens: 1000
      },
      embeddings: {
        enabled: true,
        model: 'openai/text-embedding-3-small',
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
        openrouterSiteUrl: '',
        openrouterSiteName: ''
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
    telegram: {
      handlerTimeoutMs: DEFAULT_TELEGRAM_HANDLER_TIMEOUT_MS,
      sendRetries: 3,
      sendRetryDelayMs: 1000,
      streamMode: 'off',
      streamMinIntervalMs: 800,
      streamMinChars: 120,
      inputMessageMaxChars: 4000
    },
    progress: {
      enabled: true,
      initialMs: 60_000,
      intervalMs: 120_000,
      maxUpdates: 1,
      messages: []
    },
    heartbeat: {
      enabled: true,
      intervalMs: 900_000,
      groupFolder: 'main'
    },
    backgroundJobs: {
      enabled: true,
      pollIntervalMs: 2000,
      maxConcurrent: 2,
      maxRuntimeMs: 2_400_000,
      maxToolSteps: 64,
      inlineMaxChars: 8000,
      contextModeDefault: 'group',
      toolAllow: [],
      toolDeny: [
        'mcp__dotclaw__schedule_task',
        'mcp__dotclaw__update_task',
        'mcp__dotclaw__pause_task',
        'mcp__dotclaw__resume_task',
        'mcp__dotclaw__cancel_task'
      ],
      autoSpawn: {
        enabled: true,
        foregroundTimeoutMs: 180_000,
        onTimeout: true,
        onToolLimit: true,
        classifier: {
          enabled: true,
          model: 'openai/gpt-5-nano',
          timeoutMs: 3000,
          maxOutputTokens: 32,
          temperature: 0,
          confidenceThreshold: 0.6
        }
      }
    },
    toolBudgets: {
      enabled: true,
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
      siteUrl: '',
      siteName: ''
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
      summaryMaxOutputTokens: 600,
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
        maxOutputTokens: 200
      },
      archiveSync: true,
      extractScheduled: false
    },
    models: {
      summary: 'openai/gpt-5-nano',
      memory: 'openai/gpt-5-mini',
      planner: 'openai/gpt-5-nano',
      responseValidation: 'openai/gpt-5-nano',
      toolSummary: 'openai/gpt-5-nano'
    },
    planner: {
      enabled: true,
      mode: 'auto',
      minTokens: 600,
      triggerRegex: '(plan|steps|roadmap|research|design|architecture|spec|strategy)',
      maxOutputTokens: 200,
      temperature: 0.2
    },
    responseValidation: {
      enabled: true,
      maxOutputTokens: 120,
      temperature: 0,
      maxRetries: 1,
      allowToolCalls: false
    },
    tools: {
      maxToolSteps: 24,
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
      toolSummary: {
        enabled: true,
        maxBytes: 60_000,
        maxOutputTokens: 400,
        tools: ['WebFetch']
      }
    },
    streaming: {
      minIntervalMs: 800,
      minChars: 120
    },
    ipc: {
      requestTimeoutMs: 6000,
      requestPollMs: 150
    },
    tokenEstimate: {
      tokensPerChar: 0.25,
      tokensPerMessage: 3,
      tokensPerRequest: 0
    }
  }
};

let cachedConfig: RuntimeConfig | null = null;

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
  return CONFIG_PATH;
}

export function loadRuntimeConfig(): RuntimeConfig {
  if (cachedConfig) return cachedConfig;
  const fromFile = readJson(CONFIG_PATH);
  const merged = fromFile ? mergeDefaults(DEFAULT_CONFIG, fromFile) : cloneConfig(DEFAULT_CONFIG);
  if (!hasTelegramHandlerOverride(fromFile)) {
    merged.host.telegram.handlerTimeoutMs = Math.max(merged.host.container.timeoutMs + 30_000, 120_000);
  }
  cachedConfig = merged;
  return merged;
}
