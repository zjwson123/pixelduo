# PixelDuo API

Programmatic image generation, billed from your PixelDuo credits at the same
per-image cost as the workbench (e.g. Seedream 6 / GPT medium 8 / GPT high 26
credits per image).

## Authentication

Create an API key in the workbench (**API Keys** tab, `/account/api`). The raw
key (`pd_live_…`) is shown exactly once — store it securely. Send it as a
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
{ "prompt": "…", "model": "gpt|seedream|both", "quality": "low|medium|high", "n": 1 }
```

- `prompt` required (3–2000 chars)
- `model` default `gpt`; `both` generates one image per engine per count
- `quality` default `medium` (ignored for seedream)
- `n` 1–4 images

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
they are session-protected web URLs intended for browser use.

## Limits & errors

- Rate limit: 20 requests/minute per key (HTTP 429 with `Retry-After`)
- Credits are pre-authed at submit and refunded on failure
- Content safety: prompts are filtered (400 `blocked:…`); images pass the same
  post-generation moderation as the web app
- Errors: `401 unauthorized` (bad/revoked key), `403 verify-email-required`,
  `400 invalid-input | blocked:…`, `404 job-not-found`

## Key management

- `POST /api/account/keys` `{ "name": "prod" }` → `{ id, key, prefix }`
- `GET /api/account/keys` → list (no raw keys)
- `POST /api/account/keys/:id/revoke` → revoke immediately
