# GymOS Super Admin Setup & Security Governance

GymOS separates the **Platform Super Admin Portal** (`/admin`) from the **Gym Owner & Staff Portal** (`/`) and enforces authorization inside `firestore.rules` using the `/platform_admins/{uid}` registry—never via hardcoded email addresses.

## 1. Controlled Super Admin Bootstrap (First Admin)

Regular users and gym owners cannot create `/platform_admins/{uid}` records or assign themselves `role: 'SUPER_ADMIN'` in `/users/{uid}`. Use either of the two controlled bootstrap paths on a fresh deployment:

### Option A: CLI Bootstrap (`scripts/init-super-admin.mjs`)
1. Ensure the target user has signed in at least once with Google / Email-verified Firebase Authentication so their user record exists in Firebase Auth.
2. Provide Firebase Admin credentials (`FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`) in your shell or `.env`.
3. Run:
   ```bash
   node scripts/init-super-admin.mjs admin@yourdomain.com "Platform Admin"
   ```
   This runs a Firestore transaction that sets `/platform_bootstrap/default` (`completed: true`), `/platform_admins/{uid}`, `/users/{uid}` (`role: 'SUPER_ADMIN'`), and an immutable `CLI_INIT_SUPER_ADMIN` audit log entry.

### Option B: Web Bootstrap Endpoint (`POST /api/admin/bootstrap`)
1. Set both a high-entropy one-time token in `SUPER_ADMIN_BOOTSTRAP_TOKEN` and the exact initial administrator email in `SUPER_ADMIN_BOOTSTRAP_EMAIL`, alongside `FIREBASE_SERVICE_ACCOUNT_JSON` (or `GOOGLE_APPLICATION_CREDENTIALS`).
2. Open `/admin`, sign in with the verified Google account matching `SUPER_ADMIN_BOOTSTRAP_EMAIL`, and enter the bootstrap token when prompted.
3. On success, the server atomically creates `/platform_bootstrap/default` (`completed: true`), `/platform_admins/{uid}`, `/users/{uid}`, and an audit log, **immediately invalidates the in-memory bootstrap token & email**, and rejects all subsequent or concurrent attempts (`HTTP 409`). Remove both `SUPER_ADMIN_BOOTSTRAP_*` variables from `.env` afterward.

## 2. Managing Additional Super Admins

Once logged into `/admin`, open **Platform Settings -> Platform Super Administrators Registry** to grant or revoke `SUPER_ADMIN` access for existing authenticated users by UID and verified email. An active Super Admin cannot delete their own `/platform_admins/{uid}` document, preventing accidental platform lockout.

## 3. Public Registration Controls & Admin-Provisioned Gyms

- `platform_settings/default.allowPublicRegistration` is enforced directly in `firestore.rules` (not only in frontend UI).
- When `allowPublicRegistration` is `false`, direct self-signup creation of `/gyms/{gymId}` and self-registered `/users/{uid}` is rejected by Firestore.
- Super Admins can always provision new gyms from **Gyms Management -> Create Gym**, which creates the gym with `ownerUid: "owner_pending_<invitationId>"` and issues a `GYM_OWNER` invitation. When the invited owner signs in with their matching verified email, they claim ownership atomically via `claimOwnerInvitation`.

## 4. Account Freeze, Grace Period & Manual Subscription Verification

- **Database-Level Lock**: `isGymActive(gymId)` in `firestore.rules` requires `accountStatus == 'ACTIVE'`, `subscriptionStatus in ['TRIAL', 'ACTIVE']`, and `subscriptionAccessUntil > request.time`.
- **Grace Period**: Subscription expiry access extends through `subscriptionEndAt + gracePeriodDays` (`subscriptionAccessUntil`). Super Admins can adjust `gracePeriodDays` per gym from **Gyms Management**.
- **Manual Cash & UPI Verification**:
  - Super Admins can record direct verified payments or verify/reject `PENDING` / `RECORDED` subscription payments from **Subscription Payments**.
  - `verifyExistingSubscriptionPayment` runs inside a Firestore transaction and requires `extensionApplied == false`, preventing duplicate period extensions.
