# GymOS Deployment Guide

GymOS is designed to run on free-tier cloud services or migrate seamlessly to a self-hosted VPS via Docker and PostgreSQL.

## 1. Local & Docker Deployment

1. Copy `.env.example` to `.env` and set strong credentials for `POSTGRES_PASSWORD`:
   ```bash
   cp .env.example .env
   ```
2. Start the frontend container and PostgreSQL 16 database:
   ```bash
   docker compose up --build -d
   ```
3. Verify `database/migrations/001_initial_schema.sql`, `002_rls_policies.sql`, and `003_indexes_and_constraints.sql` applied cleanly in `gymos-postgres`.
4. Access GymOS at `http://localhost:3000`.

> **Staging/Dev Seed Only**: To populate sample SaaS plans on a non-production database, run `psql "$DATABASE_URL" -f database/seed.dev.sql`. Never run dev seeds in production.

## 2. Node.js / VPS / PaaS Server Deployment

1. Build both the client bundle and production server:
   ```bash
   npm ci
   npm run lint
   npm test
   npm run build
   ```
2. Start the production server (`PORT` defaults to `3000`):
   ```bash
   npm start
   ```
   - Health check endpoint: `GET /healthz`
   - Gym Owner & Staff login portal: `/`
   - Platform Admin login portal: `/admin`

## 3. Firebase Hosting / Cloudflare Pages / Vercel Deployment (Frontend + Firestore)

1. Build the production bundle (`npm run build`).
2. Validate and deploy Firestore rules before releasing client bundles:
   ```bash
   npx eslint firestore.rules
   firebase deploy --only firestore:rules
   ```
3. Deploy `dist/` to Cloudflare Pages (`public/_redirects` included), Vercel (`vercel.json` included), Firebase Hosting, or Nginx on a VPS with SPA fallback (`try_files $uri /index.html;`).

## 3. Supabase + PostgreSQL Migration Path

1. Create a new Supabase project and open the SQL Editor (or connect via `psql "$DATABASE_URL"`).
2. Execute migrations in strict numerical order:
   - `database/migrations/001_initial_schema.sql`
   - `database/migrations/002_rls_policies.sql`
   - `database/migrations/003_indexes_and_constraints.sql`
3. Configure Supabase Auth (Email/Google) so `request.jwt.claim.sub` and `request.jwt.claim.email` resolve automatically inside RLS policies.
4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in your hosting environment.

## 4. Scheduled Automation & Optional n8n

- GymOS includes an in-app batch reminder evaluator (`runReminderBatchForGym`) backed by deduplication keys (`memberId__template__date__channel`).
- For headless cron execution on a VPS or Supabase Edge Function, invoke the reminder job daily at `08:00` local gym time, or point an optional self-hosted n8n workflow to your webhook/Edge Function endpoint.
