export type ProviderName = 'telegram' | 'discord';

export interface IncomingMessage {
  chatId: string;              // Provider-prefixed: "telegram:123" or "discord:456"
  messageId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
  isGroup: boolean;
  chatType: string;            // 'private' | 'group' | 'supergroup' | 'guild_text' | 'dm'
  threadId?: string;
  attachments?: ProviderAttachment[];
  rawProviderData?: unknown;
}

export interface ProviderAttachment {
  type: 'photo' | 'document' | 'voice' | 'video' | 'audio';
  providerFileRef: string;     // Opaque: Telegram file_id, Discord URL
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  duration?: number;
  width?: number;
  height?: number;
  localPath?: string;
  transcript?: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
}

export interface ProviderCapabilities {
  maxMessageLength: number;
  maxAttachmentBytes: number;
  supportsInlineButtons: boolean;
  supportsPoll: boolean;
  supportsVoiceMessages: boolean;
  supportsLocation: boolean;
  supportsContact: boolean;
  supportsReactions: boolean;
  supportsThreads: boolean;
}

export interface BaseOptions {
  replyToMessageId?: string;
  threadId?: string;
}

export interface SendOptions extends BaseOptions {
  parseMode?: string | null;
}

export interface MediaOptions extends BaseOptions {
  caption?: string;
}

export interface VoiceOptions extends BaseOptions {
  caption?: string;
  duration?: number;
}

export interface AudioOptions extends BaseOptions {
  caption?: string;
  duration?: number;
  performer?: string;
  title?: string;
}

export interface ContactOptions extends BaseOptions {
  lastName?: string;
}

export interface PollOptions extends BaseOptions {
  isAnonymous?: boolean;
  type?: 'regular' | 'quiz';
  allowsMultipleAnswers?: boolean;
  correctOptionId?: number;
}

export type ButtonRow = Array<{ text: string; callbackData?: string; url?: string }>;

export interface MessagingProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  start(handlers: ProviderEventHandlers): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;

  sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<SendResult>;
  sendPhoto(chatId: string, filePath: string, opts?: MediaOptions): Promise<SendResult>;
  sendDocument(chatId: string, filePath: string, opts?: MediaOptions): Promise<SendResult>;
  sendVoice(chatId: string, filePath: string, opts?: VoiceOptions): Promise<SendResult>;
  sendAudio(chatId: string, filePath: string, opts?: AudioOptions): Promise<SendResult>;
  sendLocation(chatId: string, lat: number, lng: number, opts?: BaseOptions): Promise<SendResult>;
  sendContact(chatId: string, phone: string, name: string, opts?: ContactOptions): Promise<SendResult>;
  sendPoll(chatId: string, question: string, options: string[], opts?: PollOptions): Promise<SendResult>;
  sendButtons(chatId: string, text: string, buttons: ButtonRow[], opts?: BaseOptions): Promise<SendResult>;

  editMessage(chatId: string, messageId: string, text: string): Promise<SendResult>;
  deleteMessage(chatId: string, messageId: string): Promise<SendResult>;

  downloadFile(ref: string, groupFolder: string, filename: string): Promise<{ path: string | null; error?: string }>;
  formatMessage(text: string, maxLength: number): string[];
  setTyping(chatId: string): Promise<void>;
  isBotMentioned(message: IncomingMessage): boolean;
  isBotReplied(message: IncomingMessage): boolean;
}

export interface ProviderEventHandlers {
  onMessage(message: IncomingMessage): void;
  onReaction(chatId: string, messageId: string, userId: string | undefined, emoji: string): void;
  onButtonClick(chatId: string, senderId: string, senderName: string, label: string, data: string, threadId?: string): void;
}
