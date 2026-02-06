---
name: setup
description: Run initial DotClaw setup. Use when user wants to install dependencies, configure Telegram bot, register their main channel, or start the background services. Triggers on "setup", "install", "configure dotclaw", or first-time setup requests.
---

# DotClaw Setup

Run all commands automatically. Only pause when user action is required (creating Telegram bot, getting Discord bot token).

## 1. Install Dependencies

```bash
npm install
```

## 2. Install Docker

Check if Docker is installed and running:

```bash
docker --version && docker info >/dev/null 2>&1 && echo "Docker is running" || echo "Docker not running or not installed"
```

If not installed or not running, tell the user:
> Docker is required for running agents in isolated environments.
>
> **macOS:**
> 1. Download Docker Desktop from https://docker.com/products/docker-desktop
> 2. Install and start Docker Desktop
> 3. Wait for the whale icon in the menu bar to stop animating
>
> **Linux:**
> ```bash
> curl -fsSL https://get.docker.com | sh
> sudo systemctl start docker
> sudo usermod -aG docker $USER  # Then log out and back in
> ```
>
> Let me know when you've completed these steps.

Wait for user confirmation, then verify:

```bash
docker run --rm hello-world
```

**Note:** DotClaw checks that Docker is running when it starts, but does not auto-start Docker. Make sure Docker Desktop is running (macOS) or the docker service is started (Linux).

## 3. Configure API Keys

### OpenRouter API Key (Required)

Ask the user:
> I need your OpenRouter API key. You can get one from https://openrouter.ai/keys
>
> Paste it here and I'll configure it.

Save it to `~/.dotclaw/.env`:

```bash
mkdir -p ~/.dotclaw
echo "OPENROUTER_API_KEY=THEIR_KEY_HERE" > ~/.dotclaw/.env
```

### Brave Search API Key (Optional)

Ask the user:
> Do you have a Brave Search API key? This enables web search capabilities for the agent.
> You can get one from https://brave.com/search/api/ (optional, skip if you don't have one).

If they provide one, append to `.env`:

```bash
echo "BRAVE_SEARCH_API_KEY=THEIR_KEY_HERE" >> ~/.dotclaw/.env
```

## 4. Build Container Image

Build the DotClaw agent container:

```bash
./container/build.sh
```

This creates the `dotclaw-agent:latest` image with Node.js, the agent runner, and browser automation tools.

Verify the build succeeded:

```bash
docker images | grep dotclaw-agent
echo '{}' | docker run -i --entrypoint /bin/echo dotclaw-agent:latest "Container OK" || echo "Container build failed"
```

## 5. Telegram Bot Setup

**USER ACTION REQUIRED**

Tell the user:
> I need you to create a Telegram bot. Here's how:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Start a chat and send: `/newbot`
> 3. Follow the prompts:
>    - **Name:** Something friendly (e.g., "My Assistant" or your preferred name)
>    - **Username:** Must end with "bot" and be unique (e.g., "my_assistant_bot")
> 4. BotFather will give you a token like: `123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`
> 5. **Copy this token** - you'll need it in a moment
>
> Let me know when you have the token.

When they provide the token, save it to `.env`:

```bash
echo "TELEGRAM_BOT_TOKEN=YOUR_TOKEN_HERE" >> ~/.dotclaw/.env
```

Verify the token:

```bash
source ~/.dotclaw/.env
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | jq '.result.username'
```

If it returns a username, the token is valid. If it returns an error, have the user check their token.

## 5b. Discord Bot Setup (Optional)

Ask the user:
> Do you also want to connect Discord? (optional)

If yes, tell the user:
> 1. Go to https://discord.com/developers/applications
> 2. Click **New Application**, give it a name
> 3. Go to **Bot** tab, click **Reset Token**, and copy the token
> 4. Under **Privileged Gateway Intents**, enable **Message Content Intent**
> 5. Go to **OAuth2 → URL Generator**, select `bot` scope with `Send Messages`, `Read Message History`, `Attach Files` permissions
> 6. Open the generated URL to invite the bot to your server
>
> Paste the bot token here.

Save Discord token:

```bash
echo "DISCORD_BOT_TOKEN=THEIR_TOKEN_HERE" >> ~/.dotclaw/.env
```

## 6. Get Chat ID and Register Main Channel

Tell the user:
> Now I need your chat ID so I can register you as the main channel.
>
> **For Telegram:**
> 1. Open Telegram and search for your bot (the username from BotFather)
> 2. Start a chat with your bot and send any message (e.g., "hello")
> 3. Let me know when you've done this.

After they confirm, get the chat ID:

```bash
source ~/.dotclaw/.env
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | jq '.result[-1].message.chat'
```

Save the chat ID for registration. Use the `dotclaw register` CLI or the bootstrap command:

```bash
npm run bootstrap
```

Or manually create `~/.dotclaw/data/registered_groups.json`:

```bash
mkdir -p ~/.dotclaw/data ~/.dotclaw/groups/main/logs

cat > ~/.dotclaw/data/registered_groups.json << EOF
{
  "telegram:CHAT_ID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  }
}
EOF
```

Replace `CHAT_ID_HERE` with the actual chat ID and `@ASSISTANT_NAME` with the trigger word.

**Note:** Chat IDs are provider-prefixed (e.g., `telegram:123456789` or `discord:987654321`).

## 7. Configure Assistant Name

Ask the user:
> What trigger word do you want to use? (default: `Rain`)
>
> In group chats, messages starting with `@TriggerWord` will be sent to the agent.
> In DMs with the bot, all messages go to the agent.

If they choose something other than `Rain`, update it in:
1. `~/.dotclaw/groups/global/CLAUDE.md` - Change the persona name
2. `~/.dotclaw/groups/main/CLAUDE.md` - Same changes
3. `~/.dotclaw/data/registered_groups.json` - Use `@NewName` as the trigger

## 8. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the DotClaw project?
>
> Examples: Git repositories, project folders, documents you want the agent to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist:

```bash
mkdir -p ~/.config/dotclaw
cat > ~/.config/dotclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
```

If **yes**, collect directory paths and create the allowlist accordingly.

## 9. Initialize Runtime Configuration

Run the init script to create default config files:

```bash
npm run init
```

Or use the full interactive bootstrap:

```bash
npm run bootstrap
```

## 10. Build and Start

```bash
npm run build
```

For macOS (launchd):

```bash
dotclaw setup  # Creates service plist and starts it
```

Or manually:

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

cat > ~/Library/LaunchAgents/com.dotclaw.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dotclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${HOME_PATH}/.dotclaw/logs/dotclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME_PATH}/.dotclaw/logs/dotclaw.error.log</string>
</dict>
</plist>
EOF

mkdir -p ~/.dotclaw/logs
launchctl load ~/Library/LaunchAgents/com.dotclaw.plist
```

Verify it's running:
```bash
launchctl list | grep dotclaw
```

## 11. Test

Tell the user:
> Send a message to your bot in Telegram (or Discord if configured).

Check the logs:
```bash
dotclaw logs --follow
# or: tail -f ~/.dotclaw/logs/dotclaw.log
```

The user should receive a response from the bot.

## Troubleshooting

**Service not starting**: Check `~/.dotclaw/logs/dotclaw.error.log`

**Docker not running**:
- macOS: Start Docker Desktop from Applications
- Linux: `sudo systemctl start docker`
- Verify: `docker info`

**Container agent fails**:
- Check container logs: `ls -t ~/.dotclaw/groups/main/logs/container-*.log | head -1 | xargs cat | tail -50`
- Verify API key: `grep OPENROUTER_API_KEY ~/.dotclaw/.env`

**No response to messages**:
- Verify chat ID is in `~/.dotclaw/data/registered_groups.json` (with provider prefix)
- Check `~/.dotclaw/logs/dotclaw.log` for errors
- Verify bot token: `source ~/.dotclaw/.env && curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"`

**Unload service**:
```bash
launchctl unload ~/Library/LaunchAgents/com.dotclaw.plist
```

**Run diagnostics**:
```bash
dotclaw doctor
```
