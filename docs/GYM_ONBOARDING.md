# GymOS Gym Onboarding & Operations Guide

## 1. Registering a New Gym

1. Sign in with a verified Google account on the GymOS Auth screen.
2. Complete the **Gym Onboarding Wizard**: enter Gym Name, Owner Name, Contact Phone, Address, and pick a GymOS SaaS plan (14-day Trial or Pending Manual Verification).
3. Your gym workspace initializes with isolated tenant collections, default reminder schedules (`7, 3, 1` days before expiry + expiry day + `3, 7` days after), and `EXTEND_FROM_EXPIRY` renewal policy.

## 2. Daily Gym Operations

- **Membership Plans**: Create Monthly, Quarterly, Half-Yearly, Yearly, or Custom-Day plans with benefits and pricing.
- **Members**: Register members individually or bulk import via CSV (with phone duplicate detection and row-level validation preview).
- **Manual Cash & UPI Payments**:
  - Receptionists record Cash/UPI payments (`PENDING` or `CONFIRMED` based on owner-granted permission).
  - Managers/Owners verify pending payments; confirming a payment atomically updates the member's outstanding balance and issues a unique receipt (`RCP-...`) ready for printing.
- **Staff & Invitations**: Invite Managers or Receptionists by email and configure granular permissions (`canViewReports`, `canManagePlans`, `canConfirmPayments`, `canDeleteMembers`, `canManageReminders`). Invited staff see a one-click invitation acceptance screen after signing in with their matching Google email.
