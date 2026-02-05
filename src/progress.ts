export const DEFAULT_PROGRESS_MESSAGES = [
  'Working on it. This might take a moment.',
  'Still working. Thanks for your patience.',
  'Almost there. I will send the result as soon as it is ready.'
];

export const DEFAULT_PROGRESS_STAGES: Record<string, string> = {
  ack: 'On it. I will get started now.',
  planning: 'Planning the best approach.',
  searching: 'Gathering information and context.',
  coding: 'Working on the implementation.',
  drafting: 'Drafting the response.',
  finalizing: 'Finalizing everything.'
};

function normalizeSteps(steps: string[]): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.map(step => step.trim()).filter(Boolean);
}

export function formatPlanStepList(params: { steps: string[]; currentStep?: number; maxSteps?: number }): string {
  const cleaned = normalizeSteps(params.steps);
  if (cleaned.length === 0) return '';
  const total = cleaned.length;
  const maxSteps = Number.isFinite(params.maxSteps)
    ? Math.max(1, Math.floor(params.maxSteps as number))
    : 4;
  const limited = cleaned.slice(0, maxSteps);
  const current = Number.isFinite(params.currentStep)
    ? Math.min(Math.max(1, Math.floor(params.currentStep as number)), total)
    : null;
  return limited.map((step, index) => {
    const marker = current && index + 1 === current ? '->' : '*';
    return `${marker} ${step}`;
  }).join('\n');
}

export function formatProgressWithPlan(params: { steps: string[]; currentStep?: number; stage?: string }): string {
  const normalizedStage = params.stage ? params.stage.trim().toLowerCase() : '';
  const fallback = DEFAULT_PROGRESS_STAGES[normalizedStage] || DEFAULT_PROGRESS_MESSAGES[0];
  const cleaned = normalizeSteps(params.steps);
  if (cleaned.length === 0) return fallback;
  const total = cleaned.length;
  const current = Number.isFinite(params.currentStep)
    ? Math.min(Math.max(1, Math.floor(params.currentStep as number)), total)
    : 1;
  const list = formatPlanStepList({ steps: cleaned, currentStep: current, maxSteps: 4 });
  if (!list) return fallback;
  return `Working on your request (step ${current}/${total}):\n${list}`;
}

export function parseProgressMessages(raw: string | undefined, fallback = DEFAULT_PROGRESS_MESSAGES): string[] {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const messages = parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
        return messages.length > 0 ? messages : fallback;
      }
    } catch {
      return fallback;
    }
  }
  const parts = trimmed.split('|').map(item => item.trim()).filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

export function createProgressManager(params: {
  enabled: boolean;
  initialDelayMs: number;
  intervalMs: number;
  maxUpdates: number;
  messages: string[];
  stageMessages?: Record<string, string>;
  stageThrottleMs?: number;
  send: (text: string) => Promise<void>;
  onError?: (err: unknown) => void;
}): { start: () => void; stop: () => Promise<void>; setStage: (stage: string) => void; notify: (text: string) => void } {
  const maxUpdates = Math.max(0, Math.floor(params.maxUpdates));
  const initialDelay = Math.max(0, Math.floor(params.initialDelayMs));
  const intervalDelay = Math.max(0, Math.floor(params.intervalMs));
  const messages = params.messages && params.messages.length > 0 ? params.messages : DEFAULT_PROGRESS_MESSAGES;
  const stageMessages = params.stageMessages && Object.keys(params.stageMessages).length > 0
    ? params.stageMessages
    : DEFAULT_PROGRESS_STAGES;
  const stageThrottleMs = Math.max(0, Math.floor(params.stageThrottleMs ?? 20_000));

  let stopped = false;
  let updateCount = 0;
  let initialTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;
  let lastStageSent: string | null = null;
  let lastSentAt = 0;
  let pendingSend: Promise<void> | null = null;

  const stop = (): Promise<void> => {
    stopped = true;
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
    return pendingSend || Promise.resolve();
  };

  const ensureInterval = () => {
    if (intervalDelay <= 0 || intervalTimer) return;
    intervalTimer = setInterval(() => {
      void sendFallback();
    }, intervalDelay);
  };

  const sendText = async (text: string) => {
    if (stopped || !params.enabled) return;
    if (maxUpdates === 0) return;
    if (updateCount >= maxUpdates) {
      void stop();
      return;
    }
    updateCount += 1;
    ensureInterval();
    lastSentAt = Date.now();
    pendingSend = params.send(text).catch((err) => {
      params.onError?.(err);
    }).finally(() => {
      pendingSend = null;
    });
    await pendingSend;
    if (updateCount >= maxUpdates) {
      void stop();
    }
  };

  const sendFallback = async () => {
    if (stopped || !params.enabled) return;
    if (updateCount >= maxUpdates) {
      stop();
      return;
    }
    const index = Math.min(updateCount, messages.length - 1);
    const text = messages[index];
    if (!text) return;
    await sendText(text);
  };

  const start = () => {
    if (!params.enabled) return;
    if (maxUpdates === 0) return;
    if (messages.length === 0) return;
    if (initialDelay === 0) {
      void sendFallback();
    } else {
      initialTimer = setTimeout(() => {
        void sendFallback();
      }, initialDelay);
    }
  };

  const setStage = (stage: string) => {
    if (!params.enabled || stopped) return;
    const normalized = stage.trim().toLowerCase();
    if (!normalized) return;
    if (normalized === lastStageSent) return;
    const text = stageMessages[normalized];
    if (!text) return;
    const now = Date.now();
    if (now - lastSentAt < stageThrottleMs) return;
    lastStageSent = normalized;
    void sendText(text);
  };

  const notify = (text: string) => {
    if (!text) return;
    void sendText(text);
  };

  return { start, stop, setStage, notify };
}

export function createProgressNotifier(params: {
  enabled: boolean;
  initialDelayMs: number;
  intervalMs: number;
  maxUpdates: number;
  messages: string[];
  send: (text: string) => Promise<void>;
  onError?: (err: unknown) => void;
}): { start: () => void; stop: () => Promise<void> } {
  const maxUpdates = Math.max(0, Math.floor(params.maxUpdates));
  const initialDelay = Math.max(0, Math.floor(params.initialDelayMs));
  const intervalDelay = Math.max(0, Math.floor(params.intervalMs));
  const messages = params.messages && params.messages.length > 0 ? params.messages : DEFAULT_PROGRESS_MESSAGES;

  let stopped = false;
  let updateCount = 0;
  let initialTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;
  let pendingSend: Promise<void> | null = null;

  const stop = (): Promise<void> => {
    stopped = true;
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
    return pendingSend || Promise.resolve();
  };

  const ensureInterval = () => {
    if (intervalDelay <= 0 || intervalTimer) return;
    intervalTimer = setInterval(() => {
      void sendUpdate();
    }, intervalDelay);
  };

  const sendUpdate = async () => {
    if (stopped || !params.enabled) return;
    if (maxUpdates === 0) return;
    if (updateCount >= maxUpdates) {
      void stop();
      return;
    }
    const index = Math.min(updateCount, messages.length - 1);
    updateCount += 1;
    ensureInterval();
    pendingSend = params.send(messages[index]).catch((err) => {
      params.onError?.(err);
    }).finally(() => {
      pendingSend = null;
    });
    await pendingSend;
    if (updateCount >= maxUpdates) {
      void stop();
    }
  };

  const start = () => {
    if (!params.enabled) return;
    if (maxUpdates === 0) return;
    if (messages.length === 0) return;
    if (initialDelay === 0) {
      void sendUpdate();
    } else {
      initialTimer = setTimeout(() => {
        void sendUpdate();
      }, initialDelay);
    }
  };

  return { start, stop };
}
