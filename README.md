# GymOS — Multi-Tenant Gym Management SaaS Platform

GymOS is a multi-tenant commercial SaaS platform built for independent fitness centers and studios on a recurring monthly subscription model. All gyms share a single application and server infrastructure while keeping tenant data strictly isolated at the database layer.

## Architecture Overview

- **Unified Database & Real-Time Backend**:
  - **Firebase Authentication + Cloud Firestore** (`firestore.rules` & `firebase-blueprint.json`) provide strict multi-tenant data isolation, role-based access control, and schema enforcement across 19 collections.
  - **Express Production Server (`server.ts`)** handles real SMTP email delivery (`nodemailer`), official Meta WhatsApp Business Cloud API delivery, controlled first-admin bootstrap (`POST /api/admin/bootstrap`), scheduled reminder sweeps (`POST /api/cron/reminders`), health checks (`GET /healthz`), and static SPA hosting.
- **Multi-Tenant Isolation**:
  - Every gym tenant lives under `/gyms/{gymId}` with isolated subcollections (`settings`, `staff`, `membership_plans`, `members`, `memberships`, `member_payments`, `payment_receipts`, `attendance`, `notifications`, `notification_logs`).
  - `firestore.rules` validates verified email authentication (`email_verified == true`), active user & staff status, tenant membership (`isGymStaff(gymId)`), and subscription/account activity (`isGymActive(gymId)` checking `accountStatus == 'ACTIVE'`, `subscriptionStatus in ['TRIAL', 'ACTIVE']`, and `subscriptionAccessUntil > request.time`).
- **Role-Based Access Control (RBAC)**:
  - `SUPER_ADMIN`: Platform governance via `/admin` (`platform_admins` registry), SaaS subscription plans, manual Cash/UPI subscription payment verification, gym provisioning/suspension/grace periods, platform settings (`allowPublicRegistration`), and cross-tenant audit logs.
  - `GYM_OWNER`: Full tenant administration, staff invitations & 8-permission matrix, members, membership plans, Cash/UPI payments & receipts, attendance, reminders, reports, and tenant JSON backup/restore.
  - `GYM_MANAGER`, `GYM_RECEPTIONIST`, `GYM_TRAINER`: Tenant operations gated by owner-assigned permissions (`canViewReports`, `canViewPayments`, `canRecordPayments`, `canManagePlans`, `canConfirmPayments`, `canDeleteMembers`, `canManageReminders`, `canManageAttendance`).
- **Zero-Paid-Dependency Billing & Notifications**:
  - Manual Cash and UPI payment workflows with duplicate UTR detection, potential duplicate cash alerts, partial/discounted payment tracking, idempotent SaaS subscription extensions, and immutable `RCP-...` receipts.
  - Reminders support In-App alerts, real server-side SMTP Email, and optional official Meta WhatsApp Cloud API (`WHATSAPP_CLOUD_ACCESS_TOKEN` + gym-configured Phone Number ID and approved template).
- **Domain Purity**:
  - Month-end & leap-year safe date math (`2024-01-31 + 1m -> 2024-02-29`, `2024-02-29 + 12m -> 2025-02-28`).
  - Confirmed-only revenue metrics across dashboards and Daily / Weekly / Monthly / Custom Range / Outstanding Balances / Expiring Memberships reports.
  - Deduplicated reminder evaluation (`EXPIRING_*`, `PAYMENT_DUE_*`, `PAYMENT_OVERDUE_*`, `OWNER_SUB_*`) respecting member opt-out flags and bounded retry limits (`MAX_REMINDER_RETRIES = 3`).

## Project Structure

- `src/lib/domain/`: Pure, unit-tested business logic (`dates.ts`, `payments.ts`, `metrics.ts`, `reminders.ts`, `subscription.ts`, `csv.ts`).
- `src/services/gymos-service.ts`: Transactional Firestore operations, idempotent billing, attendance, reminders, and tenant JSON backup/restore.
- `src/components/super-admin/`: Platform Overview, Gyms Management, Subscription Plans, Manual Subscription Payments, Platform Settings & Admin Registry, Audit Logs.
- `src/components/gym/`: Role-aware Gym Dashboard, Members (CSV import/export, discounts, payment status, cancellations), Attendance Check-In/Out, Membership Plans, Cash/UPI Payments & Receipts, Automated Reminders, Multi-Mode Reports, Staff Management, Gym Settings & JSON Backup/Restore.
- `server.ts`: Express server, SMTP & WhatsApp delivery endpoints, Super Admin bootstrap endpoint, and cron reminder worker.
- `scripts/init-super-admin.mjs`: CLI bootstrap script for initializing the first Platform Super Admin.
- `firestore.rules` & `firebase-blueprint.json`: Hardened Firestore security rules and schema definitions.
- `docs/`: Deployment, Super Admin setup, Backup & Restore, and Gym Onboarding guides.

## Quick Commands

```bash
bun install --frozen-lockfile
bun run dev           # Start Express + Vite dev server on port 3000
bun run lint          # TypeScript type-check (tsc --noEmit)
bun run lint:rules    # Validate firestore.rules via ESLint security-rules plugin
bun run test          # Run Vitest domain & structural security-rules tests
bun run test:emulator # Run live Firebase Firestore Emulator integration tests (requires Java)
bun run build         # Build client dist/ and server dist-server/server.mjs
bun run start         # Run production server (dist-server/server.mjs)
```

## Documentation

- [Deployment Guide](docs/DEPLOYMENT.md)
- [Super Admin Setup & Governance](docs/ADMIN_SETUP.md)
- [Backup & Restore Runbook](docs/BACKUP_RESTORE.md)
- [Gym Onboarding & Daily Operations](docs/GYM_ONBOARDING.md)
