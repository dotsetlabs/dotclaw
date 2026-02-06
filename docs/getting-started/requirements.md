---
title: Requirements
---

# Requirements

DotClaw is designed for macOS and Linux hosts with Docker installed.

## System

- macOS or Linux
- Node.js 20 or later
- Docker (Desktop on macOS, Docker Engine on Linux)

## Accounts and keys

- **OpenRouter API key** — required for all LLM calls
- **Telegram bot token** — create one via [@BotFather](https://t.me/BotFather) (see [Telegram Setup](telegram-setup.md))
- **Discord bot token** (optional) — create via the [Discord Developer Portal](https://discord.com/developers/applications) with Message Content Intent enabled (see [Discord Setup](discord-setup.md))
- **Brave Search API key** (optional) — enables the WebSearch tool

At least one messaging provider (Telegram or Discord) must be configured.

## Optional dependencies

- **discord.js** — required only if using Discord. Install with `npm install discord.js`.

## Permissions and disk

- Write access to the project directory
- Docker running under your user account
- Docker host policy that allows privileged containers (default runtime mode)
- Free disk space for container images and runtime logs
