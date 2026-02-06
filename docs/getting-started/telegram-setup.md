---
title: Telegram Setup
---

# Telegram Setup

This guide walks through creating a Telegram bot and connecting it to DotClaw.

## 1. Create a bot with BotFather

1. Open Telegram and search for `@BotFather`
2. Start a chat and send `/newbot`
3. Follow the prompts:
   - **Name**: A friendly display name (e.g. "My Assistant")
   - **Username**: Must end with `bot` and be unique (e.g. `my_assistant_bot`)
4. BotFather will reply with a **bot token** like `123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`
5. Copy this token

## 2. Configure group privacy (optional)

By default, Telegram bots only receive messages that mention them or are replies to their messages. If you want the bot to see **all** messages in a group chat (for trigger-based responses), send `/setprivacy` to BotFather:

1. Send `/setprivacy` to `@BotFather`
2. Select your bot
3. Choose **Disable**

This allows the bot to receive all group messages. Without this, the bot only receives messages that @mention it, reply to it, or are commands (starting with `/`).

For DMs (private chats), the bot always receives all messages regardless of this setting.

## 3. Save the bot token

Add the token to your DotClaw environment:

```bash
echo "TELEGRAM_BOT_TOKEN=YOUR_TOKEN_HERE" >> ~/.dotclaw/.env
```

## 4. Get your chat ID

Start a conversation with your bot, then retrieve the chat ID:

```bash
source ~/.dotclaw/.env
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | jq '.result[-1].message.chat.id'
```

For group chats, add the bot to the group first, send a message, then run the same command. Group chat IDs are negative numbers (e.g. `-987654321`).

## 5. Register the chat

Use the bootstrap or CLI to register your chat:

```bash
npm run bootstrap
```

Or manually add it to `~/.dotclaw/data/registered_groups.json`:

```json
{
  "telegram:YOUR_CHAT_ID": {
    "name": "main",
    "folder": "main",
    "added_at": "2026-01-01T00:00:00.000Z"
  }
}
```

Chat IDs must be prefixed with `telegram:` (e.g. `telegram:123456789` or `telegram:-987654321`).

## 6. Enable the provider

Telegram is enabled by default. If you previously disabled it, re-enable in `~/.dotclaw/config/runtime.json`:

```json
{
  "host": {
    "telegram": {
      "enabled": true
    }
  }
}
```

## Provider settings

| Setting | Default | Description |
|---------|---------|-------------|
| `host.telegram.enabled` | `true` | Enable/disable the Telegram provider |
| `host.telegram.sendRetries` | `3` | Number of retry attempts for failed message sends |
| `host.telegram.sendRetryDelayMs` | `1000` | Base delay between send retries |
| `host.telegram.handlerTimeoutMs` | auto | Handler timeout; auto-calculated from container timeout + 30s |

## How the bot responds

See [Triggers and Mentions](../configuration/triggers.md) for details on when the bot processes messages.
