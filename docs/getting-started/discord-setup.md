---
title: Discord Setup
---

# Discord Setup

This guide walks through creating a Discord bot and connecting it to DotClaw.

## 1. Create a Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**
3. Give it a name (e.g. "DotClaw") and click **Create**

## 2. Create the bot

1. In your application, go to the **Bot** tab
2. Click **Add Bot** (if not already created)
3. Under the bot's username, click **Reset Token** to generate a new token
4. Copy the token — you'll need it in step 5

### Enable Message Content Intent

DotClaw needs to read message content. This requires a privileged intent:

1. On the **Bot** tab, scroll to **Privileged Gateway Intents**
2. Enable **Message Content Intent**
3. Click **Save Changes**

Without this, the bot will connect but won't be able to read message text.

## 3. Set bot permissions

1. Go to the **OAuth2** tab
2. Under **Scopes**, select `bot`
3. Under **Bot Permissions**, select:
   - Send Messages
   - Read Message History
   - Attach Files
   - Use External Emojis
   - Add Reactions
   - Send Messages in Threads

## 4. Invite the bot to your server

1. Still on the **OAuth2** tab, copy the generated URL at the bottom
2. Open the URL in a browser
3. Select the server you want to add the bot to
4. Click **Authorize**

## 5. Install discord.js

Discord support requires the `discord.js` package, which is an optional dependency:

```bash
cd /path/to/dotclaw
npm install discord.js
```

## 6. Save the bot token

Add the token to your DotClaw environment:

```bash
echo "DISCORD_BOT_TOKEN=YOUR_TOKEN_HERE" >> ~/.dotclaw/.env
```

## 7. Get the channel ID

1. In Discord, go to **User Settings > Advanced** and enable **Developer Mode**
2. Right-click the channel you want the bot to respond in
3. Click **Copy Channel ID**

For DMs, the bot uses the DM channel ID automatically.

## 8. Register the channel

Use the bootstrap or CLI to register your channel:

```bash
npm run bootstrap
```

Or manually add it to `~/.dotclaw/data/registered_groups.json`:

```json
{
  "discord:YOUR_CHANNEL_ID": {
    "name": "discord-main",
    "folder": "discord-main",
    "added_at": "2026-01-01T00:00:00.000Z"
  }
}
```

Channel IDs must be prefixed with `discord:` (e.g. `discord:1234567890123456789`).

## 9. Enable the provider

Discord is disabled by default. Enable it in `~/.dotclaw/config/runtime.json`:

```json
{
  "host": {
    "discord": {
      "enabled": true
    }
  }
}
```

Then restart DotClaw.

## Provider settings

| Setting | Default | Description |
|---------|---------|-------------|
| `host.discord.enabled` | `false` | Enable/disable the Discord provider |
| `host.discord.sendRetries` | `3` | Number of retry attempts for failed message sends |
| `host.discord.sendRetryDelayMs` | `1000` | Base delay between send retries |

## How the bot responds

See [Triggers and Mentions](../configuration/triggers.md) for details on when the bot processes messages.

## Capabilities

Discord supports:
- Text messages (up to 2,000 characters, auto-chunked)
- File attachments (up to 25 MB)
- Inline buttons
- Native polls (discord.js v14.15+)
- Reactions
- Threads

Discord does **not** natively support:
- Voice messages (sent as file attachments)
- Location sharing (sent as Google Maps links)
- Contact cards (sent as formatted text)
