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
      laneStarvationMs: number;
      maxConsecutiveInteractive: number;
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
      interruptOnNewMessage: boolean;
      promptMaxChars: number;
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
        minScore: number;
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
      backend: {
        strategy: 'builtin' | 'module';
        modulePath: string;
      };
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
    routing: {
      model: string;
      fallbacks: string[];
      allowedModels: string[];
      maxOutputTokens: number;
      maxToolSteps: number;
      temperature?: number;
      recallMaxResults: number;
      recallMaxTokens: number;
      hostFailover: {
        enabled: boolean;
        maxRetries: number;
        cooldownRateLimitMs: number;
        cooldownTransientMs: number;
        cooldownInvalidResponseMs: number;
      };
    };
    streaming: {
      enabled: boolean;
      chunkFlushIntervalMs: number;
      editIntervalMs: number;
      maxEditLength: number;
    };
    webhook: {
      enabled: boolean;
      port: number;
      token: string;
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
      maxHistoryTurns: number;
      contextPruning: {
        softTrimMaxChars: number;
        softTrimHeadChars: number;
        softTrimTailChars: number;
        keepLastAssistant: number;
      };
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
    };
    tools: {
      maxToolSteps: number;
      outputLimitBytes: number;
      enableBash: boolean;
      enableWebSearch: boolean;
      enableWebFetch: boolean;
      completionGuard: {
        idempotentRetryAttempts: number;
        idempotentRetryBackoffMs: number;
        repeatedSignatureThreshold: number;
        repeatedRoundThreshold: number;
        nonRetryableFailureThreshold: number;
        forceSynthesisAfterTools: boolean;
      };
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
      provider: 'edge-tts' | 'openai';
      openaiModel: string;
      openaiVoice: string;
    };
    process: {
      maxSessions: number;
      maxOutputBytes: number;
      defaultTimeoutMs: number;
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
    reasoning: {
      effort: 'off' | 'low' | 'medium' | 'high';
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
      daemonPollMs: 100,
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
      warmStart: true,
      laneStarvationMs: 15_000,
      maxConsecutiveInteractive: 3
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
      retryMaxMs: 60_000,
      interruptOnNewMessage: true,
      promptMaxChars: 24_000
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
        maxTokens: 1000,
        minScore: 0.35
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
      personalizationCacheMs: 300_000,
      backend: {
        strategy: 'builtin',
        modulePath: ''
      }
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
    routing: {
      model: 'moonshotai/kimi-k2.5',
      fallbacks: [],
      allowedModels: [],
      maxOutputTokens: 0,
      maxToolSteps: 200,
      temperature: 0.6,
      recallMaxResults: 8,
      recallMaxTokens: 1500,
      hostFailover: {
        enabled: true,
        maxRetries: 1,
        cooldownRateLimitMs: 60_000,
        cooldownTransientMs: 300_000,
        cooldownInvalidResponseMs: 120_000,
      }
    },
    streaming: {
      enabled: true,
      chunkFlushIntervalMs: 120,
      editIntervalMs: 400,
      maxEditLength: 3800,
    },
    webhook: {
      enabled: false,
      port: 3003,
      token: '',
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
      maxContextTokens: 128_000,
      compactionTriggerTokens: 120_000,
      recentContextTokens: 0, // 0 = auto: 35% of model context window (capped at 24K)
      summaryUpdateEveryMessages: 20,
      maxOutputTokens: 8192,
      summaryMaxOutputTokens: 2048,
      temperature: 0.6,
      maxContextMessageTokens: 4000,
      maxHistoryTurns: 40,
      contextPruning: {
        softTrimMaxChars: 4_000,
        softTrimHeadChars: 1_500,
        softTrimTailChars: 1_500,
        keepLastAssistant: 10,
      },
    },
    memory: {
      maxResults: 4,
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
    },
    tools: {
      maxToolSteps: 200,
      outputLimitBytes: 400_000,
      enableBash: true,
      enableWebSearch: true,
      enableWebFetch: true,
      completionGuard: {
        idempotentRetryAttempts: 2,
        idempotentRetryBackoffMs: 500,
        repeatedSignatureThreshold: 3,
        repeatedRoundThreshold: 2,
        nonRetryableFailureThreshold: 3,
        forceSynthesisAfterTools: true
      },
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
        timeoutMs: 600_000,
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
      defaultVoice: 'en-US-AriaNeural',
      provider: 'edge-tts',
      openaiModel: 'tts-1',
      openaiVoice: 'alloy',
    },
    process: {
      maxSessions: 16,
      maxOutputBytes: 1_048_576,
      defaultTimeoutMs: 1_800_000,
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
    reasoning: {
      effort: 'medium',
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
  h.container.daemonPollMs = clampMin(h.container.daemonPollMs, 25, 'host.container.daemonPollMs');
  if (h.container.mode !== 'daemon' && h.container.mode !== 'ephemeral') {
    console.warn(`[runtime-config] host.container.mode = "${h.container.mode}" is invalid, defaulting to "daemon"`);
    h.container.mode = 'daemon';
  }
  h.container.daemon.heartbeatMaxAgeMs = clampMin(h.container.daemon.heartbeatMaxAgeMs, 1000, 'host.container.daemon.heartbeatMaxAgeMs');
  h.container.daemon.healthCheckIntervalMs = clampMin(h.container.daemon.healthCheckIntervalMs, 1000, 'host.container.daemon.healthCheckIntervalMs');

  // Concurrency
  h.concurrency.maxAgents = clampMin(h.concurrency.maxAgents, 1, 'host.concurrency.maxAgents');
  h.concurrency.laneStarvationMs = clampMin(h.concurrency.laneStarvationMs, 1000, 'host.concurrency.laneStarvationMs');
  h.concurrency.maxConsecutiveInteractive = clampMin(h.concurrency.maxConsecutiveInteractive, 1, 'host.concurrency.maxConsecutiveInteractive');

  // Maintenance
  h.maintenance.intervalMs = clampMin(h.maintenance.intervalMs, 60_000, 'host.maintenance.intervalMs');

  // Message queue
  h.messageQueue.batchWindowMs = clampMin(h.messageQueue.batchWindowMs, 0, 'host.messageQueue.batchWindowMs');
  h.messageQueue.maxRetries = clampMin(h.messageQueue.maxRetries, 0, 'host.messageQueue.maxRetries');
  h.messageQueue.promptMaxChars = clampMin(h.messageQueue.promptMaxChars, 2000, 'host.messageQueue.promptMaxChars');

  // Routing
  h.routing.maxOutputTokens = clampMin(h.routing.maxOutputTokens, 0, 'host.routing.maxOutputTokens');
  h.routing.maxToolSteps = clampMin(h.routing.maxToolSteps, 1, 'host.routing.maxToolSteps');
  h.routing.recallMaxResults = clampMin(h.routing.recallMaxResults, 0, 'host.routing.recallMaxResults');
  h.routing.recallMaxTokens = clampMin(h.routing.recallMaxTokens, 0, 'host.routing.recallMaxTokens');
  h.routing.hostFailover.maxRetries = clampMin(h.routing.hostFailover.maxRetries, 0, 'host.routing.hostFailover.maxRetries');
  h.routing.hostFailover.cooldownRateLimitMs = clampMin(h.routing.hostFailover.cooldownRateLimitMs, 0, 'host.routing.hostFailover.cooldownRateLimitMs');
  h.routing.hostFailover.cooldownTransientMs = clampMin(h.routing.hostFailover.cooldownTransientMs, 0, 'host.routing.hostFailover.cooldownTransientMs');
  h.routing.hostFailover.cooldownInvalidResponseMs = clampMin(h.routing.hostFailover.cooldownInvalidResponseMs, 0, 'host.routing.hostFailover.cooldownInvalidResponseMs');

  // Streaming
  h.streaming.chunkFlushIntervalMs = clampMin(h.streaming.chunkFlushIntervalMs, 25, 'host.streaming.chunkFlushIntervalMs');
  h.streaming.editIntervalMs = clampMin(h.streaming.editIntervalMs, 100, 'host.streaming.editIntervalMs');
  h.streaming.maxEditLength = clampMin(h.streaming.maxEditLength, 100, 'host.streaming.maxEditLength');

  // Memory recall
  if (typeof h.memory.recall.minScore === 'number') {
    h.memory.recall.minScore = Math.min(1, Math.max(0, h.memory.recall.minScore));
  }
  if (h.memory.backend.strategy !== 'builtin' && h.memory.backend.strategy !== 'module') {
    console.warn(`[runtime-config] host.memory.backend.strategy = "${h.memory.backend.strategy}" is invalid, defaulting to "builtin"`);
    h.memory.backend.strategy = 'builtin';
  }
  if (typeof h.memory.backend.modulePath !== 'string') {
    h.memory.backend.modulePath = '';
  }

  // Webhook
  h.webhook.port = clampMin(h.webhook.port, 1024, 'host.webhook.port');
  if (h.webhook.enabled && !h.webhook.token) {
    console.warn('[runtime-config] host.webhook.enabled but token is empty — auth will reject all requests');
  }

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
  if (config.agent.tts.provider !== 'edge-tts' && config.agent.tts.provider !== 'openai') {
    console.warn(`[runtime-config] agent.tts.provider = "${config.agent.tts.provider}" is invalid, defaulting to "edge-tts"`);
    config.agent.tts.provider = 'edge-tts';
  }
  config.agent.process.maxSessions = clampMin(config.agent.process.maxSessions, 1, 'agent.process.maxSessions');
  config.agent.process.maxOutputBytes = clampMin(config.agent.process.maxOutputBytes, 1024, 'agent.process.maxOutputBytes');
  config.agent.process.defaultTimeoutMs = clampMin(config.agent.process.defaultTimeoutMs, 1000, 'agent.process.defaultTimeoutMs');
  config.agent.tools.completionGuard.idempotentRetryAttempts = clampMin(
    config.agent.tools.completionGuard.idempotentRetryAttempts,
    1,
    'agent.tools.completionGuard.idempotentRetryAttempts'
  );
  config.agent.tools.completionGuard.idempotentRetryBackoffMs = clampMin(
    config.agent.tools.completionGuard.idempotentRetryBackoffMs,
    0,
    'agent.tools.completionGuard.idempotentRetryBackoffMs'
  );
  config.agent.tools.completionGuard.repeatedSignatureThreshold = clampMin(
    config.agent.tools.completionGuard.repeatedSignatureThreshold,
    2,
    'agent.tools.completionGuard.repeatedSignatureThreshold'
  );
  config.agent.tools.completionGuard.repeatedRoundThreshold = clampMin(
    config.agent.tools.completionGuard.repeatedRoundThreshold,
    2,
    'agent.tools.completionGuard.repeatedRoundThreshold'
  );
  config.agent.tools.completionGuard.nonRetryableFailureThreshold = clampMin(
    config.agent.tools.completionGuard.nonRetryableFailureThreshold,
    1,
    'agent.tools.completionGuard.nonRetryableFailureThreshold'
  );
}

let cachedConfig: RuntimeConfig | null = null;
let cachedHome: string | null = null;
let cachedMtime: number | null = null;

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

function mergeDefaults<T>(base: T, overrides: unknown, pathPrefix = ''): T {
  if (!isPlainObject(overrides)) return cloneConfig(base);
  const result = cloneConfig(base) as Record<string, unknown>;
  const baseObj = base as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    const current = baseObj[key];
    const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = mergeDefaults(current, value, fullPath);
      continue;
    }
    if (Array.isArray(current) && Array.isArray(value)) {
      result[key] = value;
      continue;
    }
    if (current !== undefined && typeof value !== typeof current) {
      console.warn(`[runtime-config] ${fullPath}: expected ${typeof current}, got ${typeof value}. Using default.`);
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

function clearRuntimeConfigCacheIfNeeded(configPath: string): void {
  const activePath = resolveRuntimeConfigPath();
  if (path.resolve(configPath) !== path.resolve(activePath)) return;
  cachedConfig = null;
  cachedMtime = null;
}

function stripDeprecatedRuntimeKeys(config: Record<string, unknown>): void {
  const host = config.host;
  if (!isPlainObject(host)) return;
  if (Object.prototype.hasOwnProperty.call(host, 'backgroundJobs')) {
    delete host.backgroundJobs;
  }
  const routing = host.routing;
  if (isPlainObject(routing) && Object.prototype.hasOwnProperty.call(routing, 'profiles')) {
    delete routing.profiles;
  }
}

export function readRuntimeConfigDocument(configPath = resolveRuntimeConfigPath()): Record<string, unknown> {
  const parsed = readJson(configPath);
  if (!isPlainObject(parsed)) return {};
  return parsed;
}

export function writeRuntimeConfigDocument(
  document: Record<string, unknown>,
  configPath = resolveRuntimeConfigPath()
): void {
  const normalized = cloneConfig(document);
  stripDeprecatedRuntimeKeys(normalized);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`);
  fs.renameSync(tmpPath, configPath);
  clearRuntimeConfigCacheIfNeeded(configPath);
}

export function updateRuntimeConfigDocument(
  mutator: (draft: Record<string, unknown>) => void | boolean,
  configPath = resolveRuntimeConfigPath()
): Record<string, unknown> {
  const draft = readRuntimeConfigDocument(configPath);
  const shouldWrite = mutator(draft);
  if (shouldWrite !== false) {
    writeRuntimeConfigDocument(draft, configPath);
  }
  return draft;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const currentHome = process.env.DOTCLAW_HOME || null;
  if (cachedConfig && cachedHome === currentHome) {
    // Check if file has been modified since last load
    try {
      const configPath = resolveRuntimeConfigPath();
      const stat = fs.statSync(configPath);
      if (cachedMtime !== null && stat.mtimeMs === cachedMtime) {
        return cachedConfig;
      }
    } catch {
      // File may not exist; use cached config
      return cachedConfig;
    }
  }
  const fromFile = readRuntimeConfigDocument();
  const merged = fromFile ? mergeDefaults(DEFAULT_CONFIG, fromFile) : cloneConfig(DEFAULT_CONFIG);
  if (!hasTelegramHandlerOverride(fromFile)) {
    merged.host.telegram.handlerTimeoutMs = Math.max(merged.host.container.timeoutMs + 30_000, 120_000);
  }
  // Warn about deprecated config keys (silently dropped by mergeDefaults)
  if (isPlainObject(fromFile)) {
    const host = (fromFile as Record<string, unknown>).host;
    if (isPlainObject(host)) {
      if (isPlainObject(host.backgroundJobs)) {
        console.warn('[runtime-config] host.backgroundJobs is deprecated and ignored — background jobs have been removed');
      }
      if (isPlainObject(host.routing) && isPlainObject((host.routing as Record<string, unknown>).profiles)) {
        console.warn('[runtime-config] host.routing.profiles is deprecated — routing now uses a single flat config');
      }
    }
  }
  validateRuntimeConfig(merged);
  cachedConfig = merged;
  cachedHome = currentHome;
  try {
    const stat = fs.statSync(resolveRuntimeConfigPath());
    cachedMtime = stat.mtimeMs;
  } catch {
    cachedMtime = null;
  }
  return merged;
}
