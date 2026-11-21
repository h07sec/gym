import crypto from 'crypto';
import { evaluateGymSubscriptionAccess } from '../lib/domain/subscription';
import { AccountStatus, Gym, RenewalPolicy, SubscriptionStatus } from '../types/gymos';
import { DbClient, timestampValueToMillis, withTransientRetry } from './firestore-types';
import { emitStructuredLog } from './logger';
import { SlidingWindowRateLimiter } from './rate-limiter';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface VerifiedCaller {
  uid: string;
  email: string;
  emailVerified: boolean;
}

export interface NotificationSendBody {
  gymId?: unknown;
  memberId?: unknown;
  targetType?: unknown;
  channel?: unknown;
  category?: unknown;
  template?: unknown;
  subject?: unknown;
  message?: unknown;
  recipient?: unknown;
  fromName?: unknown;
  whatsappPhoneNumberId?: unknown;
  whatsappApprovedTemplate?: unknown;
  whatsappTemplateParams?: unknown;
}

export interface AuthorizedNotificationDispatch {
  gymId: string;
  gymName: string;
  memberId: string;
  targetType: 'MEMBER' | 'OWNER_SUBSCRIPTION';
  channel: 'EMAIL' | 'WHATSAPP_CLOUD';
  recipient: string;
  subject: string;
  message: string;
  fromName: string;
  whatsappPhoneNumberId?: string;
  whatsappApprovedTemplate?: string;
  whatsappTemplateParams?: string[];
}

const VALID_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export const USER_RATE_LIMIT = { limit: 25, windowMs: 10 * 60_000 };
export const GYM_RATE_LIMIT = { limit: 100, windowMs: 10 * 60_000 };

async function writeSecurityAuditLog(
  db: DbClient,
  serverTimestamp: () => unknown,
  entry: {
    actorUid: string;
    actorEmail: string;
    actorRole: string;
    gymId?: string;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
  }
): Promise<void> {
  try {
    const id = `aud_${crypto.randomBytes(8).toString('hex')}`;
    await db.collection('audit_logs').doc(id).set({
      id,
      actorUid: entry.actorUid,
      actorEmail: entry.actorEmail || 'unknown@gymos.local',
      actorRole: entry.actorRole || 'UNKNOWN',
      ...(entry.gymId ? { gymId: entry.gymId } : {}),
      action: entry.action.slice(0, 80),
      entityType: entry.entityType.slice(0, 64),
      entityId: entry.entityId.slice(0, 128),
      summary: entry.summary.slice(0, 300),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    emitStructuredLog('warn', 'notification-guard', 'audit_log_write_failed', {
      action: entry.action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function authorizeAndResolveNotificationDispatch(params: {
  db: DbClient | null;
  rateLimiter: SlidingWindowRateLimiter;
  actor: VerifiedCaller;
  body: NotificationSendBody;
  serverTimestamp: () => unknown;
  nowMs?: number;
}): Promise<AuthorizedNotificationDispatch> {
  const { db, rateLimiter, actor, body, serverTimestamp } = params;
  const nowMs = params.nowMs ?? Date.now();
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);

  if (!db) {
    throw new HttpError(
      503,
      'ADMIN_DB_UNAVAILABLE',
      'Notification authorization requires server-side Firestore credentials.'
    );
  }

  const gymId = typeof body.gymId === 'string' ? body.gymId.trim() : '';
  const channel = typeof body.channel === 'string' ? body.channel.trim() : '';
  const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
  const rawSubject =
    typeof body.subject === 'string'
      ? body.subject.replace(/[\r\n]+/g, ' ').trim()
      : 'GymOS Reminder';
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const rawTargetType =
    typeof body.targetType === 'string' ? body.targetType.trim() : '';

  if (!VALID_ID_RE.test(gymId)) {
    throw new HttpError(400, 'INVALID_GYM_ID', 'Valid gymId is required.');
  }
  if (channel !== 'EMAIL' && channel !== 'WHATSAPP_CLOUD') {
    throw new HttpError(
      400,
      'UNSUPPORTED_CHANNEL',
      `Unsupported delivery channel "${channel}".`
    );
  }
  if (!rawMessage || rawMessage.length > 1000) {
    throw new HttpError(
      400,
      'INVALID_MESSAGE',
      'Message body is required and must be 1000 characters or fewer.'
    );
  }

  const targetType: 'MEMBER' | 'OWNER_SUBSCRIPTION' =
    rawTargetType === 'OWNER_SUBSCRIPTION' || memberId === `owner_${gymId}`
      ? 'OWNER_SUBSCRIPTION'
      : 'MEMBER';

  if (targetType === 'MEMBER' && !VALID_ID_RE.test(memberId)) {
    throw new HttpError(
      400,
      'INVALID_MEMBER_ID',
      'Valid memberId (or OWNER_SUBSCRIPTION targetType) is required.'
    );
  }

  // Per-user rate limit
  const userLimit = rateLimiter.consume(
    `notif:user:${actor.uid}`,
    USER_RATE_LIMIT.limit,
    USER_RATE_LIMIT.windowMs,
    nowMs
  );
  if (!userLimit.allowed) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: 'USER',
      gymId,
      action: 'NOTIFICATION_RATE_LIMITED',
      entityType: 'Notification',
      entityId: actor.uid,
      summary: `Per-user notification rate limit exceeded for ${actor.email}`,
    });
    throw new HttpError(
      429,
      'USER_RATE_LIMITED',
      `Rate limit exceeded. Retry after ${userLimit.retryAfterSeconds}s.`
    );
  }

  // Per-gym rate limit
  const gymLimit = rateLimiter.consume(
    `notif:gym:${gymId}`,
    GYM_RATE_LIMIT.limit,
    GYM_RATE_LIMIT.windowMs,
    nowMs
  );
  if (!gymLimit.allowed) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: 'USER',
      gymId,
      action: 'NOTIFICATION_GYM_RATE_LIMITED',
      entityType: 'Gym',
      entityId: gymId,
      summary: `Per-gym notification rate limit exceeded for gym ${gymId}`,
    });
    throw new HttpError(
      429,
      'GYM_RATE_LIMITED',
      `Gym notification quota exceeded. Retry after ${gymLimit.retryAfterSeconds}s.`
    );
  }

  // Load caller GymOS profile
  const userSnap = await withTransientRetry(() =>
    db.collection('users').doc(actor.uid).get()
  );
  if (!userSnap.exists) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: 'UNREGISTERED',
      gymId,
      action: 'NOTIFICATION_SEND_DENIED',
      entityType: 'Gym',
      entityId: gymId,
      summary: `Rejected notification attempt by unregistered account ${actor.email}`,
    });
    throw new HttpError(403, 'PROFILE_NOT_FOUND', 'Active GymOS profile is required.');
  }

  const user = userSnap.data() || {};
  const userRole = String(user.role || '');
  const userStatus = String(user.status || '');
  const userGymId = String(user.gymId || '');

  if (userStatus !== 'ACTIVE') {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: userRole || 'UNKNOWN',
      gymId,
      action: 'NOTIFICATION_SEND_DENIED',
      entityType: 'User',
      entityId: actor.uid,
      summary: `Rejected notification attempt by deactivated account ${actor.email}`,
    });
    throw new HttpError(403, 'ACCOUNT_DEACTIVATED', 'Your GymOS account is deactivated.');
  }

  let authorized = false;
  if (userRole === 'SUPER_ADMIN') {
    const adminSnap = await withTransientRetry(() =>
      db.collection('platform_admins').doc(actor.uid).get()
    );
    authorized = adminSnap.exists;
  } else if (userGymId === gymId) {
    if (userRole === 'GYM_OWNER') {
      authorized = true;
    } else if (
      ['GYM_MANAGER', 'GYM_RECEPTIONIST', 'GYM_TRAINER'].includes(userRole)
    ) {
      const staffSnap = await withTransientRetry(() =>
        db.collection('gyms').doc(gymId).collection('staff').doc(actor.uid).get()
      );
      if (staffSnap.exists) {
        const staff = staffSnap.data() || {};
        const perms = (staff.permissions || {}) as Record<string, unknown>;
        if (
          staff.status === 'ACTIVE' &&
          perms.canManageReminders === true
        ) {
          authorized = true;
        }
      }
    }
  }

  if (!authorized) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: userRole || 'UNKNOWN',
      gymId,
      action: 'NOTIFICATION_SEND_DENIED',
      entityType: 'Gym',
      entityId: gymId,
      summary: `Unauthorized notification attempt for gym ${gymId} by ${actor.email} (${userRole})`,
    });
    throw new HttpError(
      403,
      'FORBIDDEN_NOTIFICATION_ROLE',
      'You are not authorized to send reminders for this gym.'
    );
  }

  // Verify gym exists & is active/unexpired
  const gymRef = db.collection('gyms').doc(gymId);
  const [gymSnap, settingsSnap] = await withTransientRetry(() =>
    Promise.all([gymRef.get(), gymRef.collection('settings').doc('default').get()])
  );

  if (!gymSnap.exists) {
    throw new HttpError(404, 'GYM_NOT_FOUND', 'Authorized gym record not found.');
  }

  const gymData = gymSnap.data() || {};
  const gymName = String(gymData.name || 'GymOS');
  const accessState = evaluateGymSubscriptionAccess(
    {
      accountStatus: (gymData.accountStatus as AccountStatus) || AccountStatus.SUSPENDED,
      subscriptionStatus:
        (gymData.subscriptionStatus as SubscriptionStatus) || SubscriptionStatus.EXPIRED,
      subscriptionEndAt: String(gymData.subscriptionEndAt || ''),
      gracePeriodDays: Number(gymData.gracePeriodDays || 0),
    },
    todayIso
  );
  const accessUntilMs = timestampValueToMillis(gymData.subscriptionAccessUntil);
  const accessTimestampMissingOrExpired = accessUntilMs === null || accessUntilMs <= nowMs;

  if (accessState.isLocked || accessTimestampMissingOrExpired) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: userRole,
      gymId,
      action: 'NOTIFICATION_GYM_INACTIVE',
      entityType: 'Gym',
      entityId: gymId,
      summary: `Blocked notification dispatch for inactive/expired gym ${gymId} (${accessState.reason})`,
    });
    throw new HttpError(
      403,
      'GYM_INACTIVE',
      'Notifications are blocked while gym account or subscription is inactive.'
    );
  }

  // Resolve trusted notification configuration strictly from DB settings
  const settingsData = settingsSnap.exists ? settingsSnap.data() || {} : {};
  const emailEnabled = settingsData.emailEnabled !== false;
  const emailFromName = String(settingsData.emailFromName || gymName || 'GymOS')
    .replace(/["<>]/g, '')
    .trim()
    .slice(0, 120);
  const whatsappEnabled = Boolean(settingsData.whatsappEnabled);
  const whatsappPhoneNumberId = String(settingsData.whatsappPhoneNumberId || '').trim();
  const whatsappApprovedTemplate = String(
    settingsData.whatsappApprovedTemplate || ''
  ).trim();

  // Detect any frontend attempt to spoof WhatsApp Phone Number ID or template
  if (
    typeof body.whatsappPhoneNumberId === 'string' &&
    body.whatsappPhoneNumberId.trim() &&
    body.whatsappPhoneNumberId.trim() !== whatsappPhoneNumberId
  ) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: userRole,
      gymId,
      action: 'NOTIFICATION_CONFIG_TAMPER',
      entityType: 'GymSettings',
      entityId: gymId,
      summary: `Rejected mismatched WhatsApp Phone Number ID supplied by ${actor.email}`,
    });
    throw new HttpError(
      403,
      'CONFIG_MISMATCH',
      'WhatsApp Phone Number ID must match saved gym configuration.'
    );
  }

  if (channel === 'EMAIL' && !emailEnabled) {
    throw new HttpError(
      400,
      'EMAIL_DISABLED',
      'Email notifications are disabled in this gym settings.'
    );
  }

  if (channel === 'WHATSAPP_CLOUD') {
    if (!whatsappEnabled || !whatsappPhoneNumberId || !whatsappApprovedTemplate) {
      throw new HttpError(
        400,
        'WHATSAPP_NOT_CONFIGURED',
        'WhatsApp Cloud API is not enabled or configured in this gym settings.'
      );
    }
  }

  // Resolve trusted recipient strictly from database records
  let trustedRecipient = '';
  let resolvedMemberId = memberId || `owner_${gymId}`;

  if (targetType === 'OWNER_SUBSCRIPTION') {
    if (channel !== 'EMAIL') {
      throw new HttpError(
        400,
        'INVALID_OWNER_CHANNEL',
        'Owner subscription reminders support EMAIL channel only.'
      );
    }
    trustedRecipient = String(gymData.email || '').trim();
    resolvedMemberId = `owner_${gymId}`;
    if (!trustedRecipient) {
      throw new HttpError(
        400,
        'MISSING_OWNER_EMAIL',
        'Gym owner email address is missing.'
      );
    }
  } else {
    const memberSnap = await withTransientRetry(() =>
      gymRef.collection('members').doc(memberId).get()
    );
    if (!memberSnap.exists) {
      await writeSecurityAuditLog(db, serverTimestamp, {
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorRole: userRole,
        gymId,
        action: 'NOTIFICATION_INVALID_RECIPIENT',
        entityType: 'Member',
        entityId: memberId,
        summary: `Rejected notification for non-existent member ${memberId} in gym ${gymId}`,
      });
      throw new HttpError(
        404,
        'MEMBER_NOT_FOUND',
        'Recipient member does not belong to the authorized gym.'
      );
    }

    const member = memberSnap.data() || {};
    if (String(member.gymId || '') !== gymId || member.isArchived === true) {
      throw new HttpError(
        403,
        'INVALID_MEMBER_STATE',
        'Recipient member is archived or does not belong to this gym.'
      );
    }
    if (member.reminderOptOut === true) {
      throw new HttpError(
        400,
        'MEMBER_OPTED_OUT',
        'Member has opted out of automated reminders.'
      );
    }

    trustedRecipient =
      channel === 'EMAIL'
        ? String(member.email || '').trim()
        : String(member.phone || '').trim();
    if (!trustedRecipient) {
      throw new HttpError(
        400,
        'MISSING_MEMBER_CONTACT',
        `Member does not have a valid ${channel === 'EMAIL' ? 'email address' : 'phone number'}.`
      );
    }
  }

  // If client also included a recipient string, verify it matches the DB contact
  if (typeof body.recipient === 'string' && body.recipient.trim()) {
    const supplied = body.recipient.trim();
    const mismatch =
      channel === 'EMAIL'
        ? supplied.toLowerCase() !== trustedRecipient.toLowerCase()
        : supplied.replace(/\D/g, '') !== trustedRecipient.replace(/\D/g, '');
    if (mismatch) {
      await writeSecurityAuditLog(db, serverTimestamp, {
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorRole: userRole,
        gymId,
        action: 'NOTIFICATION_RECIPIENT_MISMATCH',
        entityType: 'Member',
        entityId: resolvedMemberId,
        summary: `Rejected notification with spoofed recipient for member ${resolvedMemberId}`,
      });
      throw new HttpError(
        403,
        'RECIPIENT_MISMATCH',
        'Recipient does not match the authorized gym member record.'
      );
    }
  }

  const templateParams = Array.isArray(body.whatsappTemplateParams)
    ? body.whatsappTemplateParams
        .slice(0, 6)
        .map((p) => String(p).slice(0, 200))
    : undefined;

  await writeSecurityAuditLog(db, serverTimestamp, {
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorRole: userRole,
    gymId,
    action: 'SEND_NOTIFICATION',
    entityType: 'Member',
    entityId: resolvedMemberId,
    summary: `Authorized ${channel} notification dispatch for ${resolvedMemberId}`,
  });

  emitStructuredLog('info', 'notification-guard', 'notification_authorized', {
    gymId,
    actorUid: actor.uid,
    actorRole: userRole,
    channel,
    targetType,
    memberId: resolvedMemberId,
  });

  return {
    gymId,
    gymName,
    memberId: resolvedMemberId,
    targetType,
    channel,
    recipient: trustedRecipient,
    subject: rawSubject.slice(0, 180) || `${gymName} Reminder`,
    message: rawMessage,
    fromName: emailFromName || gymName || 'GymOS',
    whatsappPhoneNumberId:
      channel === 'WHATSAPP_CLOUD' ? whatsappPhoneNumberId : undefined,
    whatsappApprovedTemplate:
      channel === 'WHATSAPP_CLOUD' ? whatsappApprovedTemplate : undefined,
    whatsappTemplateParams: templateParams,
  };
}

export type _UnusedGymTypeCheck = Gym | RenewalPolicy;
