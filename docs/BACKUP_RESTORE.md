# GymOS Backup & Restore Runbook

## 1. Firestore Backup & Restore (Google Cloud)

1. Export all collections to a Google Cloud Storage bucket:
   ```bash
   gcloud firestore exports gs://YOUR_BACKUP_BUCKET/gymos-$(date +%F) \
     --database="ai-studio-41ae310f-363a-4e9f-a08f-b95b76f8f4e9"
   ```
2. Restore from a snapshot:
   ```bash
   gcloud firestore import gs://YOUR_BACKUP_BUCKET/gymos-YYYY-MM-DD \
     --database="ai-studio-41ae310f-363a-4e9f-a08f-b95b76f8f4e9"
   ```
3. Also encourage gym owners to export periodic CSV snapshots from **Members** and **Reports** for offline bookkeeping.

## 2. PostgreSQL / Docker Backup & Restore

### Daily Automated Backup (`pg_dump`)
```bash
pg_dump "$DATABASE_URL" --format=custom --no-owner --file="gymos_backup_$(date +%F_%H%M).dump"
```
Inside Docker Compose:
```bash
docker compose exec -T gymos-postgres pg_dump -U gymos_app -d gymos -Fc > "gymos_backup_$(date +%F).dump"
```

### Point-in-Time / Full Restore (`pg_restore`)
1. Provision a clean database and verify extensions (`pgcrypto`).
2. Restore schema, RLS policies, and data:
   ```bash
   pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" gymos_backup_YYYY-MM-DD.dump
   ```
3. Verify RLS is enabled on every tenant table:
   ```sql
   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
   ```
   All 18 tables must report `rowsecurity = true`.
