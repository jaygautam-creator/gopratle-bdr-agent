# Setup

Everything here is free. Put every value in `.env` (copy from `.env.example`). Never paste keys into chat, issues or commits; `.env` is git-ignored.

## 1. Run n8n
```bash
cp .env.example .env
# set N8N_ENCRYPTION_KEY to any long random string:  openssl rand -hex 24
make up        # http://localhost:5678 (create the owner account on first visit)
make import    # loads the 4 workflows
```
Docker Desktop must be running. If you keep Docker's data on an external drive, make sure it is mounted first.

## 2. Keys

| Key | Where to get it | `.env` variable |
|---|---|---|
| Gemini | https://aistudio.google.com/apikey -> Create API key (no card) | `GEMINI_API_KEY` |
| Tavily | https://tavily.com -> dashboard -> API key (`tvly-...`, ~1,000 free credits/month) | `TAVILY_API_KEY` |
| Telegram bot | Telegram -> **@BotFather** -> `/newbot` -> copy the token | `TELEGRAM_BOT_TOKEN` |
| Your chat id | Send any message to your new bot, then run the one-liner below | `TELEGRAM_ALLOWED_CHAT_IDS` (comma-separated; the first is the admin and receives error alerts) |
| Sandbox inbox | A second Gmail address you control. All outreach is delivered here | `SANDBOX_INBOX` (a placeholder is refused) |
| Serper (optional) | https://serper.dev, 2,500 free searches. Backup for Tavily | `SERPER_API_KEY` |
| Hunter (optional) | https://hunter.io, ~50 free credits/month. Adds confirmed emails | `HUNTER_API_KEY` |

Find your chat id (the token stays in your shell, nothing is printed except ids):
```bash
set -a; . ./.env; set +a
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" | python3 -c "import sys,json;print({u['message']['chat']['id'] for u in json.load(sys.stdin)['result'] if 'message'})"
```

Gemini model names default to free-tier-friendly Flash-Lite models. Check **AI Studio -> Rate Limit** for your own account's limits before changing them: on some accounts the full Flash models allow only 20 requests/day.

## 3. Run the workflows
Open http://localhost:5678, open each workflow, and either press **Execute workflow** (one run) or switch **Active** on (runs on its schedule). Activate `BDR 99 - Error alerts` too, and set it as the error workflow if your n8n did not pick the setting up from the import.

Without n8n you can drive the same code from a terminal: `node scripts/run_local.js tick`.

## 4. Switch to real Google (when ready)
See [setup-google.md](setup-google.md), then set `STORE_BACKEND=sheets` and `MAIL_BACKEND=gmail` and `make up` again.
