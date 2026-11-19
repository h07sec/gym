# GymOS Backup & Restore Runbook

GymOS supports both **platform-wide Cloud Firestore backups** (for platform operators) and **per-tenant JSON Backup & Restore** (built directly into each gym's Settings screen).

## 1. Platform-Wide Firestore Backup & Restore (Google Cloud)

1. Export all collections in the configured Firestore database (`ai-studio-41ae310f-363a-4e9f-a08f-b95b76f8f4e9`) to a Google Cloud Storage bucket:
   ```bash
   gcloud firestore exports gs://YOUR_BACKUP_BUCKET/gymos-$(date +%F) \
     --database="ai-studio-41ae310f-363a-4e9f-a08f-b95b76f8f4e9"
   ```
2. Restore from a snapshot:
   ```bash
   gcloud firestore import gs://YOUR_BACKUP_BUCKET/gymos-YYYY-MM-DD \
     --database="ai-studio-41ae310f-363a-4e9f-a08f-b95b76f8f4e9"
   ```
3. After any rules or deployment restore, verify `firestore.rules` is active:
   ```bash
   bun run lint:rules
   firebase deploy --only firestore:rules
   ```

## 2. Per-Tenant JSON Backup & Restore (Gym Owner UI)

Each Gym Owner can export and restore their own isolated gym data from **Settings -> Tenant Data Backup & Restore**:

- **Download Full Backup (JSON)**: Exports `settings`, `membershipPlans`, `members`, `memberships`, `memberPayments`, `paymentReceipts`, `attendance`, and `notificationLogs` into a single JSON file stamped with `gymId` and `exportedAt`.
- **Restore from JSON**:
  - Validates `gymId` in the backup file against the active gym so cross-tenant imports are strictly rejected.
  - Merges records safely into the active tenant's subcollections in chunked Firestore batches (`merge: true`) and logs a `RESTORE_GYM_BACKUP` entry in `/audit_logs`.
- **CSV Snapshots**: Gym owners and authorized staff can also export member lists from **Members** and financial/operational summaries from **Reports** (`Daily`, `Weekly`, `Monthly`, `Custom Range`, `Outstanding Balances`, `Expiring Memberships`).
