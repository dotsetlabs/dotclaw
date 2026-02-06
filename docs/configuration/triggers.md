---
title: Triggers and Mentions
---

# Triggers and Mentions

DotClaw decides whether to process a message based on four conditions. If **any** of them is true, the bot processes the message:

```
shouldProcess = isPrivate || mentioned || replied || triggered
```

## Conditions

| Condition | When it's true |
|-----------|---------------|
| **Private** | The message is a DM (direct message). The bot always responds in DMs. |
| **Mentioned** | The message @mentions the bot (Telegram: `@bot_username`, Discord: `<@bot_id>`) |
| **Replied** | The message is a reply to one of the bot's messages |
| **Triggered** | The message matches a trigger regex defined on the registered group |

In group chats, the bot ignores messages unless at least one of mentioned, replied, or triggered is true.

## Setting a trigger regex

Add a `trigger` field to the group entry in `~/.dotclaw/data/registered_groups.json`:

```json
{
  "telegram:-987654321": {
    "name": "dev-team",
    "folder": "dev-team",
    "added_at": "2026-01-01T00:00:00.000Z",
    "trigger": "(build|deploy|incident)"
  }
}
```

The trigger value is a JavaScript regex pattern (without delimiters). It's matched case-insensitively against the full message text.

### Common trigger patterns

| Pattern | Effect |
|---------|--------|
| `".*"` | Bot responds to **every** message in the channel |
| `"(help\|bug\|issue)"` | Bot responds when message contains "help", "bug", or "issue" |
| `"^!"` | Bot responds to messages starting with `!` |
| `"(build\|deploy\|release)"` | Bot responds to DevOps-related keywords |

## Telegram group privacy

By default, Telegram only delivers messages to bots that @mention them, reply to them, or are commands (starting with `/`). If you want trigger-based matching on **all** group messages:

1. Send `/setprivacy` to `@BotFather`
2. Select your bot
3. Choose **Disable**

Without this, Telegram won't deliver non-mention messages to the bot, so triggers won't fire on those messages.

This setting doesn't affect DMs — bots always receive all DM messages.

## Discord behavior

Discord bots with the **Message Content Intent** enabled receive all messages in channels they have access to. No additional privacy configuration is needed for triggers to work.

## Respond to all messages

To make the bot respond to every message in a channel (not just mentions/replies), set the trigger to `".*"`:

```json
{
  "discord:1234567890123456789": {
    "name": "always-on",
    "folder": "always-on",
    "added_at": "2026-01-01T00:00:00.000Z",
    "trigger": ".*"
  }
}
```

For Telegram groups, you must also disable privacy mode via BotFather (see above).
