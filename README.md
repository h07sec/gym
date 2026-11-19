# GymOS — Multi-Tenant Gym Management SaaS Platform

GymOS is a multi-tenant commercial SaaS platform built for independent fitness centers and studios on a recurring monthly subscription model. All gyms share a single application codebase while keeping tenant data strictly isolated at the database layer.

## Architecture Overview

- **Multi-Tenant Isolation**: Every tenant record carries an explicit `gymId` scope. In the live Firebase runtime (`firestore.rules`), tenant subcollections under `/gyms/{gymId}/*` validate `isGymStaff(gymId)` and `isGymActive(gymId)`. For portable PostgreSQL/Supabase hosting, equivalent database-level Row Level Security (RLS) policies are provided in `database/migrations/002_rls_policies.sql`.
- **Role-Based Access Control (RBAC)**:
  - `SUPER_ADMIN`: Platform governance, SaaS subscription plans, manual Cash/UPI subscription payment verification, gym freeze/reactivation, platform settings, and cross-tenant audit logs.
  - `GYM_OWNER`: Full tenant administration, staff invitations & permission matrix, member management, plans, payments, reports, and gym billing settings.
  - `GYM_MANAGER`: Member/membership operations, plan & payment confirmation per owner-configured permissions.
  - `GYM_RECEPTIONIST`: Member registration, payment recording, status checks, and receipts without sensitive financial report access unless explicitly granted.
- **Zero-Paid-Dependency Design**:
  - Live authentication and real-time multi-tenant database run on Firebase Authentication + Firestore (deployed with `firestore.rules`).
  - Manual Cash and UPI workflows with duplicate UTR detection, idempotent subscription extensions, and printable/downloadable receipts avoid mandatory payment gateway fees.
  - Reminders default to free Email + In-App channels; official WhatsApp Business Cloud API remains strictly disabled unless a gym enters verified Meta Cloud API credentials and an approved template name.
- **Domain Purity**:
  - Month-end & leap-year safe date math (`2024-01-31 + 1m -> 2024-02-29`, `2024-02-29 + 12m -> 2025-02-28`).
  - Confirmed-only revenue metrics in dashboards and daily/monthly reports.
  - Deduplicated reminder scheduling with member opt-out respect and bounded retry caps.

## Project Structure

- `src/lib/domain/`: Pure, unit-tested business logic (`dates.ts`, `payments.ts`, `metrics.ts`, `reminders.ts`, `csv.ts`).
- `src/services/gymos-service.ts`: Transactional Firestore operations, idempotent billing, and audit logging.
- `src/components/super-admin/`: Platform Overview, Gyms Management, Subscription Plans, Manual Subscription Payments, Settings, Audit Logs.
- `src/components/gym/`: Role-aware Gym Dashboard, Members (with CSV import/export & profile history), Membership Plans, Cash/UPI Payments & Receipts, Automated Reminders, Daily/Monthly Reports, Staff Management, Gym Settings.
- `firestore.rules` & `firebase-blueprint.json`: Hardened Firestore schema and RBAC rules.
- `database/migrations/`: Portable PostgreSQL 15+/Supabase SQL schema, RLS policies, and indexes.
- `docs/`: Production deployment, backup/restore, Super Admin setup, and gym onboarding manuals.

## Quick Commands

```bash
npm install
npm run dev        # Start local Vite dev server on port 3000
npm run lint       # TypeScript type-check (tsc --noEmit)
npm test           # Run automated Vitest domain and security-rules suite
npm run build      # Production static bundle in dist/
npx eslint firestore.rules   # Validate Firestore security rules
```

## Documentation

- [Deployment Guide](docs/DEPLOYMENT.md)
- [Backup & Restore Runbook](docs/BACKUP_RESTORE.md)
- [Super Admin Bootstrap & Governance](docs/ADMIN_SETUP.md)
- [Gym Onboarding & Daily Operations](docs/GYM_ONBOARDING.md)
