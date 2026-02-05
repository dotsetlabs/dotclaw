const ISO_OFFSET_PATTERN = /(Z|[+-]\d{2}:\d{2})$/i;
const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?$/;

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const datePartFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDatePartFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = datePartFormatterCache.get(timezone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  datePartFormatterCache.set(timezone, formatter);
  return formatter;
}

function extractDateParts(date: Date, timezone: string): DateParts {
  const formatter = getDatePartFormatter(timezone);
  const parts = formatter.formatToParts(date);
  const readPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find(part => part.type === type)?.value;
    return found ? Number(found) : 0;
  };
  return {
    year: readPart('year'),
    month: readPart('month'),
    day: readPart('day'),
    hour: readPart('hour'),
    minute: readPart('minute'),
    second: readPart('second')
  };
}

function parseLocalDateTime(value: string): DateParts | null {
  const match = value.trim().match(LOCAL_DATETIME_PATTERN);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || '0');
  const minute = Number(match[5] || '0');
  const second = Number(match[6] || '0');
  const normalized = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() !== month - 1
    || normalized.getUTCDate() !== day
    || normalized.getUTCHours() !== hour
    || normalized.getUTCMinutes() !== minute
    || normalized.getUTCSeconds() !== second
  ) {
    return null;
  }
  return { year, month, day, hour, minute, second };
}

function compareParts(target: DateParts, actual: DateParts): number {
  const targetMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
  return Math.round((targetMs - actualMs) / 1000);
}

function zonedDateTimeToUtc(parts: DateParts, timezone: string): Date {
  let guessMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  for (let i = 0; i < 4; i += 1) {
    const actual = extractDateParts(new Date(guessMs), timezone);
    const diffSeconds = compareParts(parts, actual);
    if (diffSeconds === 0) break;
    guessMs += diffSeconds * 1000;
  }
  return new Date(guessMs);
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeTaskTimezone(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && isValidTimezone(trimmed)) {
      return trimmed;
    }
  }
  return fallback;
}

export function parseScheduledTimestamp(value: string, timezone: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (ISO_OFFSET_PATTERN.test(trimmed)) {
    const explicit = new Date(trimmed);
    return Number.isNaN(explicit.getTime()) ? null : explicit;
  }

  const parsedLocal = parseLocalDateTime(trimmed);
  if (parsedLocal) {
    if (!isValidTimezone(timezone)) return null;
    return zonedDateTimeToUtc(parsedLocal, timezone);
  }

  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}
