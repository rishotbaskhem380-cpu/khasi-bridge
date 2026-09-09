# Talkweave Backend — Setup Guide

This connects Talkweave to the real Google Cloud Translation API without
ever putting the real key in the app, GitHub, or an APK.

## 1. Install Wrangler (Cloudflare's CLI)
```
npm install -g wrangler
wrangler login
```

## 2. Create the project
```
mkdir talkweave-backend && cd talkweave-backend
```
Put `worker.js` in this folder. Create `wrangler.toml`:
```toml
name = "talkweave-backend"
main = "worker.js"
compatibility_date = "2026-09-01"

[vars]
FREE_DAILY_CHAR_LIMIT = "2000"
PREMIUM_DAILY_CHAR_LIMIT = "15000"
MONTHLY_BUDGET_CHARS = "450000"

[[kv_namespaces]]
binding = "USAGE"
id = "PASTE_YOUR_KV_ID_HERE"
```

## 3. Create the KV namespace (usage tracking + premium list)
```
wrangler kv namespace create USAGE
```
Copy the `id` it prints into `wrangler.toml` above.

## 4. Add your secrets (never committed to GitHub, never in the app)
```
wrangler secret put GOOGLE_API_KEY
wrangler secret put ADMIN_KEY
wrangler secret put KOFI_VERIFICATION_TOKEN
```
- `GOOGLE_API_KEY`: your real key from Google Cloud Console (Translation API enabled, billing on).
- `ADMIN_KEY`: make up any long random password — only you use it, to check stats / flip the kill switch.
- `KOFI_VERIFICATION_TOKEN`: found in Ko-fi → Settings → API → Webhooks.

## 5. Deploy
```
wrangler deploy
```
You'll get a URL like `https://talkweave-backend.YOURNAME.workers.dev`.

## 6. Connect Ko-fi
Ko-fi → Settings → Webhooks → set the URL to:
```
https://talkweave-backend.YOURNAME.workers.dev/kofi-webhook
```
Now a successful Ko-fi payment automatically marks that payer's email premium for 31 days.

## 7. Check usage / cost anytime
```
curl -H "X-Admin-Key: YOUR_ADMIN_KEY" https://talkweave-backend.YOURNAME.workers.dev/admin/stats
```
Shows characters used this month, % of your budget, and estimated cost beyond the free 500k.

## 8. Kill switch (disable API instantly, no redeploy)
```
curl -X POST -H "X-Admin-Key: YOUR_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"enabled": false}' \
  https://talkweave-backend.YOURNAME.workers.dev/admin/config
```
Set `"enabled": true` to turn it back on.

## 9. Update the app
The app must call `https://talkweave-backend.YOURNAME.workers.dev/translate`
instead of the direct Google endpoints, sending `{ text, source, target, deviceId, email }`.
`deviceId` should be a random ID the app generates once and reuses (not personal info —
just for rate-limiting abuse). `email` is only sent if the user typed their premium email in-app.

I can make this index.html change whenever you're ready — just say so.

## What's protected
- Real key: only ever in the Worker's secret store, never in the app/APK/GitHub/logs.
- Per-user daily caps (free vs premium) prevent one user running up a bill.
- Global monthly budget cap protects you even if many users hit their limits.
- Kill switch lets you shut off the API instantly if you spot abuse.
- Errors from Google are never passed through raw, so nothing key-adjacent can leak.
