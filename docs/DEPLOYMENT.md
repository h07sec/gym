# GymOS Deployment Guide

GymOS uses a unified production architecture: **Firebase Authentication + Cloud Firestore** (enforced by `firestore.rules`), served alongside an **Express Node.js server (`server.ts`)** for static SPA delivery, SMTP email dispatch, Meta WhatsApp Cloud API integration, Super Admin bootstrap, and scheduled reminder sweeps.

## 1. Environment Configuration

Copy `.env.example` to `.env` and configure variables as needed:

```bash
cp .env.example .env
```

- `PORT` (default `3000`) and `APP_URL`
- `FIREBASE_SERVICE_ACCOUNT_JSON` (single-line JSON string) or `GOOGLE_APPLICATION_CREDENTIALS`: Required outside Google Cloud ADC environments for `POST /api/notifications/send`, `POST /api/admin/bootstrap`, `scripts/init-super-admin.mjs`, and `POST /api/cron/reminders` / background automated reminder generation & retry sweeps.
- `SUPER_ADMIN_BOOTSTRAP_TOKEN` and `SUPER_ADMIN_BOOTSTRAP_EMAIL`: Required together for one-time initial Super Admin bootstrap via `/admin` (`POST /api/admin/bootstrap`). Automatically locked via `/platform_bootstrap/default` and invalidated in memory after first success; clear both after setup.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`: Free-first SMTP email configuration for member & owner reminders.
- `WHATSAPP_CLOUD_ACCESS_TOKEN`, `WHATSAPP_API_VERSION`: Optional official Meta WhatsApp Business Cloud API token. Each gym still requires its own Phone Number ID and approved template in **Reminders**.
- `CRON_SECRET`: Shared bearer token protecting `POST /api/cron/reminders`.
- `REMINDER_WORKER_INTERVAL_MINUTES` (default `30`, set `0` to disable): Interval for automatic server-side due-reminder evaluation, in-app/email/WhatsApp dispatch, and exponential-backoff retries (`15m -> 60m -> 240m`, max 3 retries) with distributed Firestore worker locking (`system_locks/*`).

> **Security Note**: Never place private credentials (`SMTP_PASS`, `CRON_SECRET`, `SUPER_ADMIN_BOOTSTRAP_TOKEN`, `WHATSAPP_CLOUD_ACCESS_TOKEN`, `FIREBASE_SERVICE_ACCOUNT_JSON`) in `VITE_*` variables. Server secrets stay exclusively on the Node.js backend.

## 2. Docker Compose Deployment (Reproducible Bun Build)

The multi-stage `Dockerfile` installs dependencies with `bun install --frozen-lockfile` using `bun.lock`, builds `dist/` and `dist-server/server.mjs`, and runs on `node:22-alpine` with a built-in `/healthz` healthcheck:

```bash
docker compose up --build -d
```

Verify container health:
```bash
curl -s http://localhost:3000/healthz
```

## 3. Direct VPS / PaaS Deployment (Bun or Node 22+)

```bash
bun install --frozen-lockfile
bun run lint
bun run lint:rules
bun run test
bun run build
NODE_ENV=production bun run start
```

Endpoints exposed by `dist-server/server.mjs`:
- `GET /` — Gym Owner & Staff portal
- `GET /admin` — Platform Super Admin portal
- `GET /healthz` — Liveness & server capability check (booleans only, no secret values)
- `GET /api/notifications/capabilities` — Email/WhatsApp/Admin SDK readiness flags
- `POST /api/notifications/send` — Authenticated (`Authorization: Bearer <Firebase ID Token>`) SMTP/WhatsApp dispatch
- `POST /api/admin/bootstrap` — Controlled first Super Admin initialization
- `POST /api/cron/reminders` — Headless retry sweep (`Authorization: Bearer <CRON_SECRET>`)

## 4. Deploying Firestore Security Rules

Always lint and deploy `firestore.rules` before releasing frontend changes:

```bash
bun run lint:rules
firebase deploy --only firestore:rules
```

To run the full Firebase Emulator integration suite in CI or on a workstation with Java installed:
```bash
bun run test:emulator
```

## 5. External Cron Setup (Optional)

If running on serverless containers or disabling the in-process interval (`REMINDER_WORKER_INTERVAL_MINUTES=0`), schedule an external cron job daily or hourly:

```bash
curl -X POST https://your-domain.com/api/cron/reminders \
  -H "Authorization: Bearer $CRON_SECRET"
```
