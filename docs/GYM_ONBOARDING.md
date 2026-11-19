# GymOS Gym Onboarding & Operations Guide

## 1. Onboarding a Gym

### Self-Registration (when Public Registration is enabled)
1. Open the GymOS login portal (`/`) and sign in with a verified Google account (or email/password).
2. Complete the **Gym Onboarding Wizard**: provide Gym Name, Owner Name, Contact Phone, Address, and choose a GymOS SaaS plan (14-day Trial or Pending Manual Verification).
3. Your gym workspace initializes with isolated tenant subcollections, default reminder schedules (`7, 3, 1` days before expiry + expiry day + `3, 7` days after), payment due reminders, and `EXTEND_FROM_EXPIRY` renewal policy.

### Admin-Provisioned Gym Invitation (when Public Registration is disabled)
1. The Platform Super Admin creates the gym in `/admin` and issues a `GYM_OWNER` invitation for your email.
2. Sign in at `/` with that exact verified Google/Firebase email and accept the invitation card to claim ownership of your gym.

## 2. Daily Gym Operations

- **Membership Plans**: Create Monthly, Quarterly, Half-Yearly, Yearly, or Custom-Day plans with benefits and pricing.
- **Members & Renewals**:
  - Register members individually or bulk import via CSV (with phone duplicate detection and row-level validation preview).
  - Apply optional fee discounts (with discount reason), partial payments, and balance due dates; view real-time payment display statuses (`Paid`, `Partially Paid`, `Pending Verification`, `Overdue`, `Unpaid`).
  - Cancel active memberships with a required reason (`CANCELLED`) or archive/permanently delete records per permissions.
- **Attendance Check-In & Check-Out**:
  - Track daily facility visits, check-out timestamps, active vs expired member badges on check-in, and search historical attendance logs.
- **Manual Cash & UPI Payments**:
  - Staff with `canRecordPayments` record Cash/UPI payments (`PENDING` by default, or immediately `CONFIRMED` if the staff member also holds `canConfirmPayments`).
  - GymOS detects duplicate UPI references and alerts on potential duplicate same-day Cash entries.
  - Confirming a payment atomically reduces outstanding balance and issues an immutable printable receipt (`RCP-...`); authorized owners/managers can also reject `PENDING` or refund `CONFIRMED` payments with an audit reason.
- **Staff & 8-Permission RBAC**:
  - Invite **Managers**, **Receptionists**, or **Trainers** (`GYM_TRAINER` with custom role titles) and configure 8 granular permissions: `canViewReports`, `canViewPayments`, `canRecordPayments`, `canManagePlans`, `canConfirmPayments`, `canDeleteMembers`, `canManageReminders`, and `canManageAttendance`.
- **Automated Reminders & Reports**:
  - Run daily reminder batches for expiring memberships, upcoming/overdue member balances, and owner GymOS subscription alerts via In-App, SMTP Email, and optional Meta WhatsApp Cloud API.
  - Export CSVs or print formatted **Daily**, **Weekly**, **Monthly**, **Custom Date Range**, **Outstanding Balances**, and **Expiring Memberships** reports.
