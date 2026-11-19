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
  const resolvedName =
    displayNameArg || userRecord.displayName || emailArg.split('@')[0] || 'Platform Admin';

  const batch = db.batch();
  batch.set(db.collection('platform_admins').doc(userRecord.uid), {
    uid: userRecord.uid,
    email: emailArg,
    displayName: resolvedName,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(
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
  batch.set(db.collection('audit_logs').doc(auditId), {
    id: auditId,
    actorUid: userRecord.uid,
    actorEmail: emailArg,
    actorRole: 'SUPER_ADMIN',
    action: 'CLI_INIT_SUPER_ADMIN',
    entityType: 'PlatformAdmin',
    entityId: userRecord.uid,
    summary: `Initialized platform Super Admin (${emailArg}) via CLI`,
    createdAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();
  console.log(`Initialized Super Admin: ${emailArg} (uid=${userRecord.uid})`);
}

main().catch((err) => {
  console.error('Failed to initialize Super Admin:', err);
  process.exit(1);
});
