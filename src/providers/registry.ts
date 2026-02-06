import type { ProviderName, MessagingProvider } from './types.js';

const VALID_PREFIXES = new Set<string>(['telegram', 'discord']);

export class ProviderRegistry {
  private providers = new Map<ProviderName, MessagingProvider>();

  register(provider: MessagingProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: ProviderName): MessagingProvider | undefined {
    return this.providers.get(name);
  }

  getProviderForChat(chatId: string): MessagingProvider {
    const prefix = ProviderRegistry.getPrefix(chatId);
    const provider = this.providers.get(prefix);
    if (!provider) {
      throw new Error(`No provider registered for prefix "${prefix}" (chatId: ${chatId})`);
    }
    return provider;
  }

  getAllProviders(): MessagingProvider[] {
    return Array.from(this.providers.values());
  }

  has(name: ProviderName): boolean {
    return this.providers.has(name);
  }

  static stripPrefix(chatId: string): string {
    const idx = chatId.indexOf(':');
    return idx >= 0 ? chatId.slice(idx + 1) : chatId;
  }

  static addPrefix(provider: ProviderName, rawId: string): string {
    return `${provider}:${rawId}`;
  }

  static getPrefix(chatId: string): ProviderName {
    const idx = chatId.indexOf(':');
    if (idx < 0) {
      throw new Error(`Chat ID "${chatId}" has no provider prefix`);
    }
    const prefix = chatId.slice(0, idx);
    if (!VALID_PREFIXES.has(prefix)) {
      throw new Error(`Unknown provider prefix "${prefix}" in chatId "${chatId}"`);
    }
    return prefix as ProviderName;
  }

  static hasPrefix(chatId: string): boolean {
    const idx = chatId.indexOf(':');
    if (idx < 0) return false;
    return VALID_PREFIXES.has(chatId.slice(0, idx));
  }
}
