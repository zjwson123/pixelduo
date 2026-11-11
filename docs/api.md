# PixelDuo API

Programmatic image and video generation, billed from your PixelDuo credits at
the same per-unit cost as the workbench (e.g. Seedream 6 / GPT medium 8 / GPT
high 26 credits per image; Seedance 14 credits per second of video).

> **Model availability (2026-08):** `gpt` (GPT Image 2), `seedream` (Seedream 5)
> and `seedance` (Seedance 2.0 video) are live. The Wan 2.7 family
> (`wan-image`, `wan-image-pro`, `wan-t2v`, `wan-i2v`) is temporarily disabled
> until the DashScope key's model restrictions are lifted — requests naming
> them return `400 invalid-input`.

## Authentication

Create an API key in the workbench (**API Keys** tab, `/account/api`) — you'll
confirm your account password (plus a 2FA code when enabled) to mint one. The
raw key (`pd_live_…`) is shown exactly once — store it securely. Send it as a
Bearer token:

```bash
curl -X POST https://pixelduo.ai/api/v1/images/generations \
  -H "Authorization: Bearer pd_live_…" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a minimalist ceramic mug, studio lighting","model":"seedream","n":1}'
```

## Create a generation

`POST /api/v1/images/generations`

```json
{ "prompt": "…", "model": "gpt|seedream|both|seedance", "quality": "low|medium|high", "n": 1, "duration": 5 }
```

- `prompt` required (3–2000 chars)
- `model` default `gpt`; `both` generates one image per engine per count;
  `seedance` creates a video job
- `quality` default `medium` (ignored for seedream)
- `n` 1–4 images (image models only)
- `duration` 4–15 seconds, default 5 (video models only, billed per second)
- Image-to-video models are web-app only: the public API has no image field,
  so pure i2v models are rejected with `400 invalid-input` — use the workbench
- Concurrency: jobs are queued asynchronously — submit freely while earlier
  jobs run. Each user may hold up to **5 in-flight jobs** (queued/running/
  polling); beyond that the API returns `429 queue-full`. Failed/rejected
  submissions never charge (pre-auth is refunded on failure).

Response (async — generation runs in the worker):

```json
{ "ok": true, "jobId": "…", "status": "queued", "costCredits": 6, "duplicate": false }
```

## Poll job status

`GET /api/v1/images/generations/:jobId`

```json
{ "ok": true, "job": { "status": "done", "images": ["https://…presigned…"], "costCredits": 6 } }
```

`images` are presigned object-store URLs (valid ~1h); in self-hosted local mode
they are session-protected web URLs intended for browser use. Video jobs go
through `queued → polling → done` (async provider task, typically 1–3 min).

## Limits & errors

- Rate limit: 20 requests/minute per key (HTTP 429 with `Retry-After`)
- Fetching delivered files from `/api/files/…` is capped at 64 concurrent
  responses per account and 128 per instance, with a 2-minute idle deadline
  (HTTP 429 `too-many-streams` with `Retry-After`). Read each body; a client
  that opens responses and never consumes them holds a storage handle until the
  idle deadline retires it. The last quarter of the instance ceiling (32 slots)
  is a fair-share reserve: an account already holding 8 streams cannot take
  from it, so one or two stream-parking accounts cannot blank every other
  tenant's media.
- Credits are pre-authed at submit and refunded on failure
- Content safety: prompts are filtered (400 `blocked:…`); images pass the same
  post-generation moderation as the web app
- Errors: `401 unauthorized` (bad/revoked key), `403 verify-email-required`,
  `400 invalid-input | blocked:…`, `404 job-not-found`
- A request path that is not valid percent-encoded UTF-8 (for example a lone
  `%`, or `%FF`) is refused with `400 invalid-path` before routing; escape
  reserved and non-ASCII bytes in IDs and keys rather than sending them raw.

## Key management

Creating a key requires re-authentication — a hijacked session alone must not be
able to mint a long-lived credential. The account password goes in the body, and
accounts with 2FA enabled must also pass a current `token` (TOTP) or `backupCode`.

- `POST /api/account/keys` `{ "name": "prod", "password": "…" }` → `{ id, key, prefix }`
  (add `"token": "123456"` or `"backupCode": "…"` when 2FA is enabled; without it:
  `400 2fa-code-required`)
- `GET /api/account/keys` → list (no raw keys)
- `POST /api/account/keys/:id/revoke` → revoke immediately
