# Aura Dashboard — Railway Deployment Guide

## Environment Variables

Set these in Railway's **Variables** tab:

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | Yes | Groq API key for chat, voice parsing, insights, and briefings |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (only needed for goal polish endpoint) |
| `VAPID_PUBLIC_KEY` | Yes | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | Yes | Web Push VAPID private key |
| `VAPID_CONTACT` | No | Contact email for VAPID (defaults to `dev@example.com`) |
| `PORT` | No | Server port (Railway sets this automatically) |
| `TZ` | No | Timezone (defaults to `America/New_York` via server.js) |

## Persistent Volume Setup

The app stores all user data as JSON files in the `data/` directory. Railway containers are **ephemeral** — without a volume, all data is lost on every redeploy.

### Configure a Railway Volume

1. In your Railway project, go to **Settings → Volumes**
2. Mount a volume at **`/app/data`** with a **1 GB** size limit
3. Redeploy

The server resolves the data directory as `path.join(__dirname, 'data')`, which maps to `/app/data` in the container. Mount the volume directly at `/app/data` — no code changes needed.

### Data Files

On first deploy, these files are created automatically on first write:

- `data/water.json` — water intake log
- `data/workouts.json` — workout sessions
- `data/expenses.json` — expense entries
- `data/goals.json` — daily goal items
- `data/user_context.json` — synced client context
- `data/insights_cache.json` — AI-generated insights cache
- `data/push_subscriptions.json` — web push subscriptions

The `loadDataFile()` function returns `[]` if a file doesn't exist yet, so the app works out of the box without pre-seeding.

## HTTPS & Browser Security

### HTTPS

Railway provides HTTPS automatically. No configuration needed.

### Same-Origin Architecture

The Express server serves both the API endpoints and `dashboard.html` from the same process. There is **no cross-origin communication** — the browser loads the page and calls the API on the same origin. CORS middleware is intentionally omitted.

### Web Speech API (Voice Logging)

The `webkitSpeechRecognition` API requires a **secure context** (HTTPS). Railway's default HTTPS satisfies this requirement. Microphone access will not work over plain HTTP.

### Blocked Routes

The server blocks direct HTTP access to sensitive paths:

- `/.env`, `/server.js`, `/package.json`, `/package-lock.json`, `/.gitignore`
- `/data/*` (all JSON storage files)

These return HTTP 403.

## Cron Jobs

Three scheduled tasks run in the server process:

| Schedule (ET) | Job |
|---------------|-----|
| Every 12 hours | Regenerate cross-domain insights |
| 7:00 AM | Morning push briefing |
| 12:00 PM | Midday check-in push |
| 9:00 PM | Evening briefing push |

These run inside the Node process via `node-cron`. If Railway restarts the container, they resume on the next schedule tick.

## Deployment Steps

```bash
# 1. Install Railway CLI (if not already)
npm i -g @railway/cli

# 2. Login
railway login

# 3. Link to existing project (or create new)
railway link

# 4. Set environment variables
railway variables set GROQ_API_KEY=your_key_here
railway variables set VAPID_PUBLIC_KEY=your_key_here
railway variables set VAPID_PRIVATE_KEY=your_key_here

# 5. Create volume at /app/data (via Railway dashboard)

# 6. Deploy
railway up
```

## Post-Deploy Verification

1. Open the live URL — should redirect to `/dashboard.html`
2. Check that `GET /api/notifications/vapid-public-key` returns your public key
3. Test voice logging (requires HTTPS — should work on Railway)
4. Verify push notifications register successfully
5. Confirm data persists across redeploys by logging water/workouts, then redeploying
