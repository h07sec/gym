# GymOS Super Admin Setup & Security Governance

## 1. Bootstrapping the First Super Admin

GymOS prevents any regular user or gym owner from self-promoting to `SUPER_ADMIN`.
- In `firestore.rules`, `isBootstrapSuperAdmin()` verifies `request.auth.token.email_verified == true` and matches the designated platform owner email.
- On first authenticated Google sign-in, `AuthContext.tsx` registers `/platform_admins/{uid}` and `/users/{uid}` with `role: 'SUPER_ADMIN'` and seeds default SaaS subscription plans (`Monthly Standard`, `Quarterly Growth`, `Half-Yearly Scale`, `Yearly Studio`) and `platform_settings/default`.
- On PostgreSQL/Supabase, insert the initial Super Admin UUID into `platform_admins` and `users` via a privileged `psql` migration session before opening public signup.

## 2. Managing Gyms & Account Freeze Governance

- **Suspending a Gym**: From **Gyms Management**, click **Suspend** and provide a reason. Setting `accountStatus = 'SUSPENDED'` immediately enforces a database-level lock (`isGymActive(gymId)` in Firestore rules / `app_is_gym_active(gym_id)` in PostgreSQL RLS).
- **Data Preservation**: All members, memberships, payments, and receipts remain untouched in the database during suspension.
- **Reactivation**: Verify a manual subscription payment or click **Reactivate** in Gyms Management to restore immediate access.

## 3. Manual Cash & UPI Verification Rules

- Always record or verify the UTR / Transaction Reference for UPI settlements; GymOS rejects duplicate non-rejected UPI references.
- Subscription payments move from `RECORDED` -> `VERIFIED` once inside an atomic transaction (`verifyExistingSubscriptionPayment`) with `extensionApplied = true`, preventing double extension on retries or clicks.
