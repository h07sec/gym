#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

function computeEffectiveAccessEndIso(endAtIso, gracePeriodDays) {
  const safeEnd = String(endAtIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeEnd)) return '';
  const [y, m, d] = safeEnd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Math.max(0, Number(gracePeriodDays) || 0));
  return dt.toISOString().slice(0, 10);
}

function buildSubscriptionAccessTimestamp(endAtIso, graceDays, status) {
  if (status === 'PENDING' || status === 'CANCELLED') {
    return Timestamp.fromDate(new Date('1970-01-01T00:00:00.000Z'));
  }
  const effectiveIso = computeEffectiveAccessEndIso(endAtIso, graceDays);
  if (!effectiveIso) {
    return Timestamp.fromDate(new Date('1970-01-01T00:00:00.000Z'));
  }
  if (status === 'EXPIRED') {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const chosen = effectiveIso < yesterday ? effectiveIso : yesterday;
    return Timestamp.fromDate(new Date(`${chosen}T23:59:59.999Z`));
  }
  return Timestamp.fromDate(new Date(`${effectiveIso}T23:59:59.999Z`));
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  const grantExistingDeskMembers = args.has('--grant-existing-desk-members');

  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (!fs.existsSync(configPath)) {
    console.error(`Missing ${configPath}`);
    process.exit(1);
  }
  const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const rawSa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  let app;
  if (rawSa) {
    app = initializeApp({
      credential: cert(JSON.parse(rawSa)),
      projectId: firebaseConfig.projectId,
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    app = initializeApp({
      credential: applicationDefault(),
      projectId: firebaseConfig.projectId,
    });
  } else {
    console.error(
      'Missing credentials: set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.'
    );
    process.exit(1);
  }

  const db =
    firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== '(default)'
      ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
      : getFirestore(app);

  let gymsUpdated = 0;
  let staffUpdated = 0;
  let invitesUpdated = 0;

  const gymsSnap = await db.collection('gyms').get();
  for (const gymDoc of gymsSnap.docs) {
    const gym = gymDoc.data();
    const hasValidAccessTs =
      gym.subscriptionAccessUntil && typeof gym.subscriptionAccessUntil.toDate === 'function';

    if (!hasValidAccessTs) {
      const ts = buildSubscriptionAccessTimestamp(
        gym.subscriptionEndAt,
        gym.gracePeriodDays ?? 7,
        gym.subscriptionStatus
      );
      gymsUpdated += 1;
      console.log(
        `[gym:${gymDoc.id}] ${apply ? 'Updating' : 'Would update'} subscriptionAccessUntil -> ${ts.toDate().toISOString()}`
      );
      if (apply) {
        await gymDoc.ref.update({
          subscriptionAccessUntil: ts,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    const staffSnap = await gymDoc.ref.collection('staff').get();
    for (const staffDoc of staffSnap.docs) {
      const s = staffDoc.data();
      const perms = s.permissions || {};
      const missingView = typeof perms.canViewMembers !== 'boolean';
      const missingManage = typeof perms.canManageMembers !== 'boolean';
      if (missingView || missingManage) {
        const defaultForRole =
          s.role === 'GYM_OWNER' ||
          (grantExistingDeskMembers &&
            (s.role === 'GYM_MANAGER' || s.role === 'GYM_RECEPTIONIST'));
        const nextPerms = {
          ...perms,
          canViewMembers: missingView ? defaultForRole : perms.canViewMembers,
          canManageMembers: missingManage ? defaultForRole : perms.canManageMembers,
        };
        staffUpdated += 1;
        console.log(
          `[staff:${gymDoc.id}/${staffDoc.id} (${s.role})] ${apply ? 'Updating' : 'Would update'} canViewMembers=${nextPerms.canViewMembers}, canManageMembers=${nextPerms.canManageMembers}`
        );
        if (apply) {
          await staffDoc.ref.update({
            permissions: nextPerms,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }
    }
  }

  const invitesSnap = await db
    .collection('invitations')
    .where('status', '==', 'PENDING')
    .get();
  for (const invDoc of invitesSnap.docs) {
    const inv = invDoc.data();
    const hasExpiresAt = inv.expiresAt && typeof inv.expiresAt.toDate === 'function';
    const perms = inv.permissions || {};
    const missingView = typeof perms.canViewMembers !== 'boolean';
    const missingManage = typeof perms.canManageMembers !== 'boolean';

    if (!hasExpiresAt || missingView || missingManage) {
      const updates = { updatedAt: FieldValue.serverTimestamp() };
      if (!hasExpiresAt) {
        updates.expiresAt = Timestamp.fromDate(new Date(Date.now() + 7 * 86400_000));
      }
      if (missingView || missingManage) {
        const defaultForRole = inv.role === 'GYM_OWNER';
        updates.permissions = {
          ...perms,
          canViewMembers: missingView ? defaultForRole : perms.canViewMembers,
          canManageMembers: missingManage ? defaultForRole : perms.canManageMembers,
        };
      }
      invitesUpdated += 1;
      console.log(
        `[invitation:${invDoc.id}] ${apply ? 'Updating' : 'Would update'} (${Object.keys(updates).join(', ')})`
      );
      if (apply) {
        await invDoc.ref.update(updates);
      }
    }
  }

  console.log(
    `Done (${apply ? 'APPLIED' : 'DRY-RUN'}). Summary: gyms=${gymsUpdated}, staff=${staffUpdated}, pendingInvitations=${invitesUpdated}.`
  );
  if (!apply) {
    console.log('Re-run with --apply to write changes (pass --grant-existing-desk-members to enable member access for existing GYM_MANAGER/GYM_RECEPTIONIST records missing the new keys).');
  }
}

main().catch((err) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
