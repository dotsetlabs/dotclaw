export const DEFAULT_PROGRESS_MESSAGES = [
  'Working on it. This might take a moment.',
  'Still working. Thanks for your patience.',
  'Almost there. I will send the result as soon as it is ready.'
];

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

export function createProgressNotifier(params: {
  enabled: boolean;
  initialDelayMs: number;
  intervalMs: number;
  maxUpdates: number;
  messages: string[];
  send: (text: string) => Promise<void>;
  onError?: (err: unknown) => void;
}): { start: () => void; stop: () => void } {
  const maxUpdates = Math.max(0, Math.floor(params.maxUpdates));
  const initialDelay = Math.max(0, Math.floor(params.initialDelayMs));
  const intervalDelay = Math.max(0, Math.floor(params.intervalMs));
  const messages = params.messages && params.messages.length > 0 ? params.messages : DEFAULT_PROGRESS_MESSAGES;

  let stopped = false;
  let updateCount = 0;
  let initialTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;

  const stop = () => {
    stopped = true;
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
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
      stop();
      return;
    }
    const index = Math.min(updateCount, messages.length - 1);
    updateCount += 1;
    ensureInterval();
    try {
      await params.send(messages[index]);
    } catch (err) {
      params.onError?.(err);
    }
    if (updateCount >= maxUpdates) {
      stop();
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
