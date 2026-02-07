import { Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';
import type {
  MessagingProvider,
  ProviderEventHandlers,
  ProviderCapabilities,
  IncomingMessage,
  ProviderAttachment,
  SendResult,
  SendOptions,
  MediaOptions,
  VoiceOptions,
  AudioOptions,
  BaseOptions,
  ContactOptions,
  PollOptions,
  ButtonRow,
} from '../types.js';
import { ProviderRegistry } from '../registry.js';
import { formatTelegramMessage, TELEGRAM_PARSE_MODE } from './telegram-format.js';
import { generateId } from '../../id.js';
import { logger } from '../../logger.js';
import type { RuntimeConfig } from '../../runtime-config.js';

const MAX_MESSAGE_LENGTH = 4000;
const SEND_DELAY_MS = 250;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const FILE_DOWNLOAD_TIMEOUT_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorCode(err: unknown): number | null {
  const anyErr = err as { code?: number; response?: { error_code?: number } };
  if (typeof anyErr?.code === 'number') return anyErr.code;
  if (typeof anyErr?.response?.error_code === 'number') return anyErr.response.error_code;
  return null;
}

function getRetryAfterMs(err: unknown): number | null {
  const anyErr = err as { parameters?: { retry_after?: number | string }; response?: { parameters?: { retry_after?: number | string } } };
  const retryAfter = anyErr?.parameters?.retry_after ?? anyErr?.response?.parameters?.retry_after;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) return retryAfter * 1000;
  if (typeof retryAfter === 'string') {
    const parsed = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(parsed)) return parsed * 1000;
  }
  return null;
}

function isRetryableError(err: unknown): boolean {
  const code = getErrorCode(err);
  if (code === 429) return true;
  if (code && code >= 500 && code < 600) return true;
  const anyErr = err as { code?: string };
  if (!anyErr?.code) return false;
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(anyErr.code);
}

function splitPlainText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

function isAllowedInlineButtonUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'tg:';
  } catch {
    return false;
  }
}

type InlineKeyboardButton = { text: string; callback_data?: string; url?: string };

function normalizeInlineKeyboard(rawButtons: ButtonRow[]): Array<Array<InlineKeyboardButton>> | null {
  if (rawButtons.length === 0) return null;
  const rows: Array<Array<InlineKeyboardButton>> = [];
  for (const rawRow of rawButtons) {
    if (rawRow.length === 0) return null;
    const row: InlineKeyboardButton[] = [];
    for (const rawButton of rawRow) {
      const text = rawButton.text?.trim() || '';
      const url = rawButton.url?.trim() || '';
      const callbackData = rawButton.callbackData || '';
      const hasUrl = url.length > 0;
      const hasCallback = callbackData.length > 0;
      if (!text || hasUrl === hasCallback) return null;
      if (hasUrl && !isAllowedInlineButtonUrl(url)) return null;
      if (hasCallback && callbackData.length > 64) return null;
      if (hasUrl) row.push({ text, url });
      else row.push({ text, callback_data: callbackData });
    }
    rows.push(row);
  }
  return rows;
}

function normalizePollOptions(rawOptions: string[]): string[] | null {
  const options = rawOptions
    .map(option => option.trim())
    .filter(Boolean);
  if (options.length < 2 || options.length > 10) return null;
  if (options.some(option => option.length > 100)) return null;
  if (new Set(options.map(option => option.toLowerCase())).size !== options.length) return null;
  return options;
}

export interface TelegramProviderConfig {
  token: string;
  handlerTimeoutMs: number;
  sendRetries: number;
  sendRetryDelayMs: number;
  groupsDir: string;
}

export class TelegramProvider implements MessagingProvider {
  readonly name = 'telegram' as const;
  readonly capabilities: ProviderCapabilities = {
    maxMessageLength: MAX_MESSAGE_LENGTH,
    maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    supportsInlineButtons: true,
    supportsPoll: true,
    supportsVoiceMessages: true,
    supportsLocation: true,
    supportsContact: true,
    supportsReactions: true,
    supportsThreads: true,
  };

  private readonly bot: Telegraf;
  private readonly config: TelegramProviderConfig;
  private connected = false;
  private botUsername = '';
  private botId: number | undefined;
  private lastBotInfoRetryAt = 0;

  // Callback data store for inline buttons (5-minute TTL)
  private readonly callbackDataStore = new Map<string, { chatJid: string; data: string; label: string; createdAt: number }>();
  private callbackCleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: TelegramProviderConfig) {
    this.config = config;
    this.bot = new Telegraf(config.token, {
      handlerTimeout: config.handlerTimeoutMs,
    });
    this.bot.catch((err, ctx) => {
      logger.error({ err, chatId: ctx?.chat?.id }, 'Unhandled Telegraf error');
    });
  }

  get telegrafBot(): Telegraf {
    return this.bot;
  }

  async start(handlers: ProviderEventHandlers): Promise<void> {
    this.setupHandlers(handlers);
    this.bot.launch();
    this.connected = true;

    // Eagerly fetch bot info so isBotMentioned() works immediately
    try {
      const me = await this.bot.telegram.getMe();
      this.botUsername = me.username || '';
      this.botId = me.id;
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch bot info on start; will populate on first message');
      this.botUsername = (this.bot as unknown as { botInfo?: { username?: string } }).botInfo?.username || '';
      this.botId = (this.bot as unknown as { botInfo?: { id?: number } }).botInfo?.id;
    }

    this.callbackCleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [id, entry] of this.callbackDataStore) {
        if (entry.createdAt < cutoff) {
          this.callbackDataStore.delete(id);
        }
      }
    }, 60_000);
  }

  stop(): Promise<void> {
    this.connected = false;
    this.bot.stop('SHUTDOWN');
    if (this.callbackCleanupInterval) {
      clearInterval(this.callbackCleanupInterval);
      this.callbackCleanupInterval = null;
    }
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<SendResult> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    const parseMode = opts?.parseMode === undefined ? TELEGRAM_PARSE_MODE : opts.parseMode;
    const chunks = parseMode
      ? formatTelegramMessage(text, MAX_MESSAGE_LENGTH)
      : splitPlainText(text, MAX_MESSAGE_LENGTH);
    let firstMessageId: string | undefined;

    const threadId = opts?.threadId ? Number(opts.threadId) : undefined;
    const replyToId = opts?.replyToMessageId ? Number(opts.replyToMessageId) : undefined;

    for (let i = 0; i < chunks.length; i += 1) {
      const ok = await this.sendChunk(rawChatId, chunks[i], parseMode, threadId, i === 0 ? replyToId : undefined);
      if (!ok.success) return { success: false };
      if (!firstMessageId && ok.messageId) {
        firstMessageId = ok.messageId;
      }
      if (i < chunks.length - 1) {
        await sleep(SEND_DELAY_MS);
      }
    }
    logger.info({ chatId: rawChatId, length: text.length }, 'Message sent');
    return { success: true, messageId: firstMessageId };
  }

  private async sendChunk(
    chatId: string,
    chunk: string,
    parseMode: string | null,
    threadId?: number,
    replyToId?: number
  ): Promise<SendResult> {
    for (let attempt = 1; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        const payload: Record<string, unknown> = {};
        if (parseMode) payload.parse_mode = parseMode;
        if (threadId) payload.message_thread_id = threadId;
        if (replyToId) {
          payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
        }
        const sent = await this.bot.telegram.sendMessage(chatId, chunk, payload);
        return { success: true, messageId: String(sent.message_id) };
      } catch (err) {
        const retryAfterMs = getRetryAfterMs(err);
        const retryable = isRetryableError(err);
        if (!retryable || attempt === this.config.sendRetries) {
          logger.error({ chatId, attempt, err }, 'Failed to send Telegram message chunk');
          return { success: false };
        }
        const delayMs = retryAfterMs ?? (this.config.sendRetryDelayMs * attempt);
        logger.warn({ chatId, attempt, delayMs }, 'Telegram send failed; retrying');
        await sleep(delayMs);
      }
    }
    return { success: false };
  }

  async sendPhoto(chatId: string, filePath: string, opts?: MediaOptions): Promise<SendResult> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    const replyToId = opts?.replyToMessageId ? Number(opts.replyToMessageId) : undefined;
    const threadId = opts?.threadId ? Number(opts.threadId) : undefined;
    for (let attempt = 1; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        const payload: Record<string, unknown> = {};
        if (opts?.caption) payload.caption = opts.caption;
        if (threadId) payload.message_thread_id = threadId;
        if (replyToId) {
          payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
        }
        const sent = await this.bot.telegram.sendPhoto(rawChatId, { source: filePath }, payload);
        logger.info({ chatId: rawChatId, filePath }, 'Photo sent');
        return { success: true, messageId: String(sent.message_id) };
      } catch (err) {
        if (!isRetryableError(err) || attempt === this.config.sendRetries) {
          logger.error({ chatId: rawChatId, filePath, attempt, err }, 'Failed to send photo');
          return { success: false };
        }
        const retryAfterMs = getRetryAfterMs(err);
        const delayMs = retryAfterMs ?? (this.config.sendRetryDelayMs * attempt);
        logger.warn({ chatId: rawChatId, attempt, delayMs }, 'Photo send failed; retrying');
        await sleep(delayMs);
      }
    }
    return { success: false };
  }

  async sendDocument(chatId: string, filePath: string, opts?: MediaOptions): Promise<SendResult> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    const replyToId = opts?.replyToMessageId ? Number(opts.replyToMessageId) : undefined;
    const threadId = opts?.threadId ? Number(opts.threadId) : undefined;
    for (let attempt = 1; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        const payload: Record<string, unknown> = {};
        if (opts?.caption) payload.caption = opts.caption;
        if (threadId) payload.message_thread_id = threadId;
        if (replyToId) {
          payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
        }
        const sent = await this.bot.telegram.sendDocument(rawChatId, { source: filePath }, payload);
        logger.info({ chatId: rawChatId, filePath }, 'Document sent');
        return { success: true, messageId: String(sent.message_id) };
      } catch (err) {
        if (!isRetryableError(err) || attempt === this.config.sendRetries) {
          logger.error({ chatId: rawChatId, filePath, attempt, err }, 'Failed to send document');
          return { success: false };
        }
        const retryAfterMs = getRetryAfterMs(err);
        const delayMs = retryAfterMs ?? (this.config.sendRetryDelayMs * attempt);
        logger.warn({ chatId: rawChatId, attempt, delayMs }, 'Document send failed; retrying');
        await sleep(delayMs);
      }
    }
    return { success: false };
  }

  async sendVoice(chatId: string, filePath: string, opts?: VoiceOptions): Promise<SendResult> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    const replyToId = opts?.replyToMessageId ? Number(opts.replyToMessageId) : undefined;
    const threadId = opts?.threadId ? Number(opts.threadId) : undefined;
    for (let attempt = 1; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        const payload: Record<string, unknown> = {};
        if (opts?.caption) payload.caption = opts.caption;
        if (opts?.duration) payload.duration = opts.duration;
        if (threadId) payload.message_thread_id = threadId;
        if (replyToId) {
          payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
        }
        const sent = await this.bot.telegram.sendVoice(rawChatId, { source: filePath }, payload);
        logger.info({ chatId: rawChatId, filePath }, 'Voice sent');
        return { success: true, messageId: String(sent.message_id) };
      } catch (err) {
        if (!isRetryableError(err) || attempt === this.config.sendRetries) {
          logger.error({ chatId: rawChatId, filePath, attempt, err }, 'Failed to send voice');
          return { success: false };
        }
        const retryAfterMs = getRetryAfterMs(err);
        const delayMs = retryAfterMs ?? (this.config.sendRetryDelayMs * attempt);
        await sleep(delayMs);
      }
    }
    return { success: false };
  }

  async sendAudio(chatId: string, filePath: string, opts?: AudioOptions): Promise<SendResult> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    const replyToId = opts?.replyToMessageId ? Number(opts.replyToMessageId) : undefined;
    const threadId = opts?.threadId ? Number(opts.threadId) : undefined;
    for (let attempt = 1; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        const payload: Record<string, unknown> = {};
        if (opts?.caption) payload.caption = opts.caption;
        if (opts?.duration) payload.duration = opts.duration;
        if (opts?.performer) payload.performer = opts.performer;
        if (opts?.title) payload.title = opts.title;
        if (threadId) payload.message_thread_id = threadId;
        if (replyToId) {
          payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
        }
        const sent = await this.bot.telegram.sendAudio(rawChatId, { source: filePath }, payload);
        logger.info({ chatId: rawChatId, filePath }, 'Audio sent');
        return { success: true, messageId: String(sent.message_id) };
      } catch (err) {
        if (!isRetryableError(err) || attempt === this.config.sendRetries) {
          logger.error({ chatId: rawChatId, filePath, attempt, err }, 'Failed to send audio');
          return { success: false };
        }
        const retryAfterMs = getRetryAfterMs(err);
        const delayMs = retryAfterMs ?? (this.config.sendRetryDelayMs * attempt);
        await sleep(delayMs);
      }
    }
    return { success: false };
  }

  async sendLocation(chatId: string, lat: number, lng: number, opts?: BaseOptions): Promise<SendResult> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    const replyToId = opts?.replyToMessageId ? Number(opts.replyToMessageId) : undefined;
    const threadId = opts?.threadId ? Number(opts.threadId) : undefined;
    for (let attempt = 1; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        const payload: Record<string, unknown> = {};
        if (threadId) payload.message_thread_id = threadId;
        if (replyToId) {
          payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
        }
        await this.bot.telegram.sendLocation(rawChatId, lat, lng, payload);
        logger.info({ chatId: rawChatId, lat, lng }, 'Location sent');
        return { success: true };
      } catch (err) {
        if (!isRetryableError(err) || attempt === this.config.sendRetries) {
          logger.error({ chatId: rawChatId, attempt, err }, 'Failed to send location');
          return { success: false };
        }
        const retryAfterMs = getRetryAfterMs(err);
        const delayMs = retryAfterMs ?? (this.config.sendRetryDelayMs * attempt);
        logger.warn({ chatId: rawChatId, attempt, delayMs }, 'Location send failed; retrying');
        await sleep(delayMs);
      }
    }
    return { success: false };
  }

  async sendContact(chatId: string, phone: string, name: string, opts?: ContactOptions): Promise<SendResult> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    const replyToId = opts?.replyToMessageId ? Number(opts.replyToMessageId) : undefined;
    const threadId = opts?.threadId ? Number(opts.threadId) : undefined;
    for (let attempt = 1; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        const payload: Record<string, unknown> = {};
        if (opts?.lastName) payload.last_name = opts.lastName;
        if (threadId) payload.message_thread_id = threadId;
        if (replyToId) {
          payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
        }
        await this.bot.telegram.sendContact(rawChatId, phone, name, payload);
        logger.info({ chatId: rawChatId, phone }, 'Contact sent');
        return { success: true };
      } catch (err) {
        if (!isRetryableError(err) || attempt === this.config.sendRetries) {
          logger.error({ chatId: rawChatId, attempt, err }, 'Failed to send contact');
          return { success: false };
        }
        const retryAfterMs = getRetryAfterMs(err);
        const delayMs = retryAfterMs ?? (this.config.sendRetryDelayMs * attempt);
        logger.warn({ chatId: rawChatId, attempt, delayMs }, 'Contact send failed; retrying');
        await sleep(delayMs);
      }
    }
    return { success: false };
  }

  async sendPoll(chatId: string, question: string, options: string[], opts?: PollOptions): Promise<SendResult> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    const replyToId = opts?.replyToMessageId ? Number(opts.replyToMessageId) : undefined;
    const normalized = normalizePollOptions(options);
    if (!normalized) {
      logger.warn({ chatId: rawChatId }, 'Invalid poll options');
      return { success: false };
    }
    try {
      const payload: Record<string, unknown> = {};
      if (opts?.isAnonymous !== undefined) payload.is_anonymous = opts.isAnonymous;
      if (opts?.type) payload.type = opts.type;
      if (opts?.allowsMultipleAnswers !== undefined) payload.allows_multiple_answers = opts.allowsMultipleAnswers;
      if (opts?.correctOptionId !== undefined) payload.correct_option_id = opts.correctOptionId;
      if (replyToId) {
        payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
      }
      const sent = await this.bot.telegram.sendPoll(rawChatId, question, normalized, payload);
      logger.info({ chatId: rawChatId, question }, 'Poll sent');
      return { success: true, messageId: String(sent.message_id) };
    } catch (err) {
      logger.error({ chatId: rawChatId, err }, 'Failed to send poll');
      return { success: false };
    }
  }

  async sendButtons(chatId: string, text: string, buttons: ButtonRow[], opts?: BaseOptions): Promise<SendResult> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    const replyToId = opts?.replyToMessageId ? Number(opts.replyToMessageId) : undefined;
    const threadId = opts?.threadId ? Number(opts.threadId) : undefined;
    const normalized = normalizeInlineKeyboard(buttons);
    if (!normalized) {
      logger.warn({ chatId: rawChatId }, 'Invalid button layout');
      return { success: false };
    }
    // Register callback data and replace with IDs
    const registered = normalized.map(row =>
      row.map(btn => {
        if (btn.callback_data && !btn.url) {
          const cbId = this.registerCallbackData(chatId, btn.callback_data, btn.text);
          return { text: btn.text, callback_data: cbId };
        }
        return btn;
      })
    );
    try {
      const payload: Record<string, unknown> = {
        reply_markup: { inline_keyboard: registered }
      };
      if (threadId) payload.message_thread_id = threadId;
      if (replyToId) {
        payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
      }
      const sent = await this.bot.telegram.sendMessage(rawChatId, text, payload);
      logger.info({ chatId: rawChatId }, 'Inline keyboard sent');
      return { success: true, messageId: String(sent.message_id) };
    } catch (err) {
      logger.error({ chatId: rawChatId, err }, 'Failed to send inline keyboard');
      return { success: false };
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<SendResult> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    const numericMsgId = Number.parseInt(messageId, 10);
    if (!Number.isFinite(numericMsgId)) return { success: false };
    try {
      await this.bot.telegram.editMessageText(rawChatId, numericMsgId, undefined, text);
      return { success: true };
    } catch (err) {
      logger.error({ chatId: rawChatId, messageId, err }, 'Failed to edit message');
      return { success: false };
    }
  }

  async deleteMessage(chatId: string, messageId: string): Promise<SendResult> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    const numericMsgId = Number.parseInt(messageId, 10);
    if (!Number.isFinite(numericMsgId)) return { success: false };
    try {
      await this.bot.telegram.deleteMessage(rawChatId, numericMsgId);
      return { success: true };
    } catch (err) {
      logger.error({ chatId: rawChatId, messageId, err }, 'Failed to delete message');
      return { success: false };
    }
  }

  async downloadFile(
    ref: string,
    groupFolder: string,
    filename: string
  ): Promise<{ path: string | null; error?: string }> {
    let localPath: string | null = null;
    let tmpPath: string | null = null;
    try {
      const fileLink = await this.bot.telegram.getFileLink(ref);
      const url = fileLink.href || String(fileLink);
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), FILE_DOWNLOAD_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, { signal: abortController.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        logger.warn({ fileId: ref, status: response.status }, 'Failed to download Telegram file');
        return { path: null, error: 'download_failed' };
      }
      const contentLength = response.headers.get('content-length');
      const declaredSize = contentLength ? parseInt(contentLength, 10) : NaN;
      if (Number.isFinite(declaredSize) && declaredSize > MAX_ATTACHMENT_BYTES) {
        logger.warn({ fileId: ref, size: contentLength }, 'Telegram file too large (>20MB)');
        return { path: null, error: 'too_large' };
      }
      const inboxDir = path.join(this.config.groupsDir, groupFolder, 'inbox');
      fs.mkdirSync(inboxDir, { recursive: true });
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const localName = `${Date.now()}_${safeName}`;
      localPath = path.join(inboxDir, localName);
      tmpPath = `${localPath}.tmp`;

      const fileStream = fs.createWriteStream(tmpPath, { flags: 'wx' });
      let bytesWritten = 0;
      const body = response.body;
      if (!body) {
        throw new Error('Telegram response had no body');
      }
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          bytesWritten += value.byteLength;
          if (bytesWritten > MAX_ATTACHMENT_BYTES) {
            await reader.cancel();
            throw new Error('STREAMING_TOO_LARGE');
          }
          if (!fileStream.write(Buffer.from(value))) {
            await new Promise<void>(resolve => fileStream.once('drain', resolve));
          }
        }
        await new Promise<void>((resolve, reject) => {
          fileStream.end((err?: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } catch (streamErr) {
        fileStream.destroy();
        throw streamErr;
      }

      fs.renameSync(tmpPath, localPath);
      tmpPath = null;
      logger.info({ fileId: ref, localPath, size: bytesWritten }, 'Downloaded Telegram file');
      return { path: localPath };
    } catch (err) {
      const isTooLarge = err instanceof Error && err.message === 'STREAMING_TOO_LARGE';
      if (isTooLarge) {
        logger.warn({ fileId: ref }, 'Telegram file too large (>20MB) during streaming');
      } else {
        logger.error({ fileId: ref, err }, 'Error downloading Telegram file');
      }
      return { path: null, error: isTooLarge ? 'too_large' : 'download_failed' };
    } finally {
      if (tmpPath && fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      if (localPath && fs.existsSync(localPath) && fs.statSync(localPath).size === 0) {
        try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      }
    }
  }

  formatMessage(text: string, maxLength: number): string[] {
    return formatTelegramMessage(text, maxLength);
  }

  async setTyping(chatId: string): Promise<void> {
    const rawChatId = ProviderRegistry.stripPrefix(chatId);
    try {
      await this.bot.telegram.sendChatAction(rawChatId, 'typing');
    } catch (err) {
      logger.debug({ chatId: rawChatId, err }, 'Failed to set typing indicator');
    }
  }

  isBotMentioned(message: IncomingMessage): boolean {
    // Lazy retry: if botId is still undefined (startup failure), try once per 60s
    if (!this.botId && Date.now() - this.lastBotInfoRetryAt > 60_000) {
      this.lastBotInfoRetryAt = Date.now();
      try {
        // Fire-and-forget async retry — won't help for THIS call but will for the next
        void this.bot.telegram.getMe().then(me => {
          this.botUsername = me.username || '';
          this.botId = me.id;
          logger.info('Bot info recovered via lazy retry');
        }).catch(() => undefined);
      } catch { /* ignore */ }
    }
    const raw = message.rawProviderData as {
      entities?: Array<{ offset: number; length: number; type: string; user?: { id: number } }>;
    } | undefined;
    const entities = raw?.entities;
    if (!entities || entities.length === 0) return false;
    const normalized = this.botUsername ? this.botUsername.toLowerCase() : '';
    for (const entity of entities) {
      const segment = message.content.slice(entity.offset, entity.offset + entity.length);
      if (entity.type === 'mention') {
        if (segment.toLowerCase() === `@${normalized}`) return true;
      }
      if (entity.type === 'text_mention' && this.botId && entity.user?.id === this.botId) return true;
      if (entity.type === 'bot_command') {
        if (segment.toLowerCase().includes(`@${normalized}`)) return true;
      }
    }
    return false;
  }

  isBotReplied(message: IncomingMessage): boolean {
    const raw = message.rawProviderData as {
      reply_to_message?: { from?: { id?: number } };
    } | undefined;
    if (!raw?.reply_to_message?.from?.id || !this.botId) return false;
    return raw.reply_to_message.from.id === this.botId;
  }

  getBotUsername(): string {
    return this.botUsername;
  }

  registerCallbackData(chatJid: string, data: string, label: string): string {
    const id = generateId('cb');
    this.callbackDataStore.set(id, { chatJid, data, label, createdAt: Date.now() });
    return id;
  }

  private setupHandlers(handlers: ProviderEventHandlers): void {
    // Handle message reactions (for feedback)
    this.bot.on('message_reaction', async (ctx) => {
      try {
        const update = ctx.update as unknown as {
          message_reaction?: {
            chat: { id: number };
            message_id: number;
            user?: { id: number };
            new_reaction?: Array<{ type: string; emoji?: string }>;
          };
        };
        const reaction = update.message_reaction;
        if (!reaction) return;
        const emoji = reaction.new_reaction?.[0]?.emoji;
        if (!emoji) return;
        const chatId = ProviderRegistry.addPrefix('telegram', String(reaction.chat.id));
        const messageId = String(reaction.message_id);
        const userId = reaction.user?.id ? String(reaction.user.id) : undefined;
        handlers.onReaction(chatId, messageId, userId, emoji);
      } catch (err) {
        logger.debug({ err }, 'Error handling message reaction');
      }
    });

    // Handle callback queries from inline keyboard buttons
    this.bot.on('callback_query', async (ctx) => {
      try {
        const cbQuery = ctx.callbackQuery;
        if (!cbQuery || !('data' in cbQuery) || !cbQuery.data) return;
        const callbackId = cbQuery.data;
        const entry = this.callbackDataStore.get(callbackId);
        await ctx.answerCbQuery();
        if (!entry) {
          logger.debug({ callbackId }, 'Unknown callback data');
          return;
        }
        this.callbackDataStore.delete(callbackId);
        const callbackChatId = ctx.chat?.id ? ProviderRegistry.addPrefix('telegram', String(ctx.chat.id)) : '';
        if (callbackChatId && callbackChatId !== entry.chatJid) {
          logger.warn({ callbackChatId, expectedChatId: entry.chatJid }, 'Callback chat mismatch; ignoring');
          return;
        }
        const chatId = callbackChatId || entry.chatJid;
        const senderId = String(cbQuery.from?.id || '');
        const senderName = cbQuery.from?.first_name || cbQuery.from?.username || 'User';
        const rawThreadId = typeof cbQuery.message === 'object' && cbQuery.message && 'message_thread_id' in cbQuery.message
          ? (cbQuery.message as { message_thread_id?: number }).message_thread_id
          : undefined;
        const threadId = Number.isFinite(rawThreadId) ? String(rawThreadId) : undefined;
        handlers.onButtonClick(chatId, senderId, senderName, entry.label, entry.data, threadId);
      } catch (err) {
        logger.debug({ err }, 'Error handling callback query');
      }
    });

    // Handle all messages (text + media)
    this.bot.on('message', async (ctx) => {
      if (!ctx.message) return;
      const msg = ctx.message as unknown as Record<string, unknown>;
      const content = (typeof msg.text === 'string' ? msg.text : '')
        || (typeof msg.caption === 'string' ? msg.caption : '');

      const rawChatId = String(ctx.chat.id);
      const chatId = ProviderRegistry.addPrefix('telegram', rawChatId);
      const messageId = String((msg as { message_id: number }).message_id);

      // Build attachment metadata
      const attachments: ProviderAttachment[] = [];
      if (Array.isArray(msg.photo) && (msg.photo as Array<Record<string, unknown>>).length > 0) {
        const photos = msg.photo as Array<{ file_id: string; file_unique_id: string; width?: number; height?: number; file_size?: number }>;
        const largest = photos[photos.length - 1];
        attachments.push({
          type: 'photo',
          providerFileRef: largest.file_id,
          fileName: `photo_${messageId}.jpg`,
          mimeType: 'image/jpeg',
          fileSize: largest.file_size,
          width: largest.width,
          height: largest.height,
        });
      }

      if (msg.document && typeof msg.document === 'object') {
        const doc = msg.document as { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
        attachments.push({
          type: 'document',
          providerFileRef: doc.file_id,
          fileName: doc.file_name || `document_${messageId}`,
          mimeType: doc.mime_type,
          fileSize: doc.file_size,
        });
      }

      if (msg.voice && typeof msg.voice === 'object') {
        const voice = msg.voice as { file_id: string; duration?: number; mime_type?: string; file_size?: number };
        attachments.push({
          type: 'voice',
          providerFileRef: voice.file_id,
          fileName: `voice_${messageId}.ogg`,
          mimeType: voice.mime_type || 'audio/ogg',
          fileSize: voice.file_size,
          duration: voice.duration,
        });
      }

      if (msg.video && typeof msg.video === 'object') {
        const video = msg.video as { file_id: string; file_name?: string; mime_type?: string; file_size?: number; duration?: number; width?: number; height?: number };
        attachments.push({
          type: 'video',
          providerFileRef: video.file_id,
          fileName: video.file_name || `video_${messageId}.mp4`,
          mimeType: video.mime_type,
          fileSize: video.file_size,
          duration: video.duration,
          width: video.width,
          height: video.height,
        });
      }

      if (msg.audio && typeof msg.audio === 'object') {
        const audio = msg.audio as { file_id: string; file_name?: string; mime_type?: string; file_size?: number; duration?: number };
        attachments.push({
          type: 'audio',
          providerFileRef: audio.file_id,
          fileName: audio.file_name || `audio_${messageId}.mp3`,
          mimeType: audio.mime_type,
          fileSize: audio.file_size,
          duration: audio.duration,
        });
      }

      if (!content && attachments.length === 0) return;

      const chatType = ctx.chat.type;
      const isGroup = chatType === 'group' || chatType === 'supergroup';
      const senderId = String(ctx.from?.id || ctx.chat.id);
      const senderName = ctx.from?.first_name || ctx.from?.username || 'User';
      const timestamp = new Date((msg as { date: number }).date * 1000).toISOString();
      const rawThreadId = (msg as { message_thread_id?: number }).message_thread_id;
      const threadId = Number.isFinite(rawThreadId) ? String(rawThreadId) : undefined;
      const entities = 'entities' in msg ? (msg.entities as Array<{ offset: number; length: number; type: string; user?: { id: number } }>) : undefined;

      const chatName = ('title' in ctx.chat && ctx.chat.title)
        || ('username' in ctx.chat && ctx.chat.username)
        || ctx.from?.first_name
        || ctx.from?.username
        || senderName;

      const storedContent = content || `[${attachments.map(a => a.type).join(', ')}]`;

      const incoming: IncomingMessage = {
        chatId,
        messageId,
        senderId,
        senderName,
        content: storedContent,
        timestamp,
        isGroup,
        chatType,
        threadId,
        attachments: attachments.length > 0 ? attachments : undefined,
        rawProviderData: {
          entities,
          reply_to_message: (msg as { reply_to_message?: unknown }).reply_to_message,
          chatName,
        },
      };

      handlers.onMessage(incoming);
    });
  }
}

export function createTelegramProvider(runtime: RuntimeConfig, groupsDir: string): TelegramProvider {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
  }
  return new TelegramProvider({
    token,
    handlerTimeoutMs: runtime.host.telegram.handlerTimeoutMs,
    sendRetries: runtime.host.telegram.sendRetries,
    sendRetryDelayMs: runtime.host.telegram.sendRetryDelayMs,
    groupsDir,
  });
}
