import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
  type App as AdminApp,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAuth, type Auth as AdminAuth } from 'firebase-admin/auth';
import {
  FieldValue,
  getFirestore,
  type Firestore as AdminFirestore,
} from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface FirebaseClientConfig {
  projectId: string;
  firestoreDatabaseId?: string;
}

interface ServerEnvConfig {
  port: number;
  appUrl: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  emailConfigured: boolean;
  whatsappAccessToken: string;
  whatsappApiVersion: string;
  whatsappConfigured: boolean;
  bootstrapToken: string;
  cronSecret: string;
  reminderWorkerIntervalMinutes: number;
  serviceAccount: ServiceAccount | null;
  hasGoogleAdc: boolean;
}

function resolveProjectFile(relativePath: string): string {
  const candidates = [
    path.resolve(process.cwd(), relativePath),
    path.resolve(__dirname, relativePath),
    path.resolve(__dirname, '..', relativePath),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

function loadFirebaseConfig(): FirebaseClientConfig {
  const cfgPath = resolveProjectFile('firebase-applet-config.json');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Missing firebase-applet-config.json at ${cfgPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as FirebaseClientConfig;
  if (!parsed.projectId) {
    throw new Error('Invalid firebase-applet-config.json: missing projectId.');
  }
  return parsed;
}

function validateEnv(): ServerEnvConfig {
  const rawPort = process.env.PORT?.trim() || '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${rawPort}". Must be an integer between 1 and 65535.`);
  }

  const smtpHost = process.env.SMTP_HOST?.trim() || '';
  const rawSmtpPort = process.env.SMTP_PORT?.trim() || '587';
  const smtpPort = Number(rawSmtpPort);
  if (smtpHost && (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
    throw new Error(`Invalid SMTP_PORT "${rawSmtpPort}". Must be a valid TCP port.`);
  }

  const smtpSecure = process.env.SMTP_SECURE?.trim().toLowerCase() === 'true';
  const smtpUser = process.env.SMTP_USER?.trim() || '';
  const smtpPass = process.env.SMTP_PASS?.trim() || '';
  const smtpFrom = process.env.SMTP_FROM?.trim() || (smtpUser ? `GymOS <${smtpUser}>` : '');
  const emailConfigured = Boolean(smtpHost && smtpUser && smtpPass);

  const whatsappAccessToken = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN?.trim() || '';
  const whatsappApiVersion = process.env.WHATSAPP_API_VERSION?.trim() || 'v20.0';
  const whatsappConfigured = Boolean(whatsappAccessToken);

  const rawInterval = process.env.REMINDER_WORKER_INTERVAL_MINUTES?.trim() || '30';
  const reminderWorkerIntervalMinutes = Number(rawInterval);
  if (!Number.isFinite(reminderWorkerIntervalMinutes) || reminderWorkerIntervalMinutes < 0) {
    throw new Error(
      `Invalid REMINDER_WORKER_INTERVAL_MINUTES "${rawInterval}". Must be a non-negative number.`
    );
  }

  let serviceAccount: ServiceAccount | null = null;
  const rawSa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawSa) {
    try {
      const parsed = JSON.parse(rawSa) as ServiceAccount & {
        project_id?: string;
        private_key?: string;
        client_email?: string;
      };
      if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
        throw new Error('Missing project_id, private_key, or client_email.');
      }
      serviceAccount = parsed;
    } catch (err) {
      throw new Error(
        `Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const hasGoogleAdc = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim());

  return {
    port,
    appUrl: process.env.APP_URL?.trim() || `http://localhost:${port}`,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPass,
    smtpFrom,
    emailConfigured,
    whatsappAccessToken,
    whatsappApiVersion,
    whatsappConfigured,
    bootstrapToken: process.env.SUPER_ADMIN_BOOTSTRAP_TOKEN?.trim() || '',
    cronSecret: process.env.CRON_SECRET?.trim() || '',
    reminderWorkerIntervalMinutes,
    serviceAccount,
    hasGoogleAdc,
  };
}

function timingSafeMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

const env = validateEnv();
const firebaseConfig = loadFirebaseConfig();

let adminApp: AdminApp;
let adminDb: AdminFirestore | null = null;

if (env.serviceAccount) {
  adminApp = getApps().length
    ? getApp()
    : initializeApp({
        credential: cert(env.serviceAccount),
        projectId: firebaseConfig.projectId,
      });
  adminDb =
    firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== '(default)'
      ? getFirestore(adminApp, firebaseConfig.firestoreDatabaseId)
      : getFirestore(adminApp);
} else if (env.hasGoogleAdc) {
  adminApp = getApps().length
    ? getApp()
    : initializeApp({
        credential: applicationDefault(),
        projectId: firebaseConfig.projectId,
      });
  adminDb =
    firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== '(default)'
      ? getFirestore(adminApp, firebaseConfig.firestoreDatabaseId)
      : getFirestore(adminApp);
} else {
  adminApp = getApps().length
    ? getApp()
    : initializeApp({ projectId: firebaseConfig.projectId });
}

const adminAuth: AdminAuth = getAuth(adminApp);

const smtpTransporter = env.emailConfigured
  ? nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: {
        user: env.smtpUser,
        pass: env.smtpPass,
      },
    })
  : null;

async function sendEmailReal(input: {
  to: string;
  subject: string;
  text: string;
  fromName?: string;
}): Promise<{ delivered: boolean; providerMessageId?: string; sentAt?: string; errorDetails?: string }> {
  if (!smtpTransporter || !env.smtpFrom) {
    return {
      delivered: false,
      errorDetails:
        'SMTP is not configured on the server (set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM).',
    };
  }
  const email = input.to.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      delivered: false,
      errorDetails: `Invalid recipient email address: ${email || 'empty'}`,
    };
  }

  try {
    const cleanFrom = env.smtpFrom.includes('<')
      ? `${(input.fromName || 'GymOS').replace(/["<>]/g, '')} <${env.smtpFrom.split('<')[1].replace('>', '').trim()}>`
      : env.smtpFrom;
    const info = await smtpTransporter.sendMail({
      from: cleanFrom,
      to: email,
      subject: input.subject.slice(0, 180),
      text: input.text,
    });
    return {
      delivered: true,
      providerMessageId: info.messageId || `smtp_${Date.now()}`,
      sentAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      delivered: false,
      errorDetails: err instanceof Error ? err.message : 'SMTP delivery failed',
    };
  }
}

async function sendWhatsAppReal(input: {
  phone: string;
  phoneNumberId?: string;
  templateName?: string;
  templateParams?: string[];
  messageText: string;
}): Promise<{ delivered: boolean; providerMessageId?: string; sentAt?: string; errorDetails?: string }> {
  if (!env.whatsappConfigured) {
    return {
      delivered: false,
      errorDetails: 'WHATSAPP_CLOUD_ACCESS_TOKEN is not configured on the server.',
    };
  }
  const phoneNumberId = input.phoneNumberId?.trim();
  if (!phoneNumberId) {
    return {
      delivered: false,
      errorDetails: 'Gym WhatsApp Phone Number ID is missing.',
    };
  }
  const digits = input.phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return {
      delivered: false,
      errorDetails: `Invalid WhatsApp phone number (expected E.164 digits): ${input.phone}`,
    };
  }

  const endpoint = `https://graph.facebook.com/${encodeURIComponent(env.whatsappApiVersion)}/${encodeURIComponent(phoneNumberId)}/messages`;
  const bodyPayload = input.templateName?.trim()
    ? {
        messaging_product: 'whatsapp',
        to: digits,
        type: 'template',
        template: {
          name: input.templateName.trim(),
          language: { code: 'en' },
          ...(input.templateParams && input.templateParams.length > 0
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: input.templateParams.map((text) => ({
                      type: 'text',
                      text: String(text).slice(0, 200),
                    })),
                  },
                ],
              }
            : {}),
        },
      }
    : {
        messaging_product: 'whatsapp',
        to: digits,
        type: 'text',
        text: { body: input.messageText.slice(0, 1000) },
      };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.whatsappAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyPayload),
    });
    const json = (await resp.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { message?: string };
    };
    if (!resp.ok) {
      return {
        delivered: false,
        errorDetails: json?.error?.message || `WhatsApp Graph API HTTP ${resp.status}`,
      };
    }
    return {
      delivered: true,
      providerMessageId: json?.messages?.[0]?.id || `wa_${Date.now()}`,
      sentAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      delivered: false,
      errorDetails: err instanceof Error ? err.message : 'WhatsApp Cloud API request failed',
    };
  }
}

async function runPlatformReminderSweep(): Promise<{
  skipped?: boolean;
  reason?: string;
  gymsProcessed: number;
  retriesAttempted: number;
  delivered: number;
  failed: number;
}> {
  if (!adminDb) {
    return {
      skipped: true,
      reason:
        'Firebase Admin Firestore credentials (FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS) are not configured; scheduled server sweeps require Admin SDK credentials.',
      gymsProcessed: 0,
      retriesAttempted: 0,
      delivered: 0,
      failed: 0,
    };
  }

  let gymsProcessed = 0;
  let retriesAttempted = 0;
  let delivered = 0;
  let failed = 0;

  const gymsSnap = await adminDb
    .collection('gyms')
    .where('accountStatus', '==', 'ACTIVE')
    .get();

  for (const gymDoc of gymsSnap.docs) {
    const gym = gymDoc.data() as Record<string, unknown>;
    const subStatus = String(gym.subscriptionStatus || '');
    if (subStatus !== 'TRIAL' && subStatus !== 'ACTIVE') continue;

    gymsProcessed += 1;
    const settingsSnap = await gymDoc.ref.collection('settings').doc('default').get();
    const settings = settingsSnap.exists ? (settingsSnap.data() as Record<string, unknown>) : {};

    // Retry RETRY_SCHEDULED logs with retryCount < 3
    const retryLogsSnap = await gymDoc.ref
      .collection('notification_logs')
      .where('deliveryStatus', '==', 'RETRY_SCHEDULED')
      .limit(50)
      .get();

    for (const logDoc of retryLogsSnap.docs) {
      const log = logDoc.data() as {
        channel: string;
        recipient: string;
        memberName: string;
        template: string;
        retryCount: number;
      };
      if ((log.retryCount || 0) >= 3) continue;
      retriesAttempted += 1;

      const subject = `${String(gym.name || 'GymOS')} Reminder (${log.template.replace(/_/g, ' ')})`;
      const message = `Hi ${log.memberName}, this is a reminder from ${String(gym.name || 'your gym')} (${log.template.replace(/_/g, ' ')}).`;

      let outcome: {
        delivered: boolean;
        providerMessageId?: string;
        sentAt?: string;
        errorDetails?: string;
      } = { delivered: false, errorDetails: 'Unsupported channel for retry' };

      if (log.channel === 'EMAIL') {
        outcome = await sendEmailReal({
          to: log.recipient,
          subject,
          text: message,
          fromName: String(settings.emailFromName || gym.name || 'GymOS'),
        });
      } else if (log.channel === 'WHATSAPP_CLOUD') {
        outcome = await sendWhatsAppReal({
          phone: log.recipient,
          phoneNumberId: String(settings.whatsappPhoneNumberId || ''),
          templateName: String(settings.whatsappApprovedTemplate || ''),
          templateParams: [log.memberName, log.template.replace(/_/g, ' ')],
          messageText: message,
        });
      }

      const nextRetryCount = (log.retryCount || 0) + 1;
      const nowIso = new Date().toISOString();
      if (outcome.delivered) {
        delivered += 1;
        await logDoc.ref.update({
          deliveryStatus: 'SENT',
          retryCount: nextRetryCount,
          errorDetails: '',
          providerMessageId: outcome.providerMessageId || '',
          sentAt: outcome.sentAt || nowIso,
          lastAttemptAt: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        failed += 1;
        await logDoc.ref.update({
          deliveryStatus: nextRetryCount >= 3 ? 'FAILED' : 'RETRY_SCHEDULED',
          retryCount: nextRetryCount,
          errorDetails: (outcome.errorDetails || 'Delivery failed').slice(0, 400),
          lastAttemptAt: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
  }

  return { gymsProcessed, retriesAttempted, delivered, failed };
}

async function verifyBearerUser(req: express.Request) {
  const authHeader = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    throw new Error('Missing Authorization Bearer token.');
  }
  const decoded = await adminAuth.verifyIdToken(match[1].trim());
  if (!decoded.email || decoded.email_verified !== true) {
    throw new Error('Verified email authentication is required.');
  }
  return decoded;
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '512kb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      capabilities: {
        emailConfigured: env.emailConfigured,
        whatsappConfigured: env.whatsappConfigured,
        adminFirestoreConfigured: Boolean(adminDb),
        adminBootstrapConfigured: Boolean(env.bootstrapToken),
        cronConfigured: Boolean(env.cronSecret),
      },
    });
  });

  app.get('/api/notifications/capabilities', (_req, res) => {
    res.status(200).json({
      emailConfigured: env.emailConfigured,
      whatsappConfigured: env.whatsappConfigured,
      adminFirestoreConfigured: Boolean(adminDb),
      adminBootstrapConfigured: Boolean(env.bootstrapToken),
      cronConfigured: Boolean(env.cronSecret),
      smtpFrom: env.emailConfigured ? env.smtpFrom : '',
    });
  });

  app.post('/api/notifications/send', async (req, res) => {
    try {
      await verifyBearerUser(req);
    } catch (err) {
      res.status(401).json({
        delivered: false,
        errorDetails: err instanceof Error ? err.message : 'Unauthorized',
      });
      return;
    }

    const {
      channel,
      recipient,
      subject,
      message,
      fromName,
      whatsappPhoneNumberId,
      whatsappApprovedTemplate,
      whatsappTemplateParams,
    } = (req.body || {}) as {
      channel?: string;
      recipient?: string;
      subject?: string;
      message?: string;
      fromName?: string;
      whatsappPhoneNumberId?: string;
      whatsappApprovedTemplate?: string;
      whatsappTemplateParams?: string[];
    };

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ delivered: false, errorDetails: 'Message body is required.' });
      return;
    }

    if (channel === 'EMAIL') {
      const outcome = await sendEmailReal({
        to: String(recipient || ''),
        subject: String(subject || 'GymOS Reminder'),
        text: message,
        fromName,
      });
      res.status(200).json(outcome);
      return;
    }

    if (channel === 'WHATSAPP_CLOUD') {
      const outcome = await sendWhatsAppReal({
        phone: String(recipient || ''),
        phoneNumberId: whatsappPhoneNumberId,
        templateName: whatsappApprovedTemplate,
        templateParams: whatsappTemplateParams,
        messageText: message,
      });
      res.status(200).json(outcome);
      return;
    }

    res.status(400).json({
      delivered: false,
      errorDetails: `Unsupported delivery channel "${String(channel || '')}".`,
    });
  });

  app.post('/api/admin/bootstrap', async (req, res) => {
    let decoded;
    try {
      decoded = await verifyBearerUser(req);
    } catch (err) {
      res.status(401).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unauthorized',
      });
      return;
    }

    if (!env.bootstrapToken) {
      res.status(403).json({
        ok: false,
        error:
          'Super Admin web bootstrap is not enabled (SUPER_ADMIN_BOOTSTRAP_TOKEN is not set). Use scripts/init-super-admin.mjs or register an admin from an existing Super Admin account.',
      });
      return;
    }

    const { bootstrapToken, displayName } = (req.body || {}) as {
      bootstrapToken?: string;
      displayName?: string;
    };

    if (!bootstrapToken || !timingSafeMatch(String(bootstrapToken), env.bootstrapToken)) {
      res.status(403).json({ ok: false, error: 'Invalid Super Admin bootstrap token.' });
      return;
    }

    if (!adminDb) {
      res.status(501).json({
        ok: false,
        error:
          'Server-side Firestore credentials (FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS) are not configured in this environment. Run `node scripts/init-super-admin.mjs <email>` with credentials to initialize the first Super Admin.',
      });
      return;
    }

    try {
      const existingAdmins = await adminDb.collection('platform_admins').limit(2).get();
      const callerAdminRef = adminDb.collection('platform_admins').doc(decoded.uid);
      const callerIsAlreadyAdmin = (await callerAdminRef.get()).exists;

      if (!existingAdmins.empty && !callerIsAlreadyAdmin) {
        res.status(409).json({
          ok: false,
          error:
            'Platform Super Admin is already initialized. An existing Super Admin must authorize additional administrators.',
        });
        return;
      }

      const resolvedName = (
        displayName ||
        decoded.name ||
        decoded.email?.split('@')[0] ||
        'Platform Admin'
      )
        .trim()
        .slice(0, 120);
      const resolvedEmail = (decoded.email || '').toLowerCase();

      const batch = adminDb.batch();
      batch.set(callerAdminRef, {
        uid: decoded.uid,
        email: resolvedEmail,
        displayName: resolvedName,
        createdAt: FieldValue.serverTimestamp(),
      });
      batch.set(
        adminDb.collection('users').doc(decoded.uid),
        {
          uid: decoded.uid,
          email: resolvedEmail,
          displayName: resolvedName,
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      const auditId = `aud_${crypto.randomBytes(8).toString('hex')}`;
      batch.set(adminDb.collection('audit_logs').doc(auditId), {
        id: auditId,
        actorUid: decoded.uid,
        actorEmail: resolvedEmail,
        actorRole: 'SUPER_ADMIN',
        action: 'BOOTSTRAP_SUPER_ADMIN',
        entityType: 'PlatformAdmin',
        entityId: decoded.uid,
        summary: `Initialized platform Super Admin (${resolvedEmail}) via controlled bootstrap`,
        createdAt: FieldValue.serverTimestamp(),
      });

      await batch.commit();
      res.status(200).json({ ok: true, uid: decoded.uid, email: resolvedEmail });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to initialize Super Admin.',
      });
    }
  });

  app.post('/api/cron/reminders', async (req, res) => {
    if (!env.cronSecret) {
      res.status(403).json({ ok: false, error: 'CRON_SECRET is not configured on the server.' });
      return;
    }
    const authHeader = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match || !timingSafeMatch(match[1].trim(), env.cronSecret)) {
      res.status(401).json({ ok: false, error: 'Invalid cron authorization token.' });
      return;
    }
    try {
      const result = await runPlatformReminderSweep();
      res.status(200).json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Cron sweep failed',
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distCandidates = [
      path.resolve(__dirname, 'dist'),
      path.resolve(__dirname, '..', 'dist'),
      path.resolve(process.cwd(), 'dist'),
    ];
    const distDir =
      distCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ||
      path.resolve(process.cwd(), 'dist');
    const indexFile = path.join(distDir, 'index.html');

    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), {
        maxAge: '1y',
        immutable: true,
      })
    );
    app.use(
      express.static(distDir, {
        index: false,
        maxAge: '1h',
      })
    );
    app.get('*', (_req, res) => {
      if (!fs.existsSync(indexFile)) {
        res.status(503).send('Application bundle not built. Run npm run build first.');
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexFile);
    });
  }

  app.listen(env.port, '0.0.0.0', () => {
    console.log(
      `GymOS server listening on port ${env.port} (SMTP=${env.emailConfigured ? 'ready' : 'unconfigured'}, WhatsApp=${env.whatsappConfigured ? 'ready' : 'unconfigured'}, AdminFirestore=${adminDb ? 'ready' : 'disabled'})`
    );
  });

  if (adminDb && env.reminderWorkerIntervalMinutes > 0) {
    const intervalMs = Math.round(env.reminderWorkerIntervalMinutes * 60 * 1000);
    setInterval(() => {
      runPlatformReminderSweep().catch((err) => {
        console.error('[GymOS Reminder Worker] Sweep error:', err);
      });
    }, intervalMs);
  }
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
