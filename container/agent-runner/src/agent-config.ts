import fs from 'fs';

export type AgentRuntimeConfig = {
  defaultModel: string;
  daemonPollMs: number;
  daemonHeartbeatIntervalMs: number;
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
    };
    process: {
      maxSessions: number;
      maxOutputBytes: number;
      defaultTimeoutMs: number;
    };
  };
};

const CONFIG_PATH = '/workspace/config/runtime.json';
const DEFAULT_DEFAULT_MODEL = 'moonshotai/kimi-k2.5';
const DEFAULT_DAEMON_POLL_MS = 200;
const DEFAULT_DAEMON_HEARTBEAT_INTERVAL_MS = 1_000;

const DEFAULT_AGENT_CONFIG: AgentRuntimeConfig['agent'] = {
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
    recentContextTokens: 8000,
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
      keepLastAssistant: 3
    }
  },
  memory: {
    maxResults: 6,
    maxTokens: 2000,
    extraction: {
      enabled: true,
      maxMessages: 4,
      maxOutputTokens: 1024
    },
    archiveSync: true,
    extractScheduled: false
  },
  models: {
    summary: 'deepseek/deepseek-v3.2',
    memory: 'deepseek/deepseek-v3.2'
  },
  tools: {
    maxToolSteps: 200,
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
    openaiVoice: 'alloy'
  },
  browser: {
    enabled: true,
    timeoutMs: 30_000,
    screenshotQuality: 80
  },
  mcp: {
    enabled: true,
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
  },
  process: {
    maxSessions: 16,
    maxOutputBytes: 1_048_576,
    defaultTimeoutMs: 1_800_000,
  }
};

let cachedConfig: AgentRuntimeConfig | null = null;
let cachedMtime: number | null = null;

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      console.error(`[agent-config] ${fullPath}: expected ${typeof current}, got ${typeof value}. Using default.`);
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
  } catch (err) {
    console.error(`[agent-runner] Failed to load config ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function loadAgentConfig(): AgentRuntimeConfig {
  if (cachedConfig) {
    // Check if file has been modified since last load
    try {
      const stat = fs.statSync(CONFIG_PATH);
      if (cachedMtime !== null && stat.mtimeMs === cachedMtime) {
        return cachedConfig;
      }
    } catch {
      return cachedConfig;
    }
  }
  const raw = readJson(CONFIG_PATH);

  let defaultModel = DEFAULT_DEFAULT_MODEL;
  let daemonPollMs = DEFAULT_DAEMON_POLL_MS;
  let daemonHeartbeatIntervalMs = DEFAULT_DAEMON_HEARTBEAT_INTERVAL_MS;
  let agentOverrides: unknown = null;

  if (isPlainObject(raw)) {
    const host = raw.host;
    if (isPlainObject(host)) {
      if (typeof host.defaultModel === 'string' && host.defaultModel.trim()) {
        defaultModel = host.defaultModel.trim();
      }
      const container = host.container;
      if (isPlainObject(container)) {
        if (typeof container.daemonPollMs === 'number') {
          daemonPollMs = container.daemonPollMs;
        }
        if (typeof container.daemonHeartbeatIntervalMs === 'number') {
          daemonHeartbeatIntervalMs = container.daemonHeartbeatIntervalMs;
        }
      }
    }
    if (isPlainObject(raw.agent)) {
      agentOverrides = raw.agent;
    }
  }

  cachedConfig = {
    defaultModel,
    daemonPollMs,
    daemonHeartbeatIntervalMs,
    agent: mergeDefaults(DEFAULT_AGENT_CONFIG, agentOverrides)
  };
  try {
    const stat = fs.statSync(CONFIG_PATH);
    cachedMtime = stat.mtimeMs;
  } catch {
    cachedMtime = null;
  }
  return cachedConfig;
}
