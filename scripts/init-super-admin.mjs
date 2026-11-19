#!/usr/bin/env node
import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

async function main() {
  const emailArg = process.argv[2]?.trim().toLowerCase();
  const displayNameArg = process.argv[3]?.trim();

  if (!emailArg || !emailArg.includes('@')) {
    console.error('Usage: node scripts/init-super-admin.mjs <user-email> [display-name]');
    process.exit(1);
  }

  const allowlistedEmail = process.env.SUPER_ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  if (allowlistedEmail && allowlistedEmail !== emailArg) {
    console.error(
      `Email "${emailArg}" does not match configured SUPER_ADMIN_BOOTSTRAP_EMAIL ("${allowlistedEmail}").`
    );
    process.exit(1);
  }

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
      'Missing credentials: set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS in your environment.'
    );
    process.exit(1);
  }

  const auth = getAuth(app);
  const db =
    firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== '(default)'
      ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
      : getFirestore(app);

  const userRecord = await auth.getUserByEmail(emailArg);
  if (!userRecord.emailVerified) {
    console.error(`User "${emailArg}" must have a verified email before Super Admin initialization.`);
    process.exit(1);
  }

  const resolvedName =
    displayNameArg || userRecord.displayName || emailArg.split('@')[0] || 'Platform Admin';

  await db.runTransaction(async (tx) => {
    const lockRef = db.collection('platform_bootstrap').doc('default');
    const adminsQuery = db.collection('platform_admins').limit(1);
    const [lockSnap, adminsSnap] = await Promise.all([
      tx.get(lockRef),
      tx.get(adminsQuery),
    ]);

    if (
      (lockSnap.exists && lockSnap.data()?.completed === true) ||
      !adminsSnap.empty
    ) {
      throw new Error(
        'Platform Super Admin bootstrap is already completed. Add additional admins from /admin -> Platform Settings.'
      );
    }

    tx.set(lockRef, {
      id: 'default',
      completed: true,
      adminUid: userRecord.uid,
      adminEmail: emailArg,
      method: 'CLI_BOOTSTRAP',
      completedAt: FieldValue.serverTimestamp(),
    });

    tx.set(db.collection('platform_admins').doc(userRecord.uid), {
      uid: userRecord.uid,
      email: emailArg,
      displayName: resolvedName,
      createdAt: FieldValue.serverTimestamp(),
    });

    tx.set(
      db.collection('users').doc(userRecord.uid),
      {
        uid: userRecord.uid,
        email: emailArg,
        displayName: resolvedName,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const auditId = `aud_${crypto.randomBytes(8).toString('hex')}`;
    tx.set(db.collection('audit_logs').doc(auditId), {
      id: auditId,
      actorUid: userRecord.uid,
      actorEmail: emailArg,
      actorRole: 'SUPER_ADMIN',
      action: 'CLI_INIT_SUPER_ADMIN',
      entityType: 'PlatformBootstrap',
      entityId: 'default',
      summary: `Initialized initial platform Super Admin (${emailArg}) via atomic CLI bootstrap`,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  console.log(`Initialized Super Admin: ${emailArg} (uid=${userRecord.uid}). One-time bootstrap is now locked.`);
}

main().catch((err) => {
  console.error('Failed to initialize Super Admin:', err instanceof Error ? err.message : err);
  process.exit(1);
});
