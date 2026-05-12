# 🪁 Notifly

> A beautiful, AI-powered GitHub notifications inbox — built as a PWA with digest delivery and smart labeling via Pollinations AI.

![dark theme](https://img.shields.io/badge/theme-dark-0d1117?style=flat-square) ![PWA](https://img.shields.io/badge/PWA-ready-6366f1?style=flat-square) ![deploy](https://img.shields.io/badge/deploy-Vercel-black?style=flat-square)

---

## Features

- **GitHub Notifications Inbox** — clean card layout, filter by label/repo/priority/read state
- **AI Auto-labeling** — Pollinations AI classifies each notification: `mention`, `review-requested`, `ci-failure`, `noise`, `fyi`
- **AI Priority Scoring** — `high` / `medium` / `low` with color coding and a pulsing indicator for high items
- **Dashboard** — AI overview summary, stats bar, priority queue, most active repos
- **Digest Page** — scannable AI-generated digest, viewable offline via localStorage cache
- **Scheduled Delivery** — Vercel Cron sends digests via Discord webhook and/or Web Push
- **BYOP AI** — each user authorizes with their own Pollinations account; no shared quota
- **PWA** — installable, offline shell, Web Push notifications

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Browser (PWA)                              │
│                                                                     │
│  ┌──────────────┐   ┌─────────────────────────────────────────┐    │
│  │  Service     │   │  app.js (SPA)                           │    │
│  │  Worker      │   │  ┌──────────┐ ┌──────────┐ ┌────────┐  │    │
│  │  (offline    │   │  │  Inbox   │ │Dashboard │ │Digest  │  │    │
│  │   shell +    │   │  └──────────┘ └──────────┘ └────────┘  │    │
│  │   push)      │   │  ┌──────────────────────────────────┐   │    │
│  └──────────────┘   │  │  localStorage cache               │   │    │
│                     │  │  (notifs, AI labels, read state,  │   │    │
│                     │  │   digest, display prefs, sk_ key) │   │    │
│                     │  └──────────────────────────────────┘   │    │
│                     └─────────────────────────────────────────┘    │
│         │ direct API calls                  │ direct API calls      │
│         ▼                                   ▼                       │
│  ┌─────────────┐                   ┌──────────────────┐            │
│  │  GitHub API │                   │ Pollinations API  │            │
│  │  (notifs,   │                   │ gen.pollinations. │            │
│  │   mark read)│                   │ ai/v1/chat/...    │            │
│  └─────────────┘                   └──────────────────┘            │
└─────────────────────────────────────────────────────────────────────┘
                │ session cookie              │ OAuth code exchange
                ▼                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Vercel Serverless Functions                     │
│                                                                     │
│  /api/auth/login        → redirect to GitHub OAuth                 │
│  /api/auth/callback     → exchange code, store token, set cookie   │
│  /api/user/me           → return prefs (discord, digest, digest)   │
│  /api/user/save-prefs   → store discord webhook, push sub, sk_     │
│  /api/cron/digest       → fetch notifs → AI summarize → deliver    │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────┐     │
│  │                     Vercel KV                             │     │
│  │  user:{uid}:github_token        (GitHub OAuth token)      │     │
│  │  user:{uid}:pollinations_key    (Pollinations sk_ key)     │     │
│  │  user:{uid}:discord_webhook     (Discord webhook URL)      │     │
│  │  user:{uid}:digest_schedule     (morning/nightly/weekly)   │     │
│  │  user:{uid}:push_sub            (Web Push subscription)    │     │
│  │  user:{uid}:latest_digest       (last digest JSON)         │     │
│  │  session:{sid}                  (sid → uid mapping)        │     │
│  │  users:all                      (set of all user IDs)      │     │
│  └───────────────────────────────────────────────────────────┘     │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────┐     │
│  │                    Vercel Cron                            │     │
│  │  0 7  * * *  →  /api/cron/digest  (morning digest)        │     │
│  │  0 21 * * *  →  /api/cron/digest  (nightly digest)        │     │
│  └───────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
         │ webhook POST                    │ Web Push
         ▼                                 ▼
   ┌───────────┐                   ┌──────────────┐
   │  Discord  │                   │  Browser     │
   │  Channel  │                   │  Push (VAPID)│
   └───────────┘                   └──────────────┘
```

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/yourname/notifly
cd notifly
npm install
```

### 2. Create GitHub OAuth App

1. Go to [github.com/settings/developers](https://github.com/settings/developers)
2. Click **New OAuth App**
3. Set:
   - **Application name**: Notifly
   - **Homepage URL**: `https://yourapp.vercel.app`
   - **Authorization callback URL**: `https://yourapp.vercel.app/api/auth/callback`
4. Copy **Client ID** and generate a **Client Secret**

### 3. Create Pollinations App Key

1. Go to [enter.pollinations.ai](https://enter.pollinations.ai)
2. Create a new app key (`pk_...`)
3. Set redirect URI to `https://yourapp.vercel.app`

### 4. Generate VAPID keys

```bash
npm run generate-vapid
```

Copy the output into your environment variables.

### 5. Generate SESSION_SECRET

```bash
openssl rand -hex 32
```

### 6. Create Vercel KV store

1. Open your Vercel project → **Storage** tab
2. Create a new **KV** store and link it to your project
3. Env vars are auto-injected: `KV_REST_API_URL` and `KV_REST_API_TOKEN`

### 7. Set environment variables in Vercel

| Variable | How to get it |
|---|---|
| `GITHUB_CLIENT_ID` | GitHub OAuth app → Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app → Client Secret |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `KV_REST_API_URL` | Auto-injected by Vercel KV |
| `KV_REST_API_TOKEN` | Auto-injected by Vercel KV |
| `VAPID_PUBLIC_KEY` | `npm run generate-vapid` |
| `VAPID_PRIVATE_KEY` | `npm run generate-vapid` |
| `VAPID_SUBJECT` | `mailto:you@example.com` |
| `POLLINATIONS_APP_KEY` | enter.pollinations.ai → your `pk_...` key |

### 8. Update manifest.json

After generating keys, paste them into `public/manifest.json`:

```json
{
  "pollinations_app_key": "pk_yourkey",
  "vapid_public_key": "BYourVapidPublicKey..."
}
```

### 9. Deploy

```bash
vercel --prod
```

---

## Local development

```bash
vercel dev
```

Runs the full stack locally including serverless functions on `http://localhost:3000`.

---

## PWA Icons

The repo ships with solid indigo placeholder icons. For production, replace:

- `public/icons/icon-32.png`  — 32×32 favicon
- `public/icons/icon-192.png` — 192×192 PWA icon
- `public/icons/icon-512.png` — 512×512 splash icon

SVG sources are at `public/icons/icon-*.svg`.

---

## AI features (Pollinations BYOP)

Notifly uses [Pollinations](https://pollinations.ai) for all AI features. Each user authorizes with their own Pollinations account:

1. After GitHub auth, user is redirected to `enter.pollinations.ai/authorize`
2. Pollinations redirects back with `#api_key=sk_...` in the URL fragment
3. App stores `sk_` in `localStorage` (for client-side calls) and Vercel KV (for cron digest)

The app is identified only by your `POLLINATIONS_APP_KEY` — used solely to build the authorize URL, never sent in API calls.

All AI calls use model `nova-fast` on `https://gen.pollinations.ai/v1/chat/completions`.

---

## Digest delivery

Configure in **Settings**:

- **Discord**: paste your webhook URL (`Server Settings → Integrations → Webhooks`)
- **Schedule**: morning (7 AM UTC), nightly (9 PM UTC), weekly (Sunday 8 AM UTC)
- **Web Push**: tick the checkbox and save — requires HTTPS

The Vercel Cron job fires on schedule, fetches notifications, generates an AI digest using your stored sk_ key, and delivers via Discord embed and/or Web Push. The digest is also stored in KV so the PWA can display it offline.

---

## License

MIT
