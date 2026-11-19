# GymOS Security Specification (Payload-First Security TDD)

## 1. Core Data Invariants
1. **Strict Tenant Isolation**: Every gym-owned record (`/gyms/{gymId}/members/*`, `/gyms/{gymId}/memberships/*`, `/gyms/{gymId}/member_payments/*`, `/gyms/{gymId}/payment_receipts/*`, `/gyms/{gymId}/staff/*`, `/gyms/{gymId}/membership_plans/*`, `/gyms/{gymId}/notification_logs/*`, `/gyms/{gymId}/notifications/*`, `/gyms/{gymId}/settings/*`) belongs strictly to `gymId`. Users belonging to Gym A can never read, list, create, update, or delete records in Gym B.
2. **Account Suspension Enforcement**: If `gyms/{gymId}.accountStatus == 'SUSPENDED'`, all operational reads and writes under `/gyms/{gymId}/*` (members, memberships, payments, receipts, plans, staff, logs) are denied at the database rule layer for non-Super-Admin users.
3. **Privilege Escalation Prevention**: Only `SUPER_ADMIN` (verified via `/platform_admins/{uid}` or verified bootstrap email) can create/modify `platform_admins`, `subscription_plans`, `subscription_payments`, or update `gyms/{gymId}.accountStatus` / `subscriptionStatus` / `subscriptionEndAt`. A `GYM_OWNER` or staff user can never promote themselves to `SUPER_ADMIN` or change their `gymId`.
4. **Manual Payment & Receipt Integrity**: Member payments start as `PENDING` or `CONFIRMED` (cash only by authorized staff). Once a payment reaches terminal status (`CONFIRMED`, `REJECTED`, `REFUNDED`), it cannot transition back to `PENDING` or be modified to alter `amount`.
5. **Immutable Audit Trail**: `audit_logs` records can only be created with matching `actorUid == request.auth.uid` and server timestamp `request.time`, and can never be updated or deleted by any client.
6. **PII Protection**: User profiles (`/users/{uid}`), gym members, and staff invitations restrict `get` and `list` access strictly to the owner, authorized gym staff of the same active gym, or Super Admin. No blanket `isSignedIn()` reads exist.
7. **Temporal & Payload Bounds**: All strings have explicit `.size()` bounds; all IDs match `^[a-zA-Z0-9_\-]+$`; `createdAt` / `updatedAt` use server timestamp `request.time`; `hasAll` and `hasOnly` enforce exact field allowlists on create and `affectedKeys().hasOnly(...)` on update.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Cross-Tenant Member Read**: Authenticated `GYM_OWNER` of `gym_alpha` sends `getDoc(/gyms/gym_beta/members/mem_1)` -> **MUST return PERMISSION_DENIED**.
2. **Cross-Tenant Member Write**: Authenticated `GYM_OWNER` of `gym_alpha` sends `setDoc(/gyms/gym_beta/members/mem_99, { gymId: 'gym_beta', ... })` -> **MUST return PERMISSION_DENIED**.
3. **Self-Promotion to Super Admin**: Authenticated `GYM_OWNER` attempts `updateDoc(/users/{uid}, { role: 'SUPER_ADMIN' })` -> **MUST return PERMISSION_DENIED**.
4. **Tenant Hopping (Changing Own `gymId`)**: Authenticated `GYM_MANAGER` attempts `updateDoc(/users/{uid}, { gymId: 'gym_beta' })` -> **MUST return PERMISSION_DENIED**.
5. **Bypassing Account Freeze**: `GYM_OWNER` of a `SUSPENDED` gym attempts `setDoc(/gyms/{gymId}/members/mem_new, ...)` or `getDocs(/gyms/{gymId}/members)` -> **MUST return PERMISSION_DENIED**.
6. **Self-Reactivating Suspended Gym**: `GYM_OWNER` attempts `updateDoc(/gyms/{gymId}, { accountStatus: 'ACTIVE', subscriptionStatus: 'ACTIVE' })` -> **MUST return PERMISSION_DENIED**.
7. **Self-Confirming SaaS Subscription Payment**: `GYM_OWNER` attempts `setDoc(/subscription_payments/sp_fake, { gymId, status: 'VERIFIED', amount: 1999 })` -> **MUST return PERMISSION_DENIED**.
8. **Shadow Field Injection (Ghost Field)**: Staff user includes `{ isVerified: true, adminOverride: true }` in a `member` create/update payload -> **MUST return PERMISSION_DENIED** via `hasOnly`.
9. **Resource Exhaustion (1MB String ID Poisoning)**: User submits a 10,000-character document ID or unvalidated 500KB note string -> **MUST return PERMISSION_DENIED** via `isValidId` and `.size()` limits.
10. **Terminal State Mutation (Double-Confirmation / Amount Tampering)**: Staff attempts to update an already `CONFIRMED` member payment `{ amount: 999999, status: 'PENDING' }` -> **MUST return PERMISSION_DENIED**.
11. **Audit Log Tampering**: `GYM_OWNER` attempts `deleteDoc(/audit_logs/log_1)` or `updateDoc(/audit_logs/log_1, { action: 'NONE' })` -> **MUST return PERMISSION_DENIED**.
12. **Blanket User Listing / PII Scraping**: Non-admin user executes `getDocs(/users)` or `getDocs(/invitations)` without ownership/tenant constraints -> **MUST return PERMISSION_DENIED**.
