import crypto from 'crypto';
import {
  buildReminderLogId,
  computeNextRetryState,
  computeRetryBackoffMinutes,
  evaluateDueReminders,
  isRetryDue,
  MAX_REMINDER_RETRIES,
} from '../lib/domain/reminders';
import { evaluateGymSubscriptionAccess } from '../lib/domain/subscription';
import {
  AccountStatus,
  DeliveryStatus,
  Gym,
  GymSettings,
  Member,
  Membership,
  NotificationLog,
  ReminderChannel,
  RenewalPolicy,
  SubscriptionStatus,
} from '../types/gymos';
import {
  DbClient,
  DbCollection,
  DbQuery,
  DbQueryDocSnap,
  timestampValueToMillis,
  withTransientRetry,
} from './firestore-types';
import { emitStructuredLog } from './logger';

export interface DeliveryOutcome {
  delivered: boolean;
  providerMessageId?: string;
  sentAt?: string;
  errorDetails?: string;
}

export interface SweepResult {
  skipped: boolean;
  reason?: string;
  gymsProcessed: number;
  gymsSkipped: number;
  candidatesEvaluated: number;
  newRemindersCreated: number;
  retriesAttempted: number;
  delivered: number;
  skippedOptOut: number;
  failed: number;
  duplicatesPrevented: number;
}

export interface WorkerStatusSnapshot {
  running: boolean;
  intervalMinutes: number;
  totalRuns: number;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunStats: SweepResult | null;
}

const WORKER_LOCK_COLLECTION = 'system_locks';
const WORKER_LOCK_DOC_ID = 'reminder_worker';
const WORKER_LOCK_TTL_MS = 5 * 60_000;
const ITEM_CLAIM_TTL_MS = 3 * 60_000;

async function paginateCollection(
  collection: DbCollection | DbQuery,
  pageSize: number,
  orderByField?: string,
  maxTotalDocs = 10000
): Promise<DbQueryDocSnap[]> {
  const allDocs: DbQueryDocSnap[] = [];
  let lastDoc: DbQueryDocSnap | null = null;

  while (allDocs.length < maxTotalDocs) {
    let q: DbQuery = orderByField ? collection.orderBy(orderByField) : collection;
    q = q.limit(pageSize);
    if (lastDoc !== null) {
      q = q.startAfter(lastDoc);
    }
    const snap = await withTransientRetry(() => q.get());
    if (snap.empty) break;

    allDocs.push(...snap.docs);
    if (snap.docs.length < pageSize) break;
    lastDoc = snap.docs[snap.docs.length - 1];
  }

  return allDocs;
}

function normalizeGymSettings(gym: Gym, raw?: Record<string, unknown>): GymSettings {
  return {
    gymId: gym.id,
    gracePeriodDays: Number(raw?.gracePeriodDays ?? gym.gracePeriodDays ?? 7),
    renewalPolicy:
      (raw?.renewalPolicy as RenewalPolicy) ||
      gym.renewalPolicy ||
      RenewalPolicy.EXTEND_FROM_EXPIRY,
    reminderDaysBefore: Array.isArray(raw?.reminderDaysBefore)
      ? (raw?.reminderDaysBefore as number[])
      : [7, 3, 1],
    sendOnExpiryDay: raw?.sendOnExpiryDay !== false,
    sendAfterExpiryDays: Array.isArray(raw?.sendAfterExpiryDays)
      ? (raw?.sendAfterExpiryDays as number[])
      : [3, 7],
    paymentRemindersEnabled: raw?.paymentRemindersEnabled !== false,
    upcomingPaymentReminderDays: Number(raw?.upcomingPaymentReminderDays ?? 3),
    overduePaymentReminderDays: Array.isArray(raw?.overduePaymentReminderDays)
      ? (raw?.overduePaymentReminderDays as number[])
      : [1, 3, 7, 14],
    ownerSubReminderDays: Array.isArray(raw?.ownerSubReminderDays)
      ? (raw?.ownerSubReminderDays as number[])
      : [7, 3, 1, 0, -3],
    lastReminderRunDate:
      typeof raw?.lastReminderRunDate === 'string' ? raw.lastReminderRunDate : undefined,
    emailEnabled: raw?.emailEnabled !== false,
    emailFromName:
      typeof raw?.emailFromName === 'string' ? raw.emailFromName : gym.name,
    inAppEnabled: raw?.inAppEnabled !== false,
    whatsappEnabled: Boolean(raw?.whatsappEnabled),
    whatsappPhoneNumberId:
      typeof raw?.whatsappPhoneNumberId === 'string'
        ? raw.whatsappPhoneNumberId
        : undefined,
    whatsappApprovedTemplate:
      typeof raw?.whatsappApprovedTemplate === 'string'
        ? raw.whatsappApprovedTemplate
        : undefined,
    currencySymbol:
      typeof raw?.currencySymbol === 'string' ? raw.currencySymbol : '₹',
    updatedAt: raw?.updatedAt ?? null,
  };
}

export class ReminderWorker {
  private readonly db: DbClient | null;
  private readonly sendEmail: (input: {
    to: string;
    subject: string;
    text: string;
    fromName?: string;
  }) => Promise<DeliveryOutcome>;
  private readonly sendWhatsApp: (input: {
    phone: string;
    phoneNumberId?: string;
    templateName?: string;
    templateParams?: string[];
    messageText: string;
  }) => Promise<DeliveryOutcome>;
  private readonly serverTimestamp: () => unknown;
  private readonly intervalMinutes: number;
  private readonly orderByField: string;

  private timer: ReturnType<typeof setInterval> | null = null;
  private activePromise: Promise<SweepResult> | null = null;
  private stopped = false;
  private totalRuns = 0;
  private lastRunStartedAt: string | null = null;
  private lastRunFinishedAt: string | null = null;
  private lastRunStats: SweepResult | null = null;

  constructor(options: {
    db: DbClient | null;
    sendEmail: (input: {
      to: string;
      subject: string;
      text: string;
      fromName?: string;
    }) => Promise<DeliveryOutcome>;
    sendWhatsApp: (input: {
      phone: string;
      phoneNumberId?: string;
      templateName?: string;
      templateParams?: string[];
      messageText: string;
    }) => Promise<DeliveryOutcome>;
    serverTimestamp: () => unknown;
    intervalMinutes: number;
    orderByField?: string;
  }) {
    this.db = options.db;
    this.sendEmail = options.sendEmail;
    this.sendWhatsApp = options.sendWhatsApp;
    this.serverTimestamp = options.serverTimestamp;
    this.intervalMinutes = options.intervalMinutes;
    this.orderByField = options.orderByField || 'id';
  }

  start(): void {
    if (!this.db || this.intervalMinutes <= 0 || this.timer) return;
    const intervalMs = Math.round(this.intervalMinutes * 60_000);
    this.timer = setInterval(() => {
      if (this.stopped) return;
      this.sweep().catch((err) => {
        emitStructuredLog('error', 'reminder-worker', 'scheduled_sweep_error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
    this.timer.unref?.();
    emitStructuredLog('info', 'reminder-worker', 'scheduler_started', {
      intervalMinutes: this.intervalMinutes,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activePromise) {
      await this.activePromise.catch(() => undefined);
    }
    emitStructuredLog('info', 'reminder-worker', 'scheduler_stopped');
  }

  getStatus(): WorkerStatusSnapshot {
    return {
      running: Boolean(this.activePromise),
      intervalMinutes: this.intervalMinutes,
      totalRuns: this.totalRuns,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      lastRunStats: this.lastRunStats,
    };
  }

  async sweep(options?: { nowMs?: number }): Promise<SweepResult> {
    if (this.activePromise) {
      return {
        skipped: true,
        reason: 'A reminder sweep is already active in this process.',
        gymsProcessed: 0,
        gymsSkipped: 0,
        candidatesEvaluated: 0,
        newRemindersCreated: 0,
        retriesAttempted: 0,
        delivered: 0,
        skippedOptOut: 0,
        failed: 0,
        duplicatesPrevented: 0,
      };
    }

    const promise = this.executeSweep(options?.nowMs ?? Date.now());
    this.activePromise = promise;
    try {
      return await promise;
    } finally {
      this.activePromise = null;
    }
  }

  private async acquireDistributedLock(
    workerId: string,
    nowMs: number
  ): Promise<boolean> {
    if (!this.db) return false;
    const lockRef = this.db
      .collection(WORKER_LOCK_COLLECTION)
      .doc(WORKER_LOCK_DOC_ID);
    return withTransientRetry(() =>
      this.db!.runTransaction(async (tx) => {
        const snap = await tx.get(lockRef);
        const existing = snap.exists ? snap.data() : undefined;
        const expiresAtMs = Number(existing?.expiresAtMs || 0);
        const released = existing?.released === true;

        if (snap.exists && !released && expiresAtMs > nowMs) {
          return false;
        }

        tx.set(lockRef, {
          id: WORKER_LOCK_DOC_ID,
          workerId,
          released: false,
          acquiredAtMs: nowMs,
          expiresAtMs: nowMs + WORKER_LOCK_TTL_MS,
          updatedAt: this.serverTimestamp(),
        });
        return true;
      })
    );
  }

  private async releaseDistributedLock(workerId: string): Promise<void> {
    if (!this.db) return;
    try {
      const lockRef = this.db
        .collection(WORKER_LOCK_COLLECTION)
        .doc(WORKER_LOCK_DOC_ID);
      await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(lockRef);
        if (!snap.exists) return;
        if (snap.data()?.workerId === workerId) {
          tx.set(lockRef, {
            id: WORKER_LOCK_DOC_ID,
            workerId,
            released: true,
            expiresAtMs: 0,
            updatedAt: this.serverTimestamp(),
          });
        }
      });
    } catch (err) {
      emitStructuredLog('warn', 'reminder-worker', 'lock_release_failed', {
        workerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async claimCandidateSlot(
    gymId: string,
    logId: string,
    workerId: string,
    nowMs: number
  ): Promise<boolean> {
    if (!this.db) return false;
    const logRef = this.db
      .collection('gyms')
      .doc(gymId)
      .collection('notification_logs')
      .doc(logId);
    const claimId = `claim_${gymId}_${logId}`.slice(0, 128);
    const claimRef = this.db.collection(WORKER_LOCK_COLLECTION).doc(claimId);

    return withTransientRetry(() =>
      this.db!.runTransaction(async (tx) => {
        const [logSnap, claimSnap] = await Promise.all([
          tx.get(logRef),
          tx.get(claimRef),
        ]);
        if (logSnap.exists) return false;

        const claimData = claimSnap.exists ? claimSnap.data() : undefined;
        if (
          claimSnap.exists &&
          claimData?.released !== true &&
          Number(claimData?.expiresAtMs || 0) > nowMs
        ) {
          return false;
        }

        tx.set(claimRef, {
          id: claimId,
          workerId,
          released: false,
          expiresAtMs: nowMs + ITEM_CLAIM_TTL_MS,
          updatedAt: this.serverTimestamp(),
        });
        return true;
      })
    );
  }

  private async claimRetrySlot(
    gymId: string,
    logId: string,
    workerId: string,
    nowMs: number,
    nowIso: string
  ): Promise<NotificationLog | null> {
    if (!this.db) return null;
    const logRef = this.db
      .collection('gyms')
      .doc(gymId)
      .collection('notification_logs')
      .doc(logId);
    const claimId = `retry_${gymId}_${logId}`.slice(0, 128);
    const claimRef = this.db.collection(WORKER_LOCK_COLLECTION).doc(claimId);

    return withTransientRetry(() =>
      this.db!.runTransaction(async (tx) => {
        const [logSnap, claimSnap] = await Promise.all([
          tx.get(logRef),
          tx.get(claimRef),
        ]);
        if (!logSnap.exists) return null;
        const freshLog = logSnap.data() as unknown as NotificationLog;
        if (!isRetryDue(freshLog, nowIso)) return null;

        const claimData = claimSnap.exists ? claimSnap.data() : undefined;
        if (
          claimSnap.exists &&
          claimData?.released !== true &&
          Number(claimData?.expiresAtMs || 0) > nowMs
        ) {
          return null;
        }

        tx.set(claimRef, {
          id: claimId,
          workerId,
          released: false,
          expiresAtMs: nowMs + ITEM_CLAIM_TTL_MS,
          updatedAt: this.serverTimestamp(),
        });
        return freshLog;
      })
    );
  }

  private async releaseItemLock(claimId: string, workerId: string): Promise<void> {
    if (!this.db) return;
    try {
      await this.db
        .collection(WORKER_LOCK_COLLECTION)
        .doc(claimId.slice(0, 128))
        .set({
          id: claimId.slice(0, 128),
          workerId,
          released: true,
          expiresAtMs: 0,
          updatedAt: this.serverTimestamp(),
        });
    } catch {
      // Lock expires via TTL if cleanup fails
    }
  }

  private async executeSweep(nowMs: number): Promise<SweepResult> {
    if (!this.db) {
      return {
        skipped: true,
        reason:
          'Firebase Admin Firestore credentials (FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS) are not configured.',
        gymsProcessed: 0,
        gymsSkipped: 0,
        candidatesEvaluated: 0,
        newRemindersCreated: 0,
        retriesAttempted: 0,
        delivered: 0,
        skippedOptOut: 0,
        failed: 0,
        duplicatesPrevented: 0,
      };
    }

    const workerId = `wrk_${crypto.randomBytes(6).toString('hex')}`;
    const locked = await this.acquireDistributedLock(workerId, nowMs);
    if (!locked) {
      return {
        skipped: true,
        reason: 'Another worker currently holds the reminder_worker execution lease.',
        gymsProcessed: 0,
        gymsSkipped: 0,
        candidatesEvaluated: 0,
        newRemindersCreated: 0,
        retriesAttempted: 0,
        delivered: 0,
        skippedOptOut: 0,
        failed: 0,
        duplicatesPrevented: 0,
      };
    }

    const nowIso = new Date(nowMs).toISOString();
    const todayIso = nowIso.slice(0, 10);
    this.lastRunStartedAt = nowIso;

    const stats: SweepResult = {
      skipped: false,
      gymsProcessed: 0,
      gymsSkipped: 0,
      candidatesEvaluated: 0,
      newRemindersCreated: 0,
      retriesAttempted: 0,
      delivered: 0,
      skippedOptOut: 0,
      failed: 0,
      duplicatesPrevented: 0,
    };

    try {
      const gymDocs = await paginateCollection(
        this.db.collection('gyms'),
        50,
        this.orderByField
      );

      for (const gymDoc of gymDocs) {
        if (this.stopped) break;

        const rawGym = gymDoc.data();
        const gym = { ...rawGym, id: String(rawGym.id || gymDoc.id) } as Gym;

        if (
          gym.accountStatus === AccountStatus.SUSPENDED ||
          gym.subscriptionStatus === SubscriptionStatus.PENDING ||
          gym.subscriptionStatus === SubscriptionStatus.CANCELLED
        ) {
          stats.gymsSkipped += 1;
          continue;
        }

        const accessState = evaluateGymSubscriptionAccess(gym, todayIso);
        const accessUntilMs = timestampValueToMillis(gym.subscriptionAccessUntil);
        const accessExpired =
          accessState.isLocked || (accessUntilMs !== null && accessUntilMs <= nowMs);

        stats.gymsProcessed += 1;

        const settingsRef = gymDoc.ref.collection('settings').doc('default');
        const settingsSnap = await withTransientRetry(() => settingsRef.get());
        const settings = normalizeGymSettings(
          gym,
          settingsSnap.exists ? settingsSnap.data() : undefined
        );

        // 1. Evaluate and generate new due reminders (dedup scoped to todayIso via single-field index)
        const existingLogDocs = await paginateCollection(
          gymDoc.ref
            .collection('notification_logs')
            .where('scheduledDate', '==', todayIso),
          250
        );
        const existingLogs = existingLogDocs.map(
          (d) => d.data() as unknown as NotificationLog
        );

        let members: Member[] = [];
        let memberships: Membership[] = [];

        if (!accessExpired) {
          const [memberDocs, membershipDocs] = await Promise.all([
            paginateCollection(
              gymDoc.ref.collection('members'),
              250,
              this.orderByField
            ),
            paginateCollection(
              gymDoc.ref.collection('memberships'),
              250,
              this.orderByField
            ),
          ]);
          members = memberDocs.map((d) => d.data() as unknown as Member);
          memberships = membershipDocs.map((d) => d.data() as unknown as Membership);
        }
        // When accessExpired && accountStatus === ACTIVE, evaluateDueReminders with empty members
        // evaluates only OWNER_SUB_* gym owner subscription billing reminders!

        const candidates = evaluateDueReminders(
          members,
          settings,
          existingLogs,
          todayIso,
          { memberships, gym }
        );
        stats.candidatesEvaluated += candidates.length;

        let touchedNewReminders = false;
        for (const c of candidates) {
          if (this.stopped) break;
          const logId = buildReminderLogId(c.dedupKey);
          const claimed = await this.claimCandidateSlot(
            gym.id,
            logId,
            workerId,
            nowMs
          );
          if (!claimed) {
            stats.duplicatesPrevented += 1;
            continue;
          }

          const claimId = `claim_${gym.id}_${logId}`;
          try {
            const attemptIso = new Date().toISOString();
            let deliveryStatus = DeliveryStatus.SENT;
            let errorDetails = '';
            let providerMessageId = '';
            let sentAt = '';
            let nextRetryAt = '';

            if (c.skippedOptOut) {
              deliveryStatus = DeliveryStatus.SKIPPED_OPT_OUT;
              stats.skippedOptOut += 1;
            } else if (c.channel === ReminderChannel.IN_APP) {
              deliveryStatus = DeliveryStatus.SENT;
              sentAt = attemptIso;
              stats.delivered += 1;
              const notifId = `gnotif_${crypto.randomBytes(8).toString('hex')}`;
              await withTransientRetry(() =>
                gymDoc.ref.collection('notifications').doc(notifId).set({
                  id: notifId,
                  gymId: gym.id,
                  type: `REMINDER_${c.category}`,
                  title: c.subject.slice(0, 160),
                  message: c.message.slice(0, 500),
                  isRead: false,
                  createdAt: this.serverTimestamp(),
                })
              );
            } else {
              const outcome =
                c.channel === ReminderChannel.EMAIL
                  ? await this.sendEmail({
                      to: c.recipient,
                      subject: c.subject,
                      text: c.message,
                      fromName: settings.emailFromName || gym.name,
                    })
                  : await this.sendWhatsApp({
                      phone: c.recipient,
                      phoneNumberId: settings.whatsappPhoneNumberId,
                      templateName: settings.whatsappApprovedTemplate,
                      templateParams: [c.memberName, c.template.replace(/_/g, ' ')],
                      messageText: c.message,
                    });

              if (outcome.delivered) {
                deliveryStatus = DeliveryStatus.SENT;
                providerMessageId = outcome.providerMessageId || '';
                sentAt = outcome.sentAt || attemptIso;
                stats.delivered += 1;
              } else {
                deliveryStatus = DeliveryStatus.RETRY_SCHEDULED;
                errorDetails = (outcome.errorDetails || 'Delivery attempt failed').slice(
                  0,
                  400
                );
                const backoffMin = computeRetryBackoffMinutes(0);
                nextRetryAt = new Date(nowMs + backoffMin * 60_000).toISOString();
                stats.failed += 1;
              }
            }

            await withTransientRetry(() =>
              gymDoc.ref
                .collection('notification_logs')
                .doc(logId)
                .set({
                  id: logId,
                  gymId: gym.id,
                  memberId: c.memberId,
                  memberName: c.memberName,
                  recipient: c.recipient,
                  channel: c.channel,
                  category: c.category,
                  template: c.template,
                  dedupKey: c.dedupKey,
                  scheduledDate: c.scheduledDate,
                  deliveryStatus,
                  retryCount: 0,
                  lastAttemptAt: attemptIso,
                  ...(sentAt ? { sentAt } : {}),
                  ...(providerMessageId ? { providerMessageId } : {}),
                  ...(errorDetails ? { errorDetails } : {}),
                  ...(nextRetryAt ? { nextRetryAt } : {}),
                  createdAt: this.serverTimestamp(),
                  updatedAt: this.serverTimestamp(),
                })
            );
            stats.newRemindersCreated += 1;
            touchedNewReminders = true;
          } finally {
            await this.releaseItemLock(claimId, workerId);
          }
        }

        if (touchedNewReminders || (settingsSnap.exists && settings.lastReminderRunDate !== todayIso)) {
          if (settingsSnap.exists) {
            await withTransientRetry(() =>
              settingsRef.update({
                lastReminderRunDate: todayIso,
                updatedAt: this.serverTimestamp(),
              })
            );
          }
        }

        // 2. Process due retries ONLY for active, unexpired gyms (respecting nextRetryAt & backoff)
        if (accessExpired) continue;

        const retryQueryDocs = await paginateCollection(
          gymDoc.ref
            .collection('notification_logs')
            .where('deliveryStatus', '==', DeliveryStatus.RETRY_SCHEDULED),
          100,
          undefined,
          500
        );

        for (const retryDoc of retryQueryDocs) {
          if (this.stopped) break;
          const candidateLog = retryDoc.data() as unknown as NotificationLog;
          if (!isRetryDue(candidateLog, nowIso)) continue;
          if ((candidateLog.retryCount || 0) >= MAX_REMINDER_RETRIES) continue;

          const claimedLog = await this.claimRetrySlot(
            gym.id,
            retryDoc.id,
            workerId,
            nowMs,
            nowIso
          );
          if (!claimedLog) {
            stats.duplicatesPrevented += 1;
            continue;
          }

          const claimId = `retry_${gym.id}_${retryDoc.id}`;
          try {
            stats.retriesAttempted += 1;
            const attemptMs = nowMs;
            const attemptIso = nowIso;
            const subject = `${gym.name}: Reminder (${claimedLog.template.replace(/_/g, ' ')})`;
            const message = `Hi ${claimedLog.memberName}, this is a reminder from ${gym.name} regarding ${claimedLog.template.replace(/_/g, ' ').toLowerCase()}.`;

            let outcome: DeliveryOutcome = {
              delivered: false,
              errorDetails: 'Unsupported channel for retry',
            };

            if (claimedLog.channel === ReminderChannel.IN_APP) {
              outcome = {
                delivered: true,
                providerMessageId: `inapp_retry_${attemptMs}`,
                sentAt: attemptIso,
              };
            } else if (claimedLog.channel === ReminderChannel.EMAIL) {
              outcome = await this.sendEmail({
                to: claimedLog.recipient,
                subject,
                text: message,
                fromName: settings.emailFromName || gym.name,
              });
            } else if (claimedLog.channel === ReminderChannel.WHATSAPP_CLOUD) {
              outcome = await this.sendWhatsApp({
                phone: claimedLog.recipient,
                phoneNumberId: settings.whatsappPhoneNumberId,
                templateName: settings.whatsappApprovedTemplate,
                templateParams: [
                  claimedLog.memberName,
                  claimedLog.template.replace(/_/g, ' '),
                ],
                messageText: message,
              });
            }

            const next = computeNextRetryState(
              claimedLog,
              outcome.delivered,
              outcome.errorDetails,
              attemptMs
            );

            if (outcome.delivered) {
              stats.delivered += 1;
              await withTransientRetry(() =>
                retryDoc.ref.update({
                  deliveryStatus: next.nextStatus,
                  retryCount: next.nextRetryCount,
                  errorDetails: '',
                  providerMessageId: outcome.providerMessageId || '',
                  sentAt: outcome.sentAt || attemptIso,
                  lastAttemptAt: attemptIso,
                  nextRetryAt: '',
                  updatedAt: this.serverTimestamp(),
                })
              );
            } else {
              stats.failed += 1;
              await withTransientRetry(() =>
                retryDoc.ref.update({
                  deliveryStatus: next.nextStatus,
                  retryCount: next.nextRetryCount,
                  errorDetails: (next.errorDetails || 'Delivery failed').slice(0, 400),
                  lastAttemptAt: attemptIso,
                  nextRetryAt: next.nextRetryAt,
                  updatedAt: this.serverTimestamp(),
                })
              );
            }
          } finally {
            await this.releaseItemLock(claimId, workerId);
          }
        }
      }

      this.totalRuns += 1;
      this.lastRunFinishedAt = new Date().toISOString();
      this.lastRunStats = stats;

      emitStructuredLog('info', 'reminder-worker', 'sweep_completed', {
        workerId,
        ...stats,
      });
      return stats;
    } finally {
      await this.releaseDistributedLock(workerId);
    }
  }
}
