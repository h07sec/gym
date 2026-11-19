import crypto from 'crypto';
import { DbClient, withTransientRetry } from './firestore-types';
import { emitStructuredLog } from './logger';
import { HttpError, VerifiedCaller } from './notification-guard';
import { SlidingWindowRateLimiter } from './rate-limiter';

export const BOOTSTRAP_DOC_COLLECTION = 'platform_bootstrap';
export const BOOTSTRAP_DOC_ID = 'default';
export const BOOTSTRAP_RATE_LIMIT = { limit: 5, windowMs: 15 * 60_000 };

export function timingSafeMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

async function recordBootstrapAudit(
  db: DbClient,
  serverTimestamp: () => unknown,
  entry: {
    actorUid: string;
    actorEmail: string;
    actorRole: string;
    action: string;
    summary: string;
  }
): Promise<void> {
  try {
    const id = `aud_${crypto.randomBytes(8).toString('hex')}`;
    await db.collection('audit_logs').doc(id).set({
      id,
      actorUid: entry.actorUid,
      actorEmail: entry.actorEmail || 'unknown@gymos.local',
      actorRole: entry.actorRole,
      action: entry.action,
      entityType: 'PlatformBootstrap',
      entityId: BOOTSTRAP_DOC_ID,
      summary: entry.summary.slice(0, 300),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    emitStructuredLog('warn', 'bootstrap-service', 'audit_write_failed', {
      action: entry.action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export class BootstrapController {
  private completed = false;
  private inFlight = false;

  get isCompleted(): boolean {
    return this.completed;
  }

  isWebBootstrapEnabled(configuredToken: string, configuredEmail: string): boolean {
    return !this.completed && Boolean(configuredToken.trim() && configuredEmail.trim());
  }

  async syncFromDatabase(db: DbClient | null): Promise<boolean> {
    if (!db) return this.completed;
    try {
      const [lockSnap, adminSnap] = await withTransientRetry(() =>
        Promise.all([
          db.collection(BOOTSTRAP_DOC_COLLECTION).doc(BOOTSTRAP_DOC_ID).get(),
          db.collection('platform_admins').limit(1).get(),
        ])
      );
      if (
        (lockSnap.exists && lockSnap.data()?.completed === true) ||
        !adminSnap.empty
      ) {
        this.completed = true;
      }
    } catch (err) {
      emitStructuredLog('warn', 'bootstrap-service', 'sync_state_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.completed;
  }

  async executeWebBootstrap(params: {
    db: DbClient | null;
    rateLimiter: SlidingWindowRateLimiter;
    clientIp: string;
    actor: VerifiedCaller;
    displayName?: string;
    bootstrapToken?: string;
    configuredToken: string;
    configuredEmail: string;
    serverTimestamp: () => unknown;
    onSuccessInvalidateSecrets: () => void;
    nowMs?: number;
  }): Promise<{ uid: string; email: string }> {
    const {
      db,
      rateLimiter,
      clientIp,
      actor,
      displayName,
      bootstrapToken,
      configuredToken,
      configuredEmail,
      serverTimestamp,
      onSuccessInvalidateSecrets,
    } = params;
    const nowMs = params.nowMs ?? Date.now();

    // Enforce rate limiting by both IP and caller UID before token evaluation
    const ipLimit = rateLimiter.consume(
      `bootstrap:ip:${clientIp || 'unknown'}`,
      BOOTSTRAP_RATE_LIMIT.limit,
      BOOTSTRAP_RATE_LIMIT.windowMs,
      nowMs
    );
    const uidLimit = rateLimiter.consume(
      `bootstrap:uid:${actor.uid}`,
      BOOTSTRAP_RATE_LIMIT.limit,
      BOOTSTRAP_RATE_LIMIT.windowMs,
      nowMs
    );
    if (!ipLimit.allowed || !uidLimit.allowed) {
      if (db) {
        await recordBootstrapAudit(db, serverTimestamp, {
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorRole: 'USER',
          action: 'BOOTSTRAP_RATE_LIMITED',
          summary: `Rate-limited Super Admin bootstrap attempt from ${actor.email} (${clientIp})`,
        });
      }
      throw new HttpError(
        429,
        'BOOTSTRAP_RATE_LIMITED',
        'Too many bootstrap attempts. Try again later.'
      );
    }

    if (this.completed) {
      throw new HttpError(
        409,
        'BOOTSTRAP_ALREADY_COMPLETED',
        'Platform Super Admin is already initialized. An existing Super Admin must authorize additional administrators.'
      );
    }

    if (!configuredToken.trim() || !configuredEmail.trim()) {
      throw new HttpError(
        403,
        'BOOTSTRAP_DISABLED',
        'Super Admin web bootstrap requires both SUPER_ADMIN_BOOTSTRAP_TOKEN and SUPER_ADMIN_BOOTSTRAP_EMAIL.'
      );
    }

    if (!actor.email || !actor.emailVerified) {
      throw new HttpError(
        401,
        'EMAIL_VERIFICATION_REQUIRED',
        'Verified email authentication is required.'
      );
    }

    if (!db) {
      throw new HttpError(
        503,
        'ADMIN_DB_UNAVAILABLE',
        'Server-side Firestore credentials are not configured.'
      );
    }

    const callerEmail = actor.email.trim().toLowerCase();
    const allowlistedEmail = configuredEmail.trim().toLowerCase();

    const tokenValid =
      typeof bootstrapToken === 'string' &&
      timingSafeMatch(bootstrapToken.trim(), configuredToken.trim());
    const emailAllowed = timingSafeMatch(callerEmail, allowlistedEmail);

    if (!tokenValid || !emailAllowed) {
      await recordBootstrapAudit(db, serverTimestamp, {
        actorUid: actor.uid,
        actorEmail: callerEmail,
        actorRole: 'USER',
        action: 'BOOTSTRAP_ATTEMPT_DENIED',
        summary: `Rejected Super Admin bootstrap attempt for ${callerEmail} (tokenValid=${tokenValid}, emailAllowed=${emailAllowed})`,
      });
      throw new HttpError(
        403,
        'BOOTSTRAP_UNAUTHORIZED',
        'Invalid bootstrap token or caller email is not allowlisted for initial Super Admin setup.'
      );
    }

    if (this.inFlight) {
      throw new HttpError(
        409,
        'BOOTSTRAP_IN_PROGRESS',
        'Super Admin bootstrap is already in progress.'
      );
    }

    this.inFlight = true;
    try {
      const resolvedName = (
        displayName ||
        callerEmail.split('@')[0] ||
        'Platform Admin'
      )
        .trim()
        .slice(0, 120);

      await db.runTransaction(async (tx) => {
        const lockRef = db
          .collection(BOOTSTRAP_DOC_COLLECTION)
          .doc(BOOTSTRAP_DOC_ID);
        const adminsQuery = db.collection('platform_admins').limit(1);
        const [lockSnap, adminsSnap] = await Promise.all([
          tx.get(lockRef),
          tx.get(adminsQuery),
        ]);

        if (
          (lockSnap.exists && lockSnap.data()?.completed === true) ||
          !adminsSnap.empty
        ) {
          throw new HttpError(
            409,
            'BOOTSTRAP_ALREADY_COMPLETED',
            'Platform Super Admin is already initialized. An existing Super Admin must authorize additional administrators.'
          );
        }

        tx.set(lockRef, {
          id: BOOTSTRAP_DOC_ID,
          completed: true,
          adminUid: actor.uid,
          adminEmail: callerEmail,
          method: 'WEB_BOOTSTRAP',
          completedAt: serverTimestamp(),
        });

        tx.set(db.collection('platform_admins').doc(actor.uid), {
          uid: actor.uid,
          email: callerEmail,
          displayName: resolvedName,
          createdAt: serverTimestamp(),
        });

        tx.set(
          db.collection('users').doc(actor.uid),
          {
            uid: actor.uid,
            email: callerEmail,
            displayName: resolvedName,
            role: 'SUPER_ADMIN',
            status: 'ACTIVE',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );

        const auditId = `aud_${crypto.randomBytes(8).toString('hex')}`;
        tx.set(db.collection('audit_logs').doc(auditId), {
          id: auditId,
          actorUid: actor.uid,
          actorEmail: callerEmail,
          actorRole: 'SUPER_ADMIN',
          action: 'BOOTSTRAP_SUPER_ADMIN',
          entityType: 'PlatformAdmin',
          entityId: actor.uid,
          summary: `Initialized initial platform Super Admin (${callerEmail}) via atomic one-time bootstrap`,
          createdAt: serverTimestamp(),
        });
      });

      this.completed = true;
      onSuccessInvalidateSecrets();
      emitStructuredLog('info', 'bootstrap-service', 'bootstrap_completed', {
        uid: actor.uid,
        email: callerEmail,
      });

      return { uid: actor.uid, email: callerEmail };
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        this.completed = true;
        onSuccessInvalidateSecrets();
      }
      throw err;
    } finally {
      this.inFlight = false;
    }
  }
}
