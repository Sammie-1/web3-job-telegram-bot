# Web3 Job Bot

A production-ready Telegram bot that fetches Web3 + Frontend job listings from RSS/APIs and DMs them to you.  
This package is pre-configured to use **Resend** for sending outreach emails (you chose Resend) and will use placeholders for Telegram tokens.

## What you told me
- Bot greeting name: **Emrys**
- Email provider: **Resend**
- You didn't provide a Telegram token (placeholder in .env.example)

## Quickstart (local)
1. Install Node dependencies:
```bash
npm install
```
2. Copy `.env.example` to `.env` and fill your values:
- `TELEGRAM_BOT_TOKEN` (create a bot via BotFather)
- `OWNER_TELEGRAM_ID` (get via @userinfobot)
- `RESEND_API_KEY` (get on https://resend.com)
3. Start the bot:
```bash
npm start
```

## Files of interest
- `bot.js` — main single-file bot (long-polling)
- `.env.example` — environment variables (use Resend)
- `package.json` — deps and start script

## Deploy
Deploy to Render/Railway/Fly.io using the Dockerfile or `npm start`. Make sure to set environment variables in the host dashboard.

## Security
- Do not commit `.env` to public repos.
- Use your Resend API key as the `RESEND_API_KEY`.

