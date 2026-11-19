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
import {
  BootstrapController,
  timingSafeMatch,
} from './src/server/bootstrap-service';
import type { DbClient } from './src/server/firestore-types';
import { emitStructuredLog } from './src/server/logger';
import {
  authorizeAndResolveNotificationDispatch,
  HttpError,
} from './src/server/notification-guard';
import { SlidingWindowRateLimiter } from './src/server/rate-limiter';
import { ReminderWorker } from './src/server/reminder-worker';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface FirebaseClientConfig {
  projectId: string;
  firestoreDatabaseId?: string;
}

interface ServerEnvConfig {
  port: number;
  host: string;
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
  bootstrapEmail: string;
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
  const parsed = JSON.parse(
    fs.readFileSync(cfgPath, 'utf-8')
  ) as FirebaseClientConfig;
  if (!parsed.projectId) {
    throw new Error('Invalid firebase-applet-config.json: missing projectId.');
  }
  return parsed;
}

function parseCliServerArgs(argv: string[]): { port?: string; host?: string } {
  const result: { port?: string; host?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      result.port = argv[++i];
    } else if (arg.startsWith('--port=')) {
      result.port = arg.slice('--port='.length);
    } else if (arg === '--host' && argv[i + 1]) {
      result.host = argv[++i];
    } else if (arg.startsWith('--host=')) {
      result.host = arg.slice('--host='.length);
    }
  }
  return result;
}

function validateEnv(): ServerEnvConfig {
  const cliArgs = parseCliServerArgs(process.argv.slice(2));
  const envPort = process.env.PORT?.trim();
  const nginxPort = process.env.NGINX_PORT?.trim();
  const fallbackAppPort = process.env.DEFAULT_APP_PORT?.trim() || '3000';
  const rawPort =
    cliArgs.port?.trim() ||
    (envPort && (!nginxPort || envPort !== nginxPort)
      ? envPort
      : fallbackAppPort);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT "${rawPort}". Must be an integer between 1 and 65535.`
    );
  }
  const host = cliArgs.host?.trim() || process.env.HOST?.trim() || '0.0.0.0';

  const smtpHost = process.env.SMTP_HOST?.trim() || '';
  const rawSmtpPort = process.env.SMTP_PORT?.trim() || '587';
  const smtpPort = Number(rawSmtpPort);
  if (
    smtpHost &&
    (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)
  ) {
    throw new Error(
      `Invalid SMTP_PORT "${rawSmtpPort}". Must be a valid TCP port.`
    );
  }

  const smtpSecure = process.env.SMTP_SECURE?.trim().toLowerCase() === 'true';
  const smtpUser = process.env.SMTP_USER?.trim() || '';
  const smtpPass = process.env.SMTP_PASS?.trim() || '';
  const smtpFrom =
    process.env.SMTP_FROM?.trim() || (smtpUser ? `GymOS <${smtpUser}>` : '');
  const emailConfigured = Boolean(smtpHost && smtpUser && smtpPass);

  const whatsappAccessToken =
    process.env.WHATSAPP_CLOUD_ACCESS_TOKEN?.trim() || '';
  const whatsappApiVersion =
    process.env.WHATSAPP_API_VERSION?.trim() || 'v20.0';
  const whatsappConfigured = Boolean(whatsappAccessToken);

  const bootstrapToken = process.env.SUPER_ADMIN_BOOTSTRAP_TOKEN?.trim() || '';
  const bootstrapEmail =
    process.env.SUPER_ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase() || '';
  if (bootstrapEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrapEmail)) {
    throw new Error(
      `Invalid SUPER_ADMIN_BOOTSTRAP_EMAIL "${bootstrapEmail}". Must be a valid email address.`
    );
  }

  const rawInterval =
    process.env.REMINDER_WORKER_INTERVAL_MINUTES?.trim() || '30';
  const reminderWorkerIntervalMinutes = Number(rawInterval);
  if (
    !Number.isFinite(reminderWorkerIntervalMinutes) ||
    reminderWorkerIntervalMinutes < 0
  ) {
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

  const hasGoogleAdc = Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
  );

  return {
    port,
    host,
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
    bootstrapToken,
    bootstrapEmail,
    cronSecret: process.env.CRON_SECRET?.trim() || '',
    reminderWorkerIntervalMinutes,
    serviceAccount,
    hasGoogleAdc,
  };
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
    firebaseConfig.firestoreDatabaseId &&
    firebaseConfig.firestoreDatabaseId !== '(default)'
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
    firebaseConfig.firestoreDatabaseId &&
    firebaseConfig.firestoreDatabaseId !== '(default)'
      ? getFirestore(adminApp, firebaseConfig.firestoreDatabaseId)
      : getFirestore(adminApp);
} else {
  adminApp = getApps().length
    ? getApp()
    : initializeApp({ projectId: firebaseConfig.projectId });
}

const adminAuth: AdminAuth = getAuth(adminApp);
const dbClient = adminDb as unknown as DbClient | null;

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
}): Promise<{
  delivered: boolean;
  providerMessageId?: string;
  sentAt?: string;
  errorDetails?: string;
}> {
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
}): Promise<{
  delivered: boolean;
  providerMessageId?: string;
  sentAt?: string;
  errorDetails?: string;
}> {
  if (!env.whatsappConfigured) {
    return {
      delivered: false,
      errorDetails:
        'WHATSAPP_CLOUD_ACCESS_TOKEN is not configured on the server.',
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
        errorDetails:
          json?.error?.message || `WhatsApp Graph API HTTP ${resp.status}`,
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
      errorDetails:
        err instanceof Error
          ? err.message
          : 'WhatsApp Cloud API request failed',
    };
  }
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

const rateLimiter = new SlidingWindowRateLimiter();
const bootstrapController = new BootstrapController();
const reminderWorker = new ReminderWorker({
  db: dbClient,
  sendEmail: sendEmailReal,
  sendWhatsApp: sendWhatsAppReal,
  serverTimestamp: () => FieldValue.serverTimestamp(),
  intervalMinutes: env.reminderWorkerIntervalMinutes,
  orderByField: 'id',
});

async function startServer() {
  const bootstrapSyncPromise = dbClient
    ? bootstrapController.syncFromDatabase(dbClient)
    : Promise.resolve(false);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
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
        adminBootstrapConfigured: bootstrapController.isWebBootstrapEnabled(
          env.bootstrapToken,
          env.bootstrapEmail
        ),
        bootstrapCompleted: bootstrapController.isCompleted,
        cronConfigured: Boolean(env.cronSecret),
      },
      reminderWorker: reminderWorker.getStatus(),
    });
  });

  app.get('/api/notifications/capabilities', async (_req, res) => {
    await bootstrapSyncPromise;
    res.status(200).json({
      emailConfigured: env.emailConfigured,
      whatsappConfigured: env.whatsappConfigured,
      adminFirestoreConfigured: Boolean(adminDb),
      adminBootstrapConfigured: bootstrapController.isWebBootstrapEnabled(
        env.bootstrapToken,
        env.bootstrapEmail
      ),
      cronConfigured: Boolean(env.cronSecret),
      smtpFrom: env.emailConfigured ? env.smtpFrom : '',
    });
  });

  app.post('/api/notifications/send', async (req, res) => {
    let decoded;
    try {
      decoded = await verifyBearerUser(req);
    } catch (err) {
      res.status(401).json({
        delivered: false,
        errorDetails: err instanceof Error ? err.message : 'Unauthorized',
      });
      return;
    }

    let authorized;
    try {
      authorized = await authorizeAndResolveNotificationDispatch({
        db: dbClient,
        rateLimiter,
        actor: {
          uid: decoded.uid,
          email: decoded.email || '',
          emailVerified: decoded.email_verified === true,
        },
        body: (req.body || {}) as Record<string, unknown>,
        serverTimestamp: () => FieldValue.serverTimestamp(),
      });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({
          delivered: false,
          code: err.code,
          errorDetails: err.message,
        });
        return;
      }
      emitStructuredLog('error', 'notification-send', 'authorization_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        delivered: false,
        errorDetails: 'Failed to authorize notification request.',
      });
      return;
    }

    if (authorized.channel === 'EMAIL') {
      const outcome = await sendEmailReal({
        to: authorized.recipient,
        subject: authorized.subject,
        text: authorized.message,
        fromName: authorized.fromName,
      });
      res.status(200).json(outcome);
      return;
    }

    const outcome = await sendWhatsAppReal({
      phone: authorized.recipient,
      phoneNumberId: authorized.whatsappPhoneNumberId,
      templateName: authorized.whatsappApprovedTemplate,
      templateParams: authorized.whatsappTemplateParams,
      messageText: authorized.message,
    });
    res.status(200).json(outcome);
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

    const { bootstrapToken, displayName } = (req.body || {}) as {
      bootstrapToken?: string;
      displayName?: string;
    };

    try {
      await bootstrapSyncPromise;
      const result = await bootstrapController.executeWebBootstrap({
        db: dbClient,
        rateLimiter,
        clientIp: req.ip || req.socket.remoteAddress || 'unknown',
        actor: {
          uid: decoded.uid,
          email: decoded.email || '',
          emailVerified: decoded.email_verified === true,
        },
        displayName,
        bootstrapToken,
        configuredToken: env.bootstrapToken,
        configuredEmail: env.bootstrapEmail,
        serverTimestamp: () => FieldValue.serverTimestamp(),
        onSuccessInvalidateSecrets: () => {
          env.bootstrapToken = '';
          env.bootstrapEmail = '';
        },
      });
      res.status(200).json({ ok: true, uid: result.uid, email: result.email });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({
          ok: false,
          code: err.code,
          error: err.message,
        });
        return;
      }
      emitStructuredLog('error', 'admin-bootstrap', 'bootstrap_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Failed to initialize Super Admin.',
      });
    }
  });

  app.post('/api/cron/reminders', async (req, res) => {
    if (!env.cronSecret) {
      res
        .status(403)
        .json({ ok: false, error: 'CRON_SECRET is not configured on the server.' });
      return;
    }
    const authHeader = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match || !timingSafeMatch(match[1].trim(), env.cronSecret)) {
      res
        .status(401)
        .json({ ok: false, error: 'Invalid cron authorization token.' });
      return;
    }
    try {
      const result = await reminderWorker.sweep();
      res.status(200).json({ ok: true, ...result });
    } catch (err) {
      emitStructuredLog('error', 'cron-reminders', 'sweep_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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
        res
          .status(503)
          .send('Application bundle not built. Run npm run build first.');
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexFile);
    });
  }

  const httpServer = app.listen(env.port, env.host, () => {
    emitStructuredLog('info', 'server', 'listening', {
      port: env.port,
      host: env.host,
      emailConfigured: env.emailConfigured,
      whatsappConfigured: env.whatsappConfigured,
      adminFirestoreConfigured: Boolean(adminDb),
      bootstrapEnabled: bootstrapController.isWebBootstrapEnabled(
        env.bootstrapToken,
        env.bootstrapEmail
      ),
      reminderWorkerIntervalMinutes: env.reminderWorkerIntervalMinutes,
    });
  });

  if (adminDb && env.reminderWorkerIntervalMinutes > 0) {
    reminderWorker.start();
  }

  const shutdown = async (signal: string) => {
    emitStructuredLog('info', 'server', 'shutdown_initiated', { signal });
    await reminderWorker.stop();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    process.exit(0);
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

startServer().catch((err) => {
  emitStructuredLog('error', 'server', 'fatal_startup_error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

export type _UnusedCryptoRef = typeof crypto;
