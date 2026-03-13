# Admin Setup Guide

## Overview

The license portal includes an **Admin Dashboard** where you can:

- **Configure LLM API keys** — Add one or more Anthropic API keys. All user LLM traffic is routed through these keys.
- **View usage reports** — See token usage per user and per license.
- **Set token limits** — Restrict how many tokens each license can use per billing period.

## First-time setup

### 1. Apply database schema

```bash
cd license-api
npx prisma db push
```

### 2. Create the first admin

**Option A: Bootstrap (recommended)**

1. Set environment variables:
   - `ADMIN_EMAILS` — Comma-separated list of emails that can become admin (e.g. `admin@yourcompany.com`)
   - `BOOTSTRAP_SECRET` — Optional secret; if set, required when calling bootstrap

2. Register a user with one of those emails (or use an existing user).

3. Call the bootstrap endpoint:
   ```bash
   curl -X POST https://your-api/auth/bootstrap-admin \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@yourcompany.com","secret":"YOUR_BOOTSTRAP_SECRET"}'
   ```

**Option B: Direct database update**

Update the user document in MongoDB to set `role: "admin"`.

### 3. Login as admin

Log in at the license portal with your admin email. You’ll be redirected to the Admin Dashboard.

## LLM API keys

- **Add keys** — Admin → LLM API Keys → Add Key. Enter a name and the full API key.
- **Encryption** — For production, set `API_KEY_ENCRYPTION_KEY` (64-char hex) to encrypt keys at rest. If unset, keys are stored as plain text.
- **Fallback** — If no keys are configured in the admin panel, the API uses `ANTHROPIC_API_KEY` from the environment.

## Token limits

- **Per-license limits** — Admin → Token Limits. Set a limit for each license. Leave empty for unlimited.
- **Billing period** — `tokenPeriodDays` defaults to 30 (rolling window).
- **Usage tracking** — Usage is recorded automatically for every stream and complete request.

## Environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Fallback API key when no keys are configured in admin |
| `API_KEY_ENCRYPTION_KEY` | 64-char hex for encrypting API keys in DB (optional) |
| `ADMIN_EMAILS` | Comma-separated emails allowed for bootstrap/promote |
| `BOOTSTRAP_SECRET` | Secret required for `/auth/bootstrap-admin` (optional) |
