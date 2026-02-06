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
  BaseOptions,
  MediaOptions,
  VoiceOptions,
  AudioOptions,
  ContactOptions,
  PollOptions,
  ButtonRow,
} from '../types.js';
import { ProviderRegistry } from '../registry.js';
import { formatDiscordMessage } from './discord-format.js';
import { generateId } from '../../id.js';
import { logger } from '../../logger.js';
import { GROUPS_DIR } from '../../config.js';
import type { RuntimeConfig } from '../../runtime-config.js';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SEND_DELAY_MS = 250;
const FILE_DOWNLOAD_TIMEOUT_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  const anyErr = err as { code?: number | string; httpStatus?: number };
  const code = anyErr?.httpStatus ?? (typeof anyErr?.code === 'number' ? anyErr.code : null);
  if (code === 429) return true;
  if (typeof code === 'number' && code >= 500 && code < 600) return true;
  if (typeof anyErr?.code === 'string') {
    return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(anyErr.code);
  }
  return false;
}

function getRetryAfterMs(err: unknown): number | null {
  const anyErr = err as { retryAfter?: number };
  if (typeof anyErr?.retryAfter === 'number' && Number.isFinite(anyErr.retryAfter)) {
    return anyErr.retryAfter * 1000;
  }
  return null;
}

export interface DiscordProviderConfig {
  token: string;
  sendRetries: number;
  sendRetryDelayMs: number;
  groupsDir: string;
}

// discord.js types (loaded dynamically)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordChannel = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordMessage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordModule = any;

export class DiscordProvider implements MessagingProvider {
  readonly name = 'discord' as const;
  readonly capabilities: ProviderCapabilities = {
    maxMessageLength: MAX_MESSAGE_LENGTH,
    maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    supportsInlineButtons: true,
    supportsPoll: true,
    supportsVoiceMessages: true,
    supportsLocation: false,
    supportsContact: false,
    supportsReactions: true,
    supportsThreads: true,
  };

  private client: DiscordClient | null = null;
  private discordJs: DiscordModule | null = null;
  private channelTypeDM: number | null = null;
  private readonly config: DiscordProviderConfig;
  private connected = false;
  private botId = '';

  // Callback data store for button interactions (5-minute TTL)
  private readonly callbackDataStore = new Map<string, { chatId: string; data: string; label: string; createdAt: number }>();
  private callbackCleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: DiscordProviderConfig) {
    this.config = config;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(handlers: ProviderEventHandlers): Promise<void> {
    // Dynamically import discord.js — it's an optional dependency
    try {
      this.discordJs = await import('discord.js');
    } catch (importErr) {
      const detail = importErr instanceof Error ? importErr.message : String(importErr);
      throw new Error(
        `discord.js failed to load: ${detail}. Run \`npm install discord.js\` to install it.`
      );
    }

    const { Client, GatewayIntentBits, Partials, ChannelType } = this.discordJs;
    this.channelTypeDM = ChannelType?.DM ?? 1;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    this.setupHandlers(handlers);

    await this.client.login(this.config.token);
    this.connected = true;
    this.botId = this.client.user?.id ?? '';
    logger.info({ botId: this.botId }, 'Discord provider started');

    this.callbackCleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [id, entry] of this.callbackDataStore) {
        if (entry.createdAt < cutoff) {
          this.callbackDataStore.delete(id);
        }
      }
    }, 60_000);
  }

  async stop(): Promise<void> {
    this.connected = false;
    if (this.callbackCleanupInterval) {
      clearInterval(this.callbackCleanupInterval);
      this.callbackCleanupInterval = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  async sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<SendResult> {
    const rawChannelId = ProviderRegistry.stripPrefix(chatId);
    const chunks = formatDiscordMessage(text, MAX_MESSAGE_LENGTH);
    let firstMessageId: string | undefined;

    for (let i = 0; i < chunks.length; i += 1) {
      const result = await this.sendChunk(rawChannelId, chunks[i], opts?.replyToMessageId);
      if (!result.success) return { success: false };
      if (!firstMessageId && result.messageId) {
        firstMessageId = result.messageId;
      }
      if (i < chunks.length - 1) {
        await sleep(SEND_DELAY_MS);
      }
    }

    logger.info({ chatId: rawChannelId, length: text.length }, 'Discord message sent');
    return { success: true, messageId: firstMessageId };
  }

  private async sendChunk(
    channelId: string,
    content: string,
    replyToId?: string
  ): Promise<SendResult> {
    for (let attempt = 1; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        const channel = await this.fetchChannel(channelId);
        if (!channel) return { success: false };

        const payload: Record<string, unknown> = { content };
        if (replyToId) {
          payload.reply = { messageReference: replyToId, failIfNotExists: false };
        }
        const sent: DiscordMessage = await channel.send(payload);
        return { success: true, messageId: String(sent.id) };
      } catch (err) {
        const retryAfterMs = getRetryAfterMs(err);
        const retryable = isRetryableError(err);
        if (!retryable || attempt === this.config.sendRetries) {
          logger.error({ channelId, attempt, err }, 'Failed to send Discord message chunk');
          return { success: false };
        }
        const delayMs = retryAfterMs ?? (this.config.sendRetryDelayMs * attempt);
        logger.warn({ channelId, attempt, delayMs }, 'Discord send failed; retrying');
        await sleep(delayMs);
      }
    }
    return { success: false };
  }

  async sendPhoto(chatId: string, filePath: string, opts?: MediaOptions): Promise<SendResult> {
    return this.sendFileAttachment(chatId, filePath, opts?.caption, opts);
  }

  async sendDocument(chatId: string, filePath: string, opts?: MediaOptions): Promise<SendResult> {
    return this.sendFileAttachment(chatId, filePath, opts?.caption, opts);
  }

  async sendVoice(chatId: string, filePath: string, opts?: VoiceOptions): Promise<SendResult> {
    // Discord has no native voice messages; send as file attachment
    return this.sendFileAttachment(chatId, filePath, opts?.caption, opts);
  }

  async sendAudio(chatId: string, filePath: string, opts?: AudioOptions): Promise<SendResult> {
    // Discord has no native audio messages; send as file attachment
    const caption = opts?.title
      ? `${opts.title}${opts.performer ? ` - ${opts.performer}` : ''}`
      : opts?.caption;
    return this.sendFileAttachment(chatId, filePath, caption, opts);
  }

  async sendLocation(chatId: string, lat: number, lng: number, opts?: BaseOptions): Promise<SendResult> {
    const text = `\u{1F4CD} Location: https://maps.google.com/?q=${lat},${lng}`;
    return this.sendMessage(chatId, text, opts);
  }

  async sendContact(chatId: string, phone: string, name: string, opts?: ContactOptions): Promise<SendResult> {
    const fullName = opts?.lastName ? `${name} ${opts.lastName}` : name;
    const text = `\u{1F4C7} Contact: ${fullName}\n\u{1F4DE} ${phone}`;
    return this.sendMessage(chatId, text, opts);
  }

  async sendPoll(chatId: string, question: string, options: string[], opts?: PollOptions): Promise<SendResult> {
    // Discord's native poll API (discord.js v14.15+)
    // Fallback to text-based poll if the API is not available
    const rawChannelId = ProviderRegistry.stripPrefix(chatId);
    try {
      const channel = await this.fetchChannel(rawChannelId);
      if (!channel) return { success: false };

      // Try native Discord polls if available
      if (this.discordJs?.PollLayoutType !== undefined) {
        const pollData: Record<string, unknown> = {
          poll: {
            question: { text: question },
            answers: options.map(opt => ({ text: opt })),
            duration: 24, // hours
            allowMultiselect: opts?.allowsMultipleAnswers ?? false,
            layoutType: this.discordJs.PollLayoutType.Default,
          },
        };
        if (opts?.replyToMessageId) {
          pollData.reply = { messageReference: opts.replyToMessageId, failIfNotExists: false };
        }
        const sent: DiscordMessage = await channel.send(pollData);
        logger.info({ chatId: rawChannelId, question }, 'Discord poll sent');
        return { success: true, messageId: String(sent.id) };
      }

      // Fallback: text-based poll
      const pollText = `**Poll: ${question}**\n${options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}`;
      return this.sendMessage(chatId, pollText);
    } catch (err) {
      logger.error({ chatId: rawChannelId, err }, 'Failed to send poll');
      // Fallback to text
      const pollText = `**Poll: ${question}**\n${options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}`;
      return this.sendMessage(chatId, pollText);
    }
  }

  async sendButtons(chatId: string, text: string, buttons: ButtonRow[], opts?: BaseOptions): Promise<SendResult> {
    const rawChannelId = ProviderRegistry.stripPrefix(chatId);
    if (!this.discordJs) return { success: false };

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = this.discordJs;

    try {
      const channel = await this.fetchChannel(rawChannelId);
      if (!channel) return { success: false };

      const components: unknown[] = [];
      for (const row of buttons) {
        const actionRow = new ActionRowBuilder();
        for (const btn of row) {
          const builder = new ButtonBuilder().setLabel(btn.text);
          if (btn.url) {
            builder.setStyle(ButtonStyle.Link).setURL(btn.url);
          } else {
            const cbId = this.registerCallbackData(chatId, btn.callbackData || btn.text, btn.text);
            builder.setStyle(ButtonStyle.Primary).setCustomId(cbId);
          }
          actionRow.addComponents(builder);
        }
        components.push(actionRow);
      }

      const payload: Record<string, unknown> = { content: text, components };
      if (opts?.replyToMessageId) {
        payload.reply = { messageReference: opts.replyToMessageId, failIfNotExists: false };
      }
      const sent: DiscordMessage = await channel.send(payload);
      logger.info({ chatId: rawChannelId }, 'Discord buttons sent');
      return { success: true, messageId: String(sent.id) };
    } catch (err) {
      logger.error({ chatId: rawChannelId, err }, 'Failed to send Discord buttons');
      return { success: false };
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<SendResult> {
    const rawChannelId = ProviderRegistry.stripPrefix(chatId);
    try {
      const channel = await this.fetchChannel(rawChannelId);
      if (!channel) return { success: false };
      const message: DiscordMessage = await channel.messages.fetch(messageId);
      await message.edit({ content: text });
      return { success: true, messageId };
    } catch (err) {
      logger.error({ chatId: rawChannelId, messageId, err }, 'Failed to edit Discord message');
      return { success: false };
    }
  }

  async deleteMessage(chatId: string, messageId: string): Promise<SendResult> {
    const rawChannelId = ProviderRegistry.stripPrefix(chatId);
    try {
      const channel = await this.fetchChannel(rawChannelId);
      if (!channel) return { success: false };
      const message: DiscordMessage = await channel.messages.fetch(messageId);
      await message.delete();
      return { success: true };
    } catch (err) {
      logger.error({ chatId: rawChannelId, messageId, err }, 'Failed to delete Discord message');
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
      // Discord attachments are direct URLs
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), FILE_DOWNLOAD_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(ref, { signal: abortController.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        logger.warn({ url: ref, status: response.status }, 'Failed to download Discord file');
        return { path: null, error: 'download_failed' };
      }

      const contentLength = response.headers.get('content-length');
      const declaredSize = contentLength ? parseInt(contentLength, 10) : NaN;
      if (Number.isFinite(declaredSize) && declaredSize > MAX_ATTACHMENT_BYTES) {
        logger.warn({ url: ref, size: contentLength }, 'Discord file too large (>25MB)');
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
        throw new Error('Discord response had no body');
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
      logger.info({ url: ref, localPath, size: bytesWritten }, 'Downloaded Discord file');
      return { path: localPath };
    } catch (err) {
      const isTooLarge = err instanceof Error && err.message === 'STREAMING_TOO_LARGE';
      if (isTooLarge) {
        logger.warn({ url: ref }, 'Discord file too large (>25MB) during streaming');
      } else {
        logger.error({ url: ref, err }, 'Error downloading Discord file');
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
    return formatDiscordMessage(text, maxLength);
  }

  async setTyping(chatId: string): Promise<void> {
    const rawChannelId = ProviderRegistry.stripPrefix(chatId);
    try {
      const channel = await this.fetchChannel(rawChannelId);
      if (channel) {
        await channel.sendTyping();
      }
    } catch (err) {
      logger.debug({ chatId: rawChannelId, err }, 'Failed to set Discord typing indicator');
    }
  }

  isBotMentioned(message: IncomingMessage): boolean {
    if (!this.botId) return false;
    return message.content.includes(`<@${this.botId}>`) || message.content.includes(`<@!${this.botId}>`);
  }

  isBotReplied(message: IncomingMessage): boolean {
    const raw = message.rawProviderData as {
      referencedMessage?: { author?: { id?: string } };
    } | undefined;
    if (!raw?.referencedMessage?.author?.id || !this.botId) return false;
    return raw.referencedMessage.author.id === this.botId;
  }

  // -- Private helpers --

  private async fetchChannel(channelId: string): Promise<DiscordChannel | null> {
    if (!this.client) return null;
    try {
      return await this.client.channels.fetch(channelId);
    } catch (err) {
      logger.error({ channelId, err }, 'Failed to fetch Discord channel');
      return null;
    }
  }

  private async sendFileAttachment(
    chatId: string,
    filePath: string,
    caption?: string,
    opts?: BaseOptions
  ): Promise<SendResult> {
    const rawChannelId = ProviderRegistry.stripPrefix(chatId);
    for (let attempt = 1; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        const channel = await this.fetchChannel(rawChannelId);
        if (!channel) return { success: false };
        const payload: Record<string, unknown> = {
          files: [filePath],
        };
        if (caption) {
          payload.content = caption;
        }
        if (opts?.replyToMessageId) {
          payload.reply = { messageReference: opts.replyToMessageId, failIfNotExists: false };
        }
        const sent: DiscordMessage = await channel.send(payload);
        logger.info({ chatId: rawChannelId, filePath }, 'Discord file sent');
        return { success: true, messageId: String(sent.id) };
      } catch (err) {
        if (!isRetryableError(err) || attempt === this.config.sendRetries) {
          logger.error({ chatId: rawChannelId, filePath, attempt, err }, 'Failed to send Discord file');
          return { success: false };
        }
        const retryAfterMs = getRetryAfterMs(err);
        const delayMs = retryAfterMs ?? (this.config.sendRetryDelayMs * attempt);
        logger.warn({ chatId: rawChannelId, attempt, delayMs }, 'Discord file send failed; retrying');
        await sleep(delayMs);
      }
    }
    return { success: false };
  }

  private registerCallbackData(chatId: string, data: string, label: string): string {
    const id = generateId('dcb');
    this.callbackDataStore.set(id, { chatId, data, label, createdAt: Date.now() });
    return id;
  }

  private setupHandlers(handlers: ProviderEventHandlers): void {
    if (!this.client) return;

    // Handle message creation
    this.client.on('messageCreate', (message: DiscordMessage) => {
      try {
        // Ignore bot messages
        if (message.author.bot) return;

        const content: string = message.content || '';
        const channelId = String(message.channel.id);
        const chatId = ProviderRegistry.addPrefix('discord', channelId);
        const messageId = String(message.id);

        // Build attachment metadata
        const attachments: ProviderAttachment[] = [];
        if (message.attachments && message.attachments.size > 0) {
          for (const [, attachment] of message.attachments) {
            let type: ProviderAttachment['type'] = 'document';
            const contentType: string = attachment.contentType || '';
            if (contentType.startsWith('image/')) type = 'photo';
            else if (contentType.startsWith('video/')) type = 'video';
            else if (contentType.startsWith('audio/')) {
              // Discord voice messages have a waveform field
              type = attachment.waveform ? 'voice' : 'audio';
            }

            attachments.push({
              type,
              providerFileRef: attachment.url,
              fileName: attachment.name || `attachment_${messageId}`,
              mimeType: contentType || undefined,
              fileSize: attachment.size || undefined,
              duration: attachment.duration || undefined,
              width: attachment.width || undefined,
              height: attachment.height || undefined,
            });
          }
        }

        if (!content && attachments.length === 0) return;

        const isDM = message.channel.type === this.channelTypeDM;
        const isGroup = !isDM;
        const chatType = isDM ? 'dm' : 'guild_text';
        const senderId = String(message.author.id);
        const senderName = message.member?.displayName || message.author.displayName || message.author.username || 'User';
        const timestamp = message.createdAt.toISOString();
        const threadId = message.channel.isThread?.() ? String(message.channel.id) : undefined;

        const chatName = isDM
          ? (message.author.displayName || message.author.username || senderName)
          : (message.guild?.name || senderName);

        const storedContent = content || `[${attachments.map(a => a.type).join(', ')}]`;

        // Build referenced message info for isBotReplied
        let referencedMessage: { author?: { id?: string } } | undefined;
        if (message.reference && message.reference.messageId) {
          // We store the reference; the actual author lookup happens via rawProviderData
          // For efficiency, check cache first
          const cachedRef = message.channel.messages?.cache?.get(message.reference.messageId);
          if (cachedRef) {
            referencedMessage = { author: { id: String(cachedRef.author.id) } };
          }
        }

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
            referencedMessage,
            chatName,
          },
        };

        handlers.onMessage(incoming);
      } catch (err) {
        logger.error({ err }, 'Error handling Discord messageCreate');
      }
    });

    // Handle reactions
    this.client.on('messageReactionAdd', (reaction: DiscordMessage, user: DiscordMessage) => {
      try {
        if (user.bot) return;
        const channelId = String(reaction.message.channel.id);
        const chatId = ProviderRegistry.addPrefix('discord', channelId);
        const messageId = String(reaction.message.id);
        const userId = String(user.id);
        const emoji = reaction.emoji?.name || '';
        if (!emoji) return;

        handlers.onReaction(chatId, messageId, userId, emoji);
      } catch (err) {
        logger.debug({ err }, 'Error handling Discord messageReactionAdd');
      }
    });

    // Handle button interactions
    this.client.on('interactionCreate', async (interaction: DiscordMessage) => {
      try {
        if (!interaction.isButton?.()) return;
        const customId: string = interaction.customId;
        const entry = this.callbackDataStore.get(customId);

        // Acknowledge the interaction
        try {
          await interaction.deferUpdate();
        } catch (ackErr) {
          logger.debug({ err: ackErr }, 'Failed to acknowledge Discord interaction');
        }

        if (!entry) {
          logger.debug({ customId }, 'Unknown Discord callback data');
          return;
        }

        this.callbackDataStore.delete(customId);

        const channelId = String(interaction.channel?.id || '');
        const chatId = channelId
          ? ProviderRegistry.addPrefix('discord', channelId)
          : entry.chatId;

        const senderId = String(interaction.user?.id || '');
        const senderName = interaction.member?.displayName
          || interaction.user?.displayName
          || interaction.user?.username
          || 'User';

        const threadId = interaction.channel?.isThread?.() ? String(interaction.channel.id) : undefined;
        handlers.onButtonClick(chatId, senderId, senderName, entry.label, entry.data, threadId);
      } catch (err) {
        logger.debug({ err }, 'Error handling Discord interactionCreate');
      }
    });
  }
}

export function createDiscordProvider(runtime: RuntimeConfig): DiscordProvider {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN environment variable is required');
  }
  return new DiscordProvider({
    token,
    sendRetries: runtime.host.discord.sendRetries,
    sendRetryDelayMs: runtime.host.discord.sendRetryDelayMs,
    groupsDir: GROUPS_DIR,
  });
}
