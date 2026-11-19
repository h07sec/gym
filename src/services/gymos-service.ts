import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { handleFirestoreError, OperationType } from '../lib/firestore-error';
import {
  AccountStatus,
  AssignableStaffRole,
  AttendanceRecord,
  DeliveryStatus,
  Gym,
  GymSettings,
  GymStaff,
  Member,
  MemberPayment,
  MemberPaymentPurpose,
  MemberPaymentStatus,
  Membership,
  MembershipActionType,
  MembershipDurationType,
  MembershipPlan,
  MembershipRecordStatus,
  MembershipStatus,
  NotificationLog,
  PaymentMode,
  PaymentReceipt,
  PlatformAdmin,
  PlatformSettings,
  ReminderChannel,
  RenewalPolicy,
  StaffInvitation,
  StaffPermissions,
  SubscriptionPayment,
  SubscriptionPaymentStatus,
  SubscriptionPlan,
  SubscriptionStatus,
  UserRole,
  UserStatus,
} from '../types/gymos';
import {
  addDaysSafe,
  addMonthsSafe,
  calculateMembershipExpiry,
  calculateRenewalDates,
  deriveMemberMembershipStatus,
} from '../lib/domain/dates';
import {
  calculateNetPlanAmount,
  calculateOutstandingAfterPayment,
  isDuplicateUpiReference,
  isPotentialDuplicateCashPayment,
  validatePaymentConfirmationTransition,
} from '../lib/domain/payments';
import { computeNextRetryState, evaluateDueReminders } from '../lib/domain/reminders';
import { computeEffectiveAccessEndIso } from '../lib/domain/subscription';
import { generateHumanCode, generateSecureId, toIsoDate } from '../lib/utils';

export interface ActorContext {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export interface ServerCapabilities {
  emailConfigured: boolean;
  whatsappConfigured: boolean;
  adminFirestoreConfigured: boolean;
  adminBootstrapConfigured: boolean;
  cronConfigured: boolean;
  smtpFrom?: string;
}

export interface GymBackupPayload {
  schemaVersion: 'gymos.backup.v1';
  exportedAt: string;
  gymId: string;
  gymName: string;
  settings: GymSettings | null;
  membershipPlans: MembershipPlan[];
  members: Member[];
  memberships: Membership[];
  memberPayments: MemberPayment[];
  paymentReceipts: PaymentReceipt[];
  attendance: AttendanceRecord[];
  notificationLogs: NotificationLog[];
}

function buildSubscriptionAccessTimestamp(
  endAtIso: string,
  graceDays: number,
  status: SubscriptionStatus
): Timestamp {
  if (status === SubscriptionStatus.PENDING || status === SubscriptionStatus.CANCELLED) {
    return Timestamp.fromDate(new Date('1970-01-01T00:00:00.000Z'));
  }
  const effectiveIso = computeEffectiveAccessEndIso(endAtIso, graceDays);
  if (!effectiveIso) {
    return Timestamp.fromDate(new Date('1970-01-01T00:00:00.000Z'));
  }
  if (status === SubscriptionStatus.EXPIRED) {
    const yesterday = addDaysSafe(toIsoDate(), -1);
    const chosen = effectiveIso < yesterday ? effectiveIso : yesterday;
    return Timestamp.fromDate(new Date(`${chosen}T23:59:59.999Z`));
  }
  return Timestamp.fromDate(new Date(`${effectiveIso}T23:59:59.999Z`));
}

async function appendAuditLog(
  batchOrTx: { set: (ref: ReturnType<typeof doc>, data: unknown) => void },
  actor: ActorContext,
  action: string,
  entityType: string,
  entityId: string,
  summary: string,
  gymId?: string
) {
  const id = generateSecureId('aud');
  const payload: Record<string, unknown> = {
    id,
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorRole: actor.role,
    action,
    entityType,
    entityId,
    summary: summary.slice(0, 300),
    createdAt: serverTimestamp(),
  };
  if (gymId) payload.gymId = gymId;
  batchOrTx.set(doc(db, 'audit_logs', id), payload);
}

// ---------------------------------------------------------------------------
// Server Notification & Capability Calls
// ---------------------------------------------------------------------------
export async function fetchServerNotificationCapabilities(): Promise<ServerCapabilities> {
  try {
    const resp = await fetch('/api/notifications/capabilities');
    if (!resp.ok) {
      return {
        emailConfigured: false,
        whatsappConfigured: false,
        adminFirestoreConfigured: false,
        adminBootstrapConfigured: false,
        cronConfigured: false,
      };
    }
    return (await resp.json()) as ServerCapabilities;
  } catch {
    return {
      emailConfigured: false,
      whatsappConfigured: false,
      adminFirestoreConfigured: false,
      adminBootstrapConfigured: false,
      cronConfigured: false,
    };
  }
}

async function dispatchExternalReminder(payload: {
  channel: ReminderChannel.EMAIL | ReminderChannel.WHATSAPP_CLOUD;
  recipient: string;
  subject: string;
  message: string;
  fromName?: string;
  whatsappPhoneNumberId?: string;
  whatsappApprovedTemplate?: string;
  whatsappTemplateParams?: string[];
}): Promise<{
  delivered: boolean;
  providerMessageId?: string;
  sentAt?: string;
  errorDetails?: string;
}> {
  const user = auth.currentUser;
  if (!user) {
    return {
      delivered: false,
      errorDetails: 'Authenticated user session required for server notification delivery.',
    };
  }
  try {
    const idToken = await user.getIdToken();
    const resp = await fetch('/api/notifications/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(payload),
    });
    const json = (await resp.json().catch(() => ({}))) as {
      delivered?: boolean;
      providerMessageId?: string;
      sentAt?: string;
      errorDetails?: string;
    };
    if (!resp.ok || !json.delivered) {
      return {
        delivered: false,
        errorDetails: json.errorDetails || `Delivery endpoint returned HTTP ${resp.status}`,
      };
    }
    return {
      delivered: true,
      providerMessageId: json.providerMessageId,
      sentAt: json.sentAt || new Date().toISOString(),
    };
  } catch (err) {
    return {
      delivered: false,
      errorDetails: err instanceof Error ? err.message : 'Network error calling notification server',
    };
  }
}

// ---------------------------------------------------------------------------
// Platform Bootstrap, Admin Registry & Settings (Super Admin Only)
// ---------------------------------------------------------------------------
export async function addPlatformAdmin(
  actor: ActorContext,
  input: { uid: string; email: string; displayName: string }
): Promise<void> {
  const uid = input.uid.trim();
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim() || email.split('@')[0] || 'Platform Admin';
  if (!uid || !email) {
    throw new Error('Firebase UID and verified email are required.');
  }
  const path = `platform_admins/${uid}`;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'platform_admins', uid), {
      uid,
      email,
      displayName,
      createdAt: serverTimestamp(),
    });
    const userRef = doc(db, 'users', uid);
    const existingUser = await getDoc(userRef);
    if (existingUser.exists()) {
      batch.update(userRef, {
        displayName,
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(userRef, {
        uid,
        email,
        displayName,
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    await appendAuditLog(
      batch,
      actor,
      'ADD_PLATFORM_ADMIN',
      'PlatformAdmin',
      uid,
      `Authorized platform Super Admin ${email}`
    );
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function revokePlatformAdmin(
  actor: ActorContext,
  target: PlatformAdmin
): Promise<void> {
  if (target.uid === actor.uid) {
    throw new Error('You cannot revoke your own active Super Admin access.');
  }
  const path = `platform_admins/${target.uid}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'platform_admins', target.uid));
    const userRef = doc(db, 'users', target.uid);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
      batch.update(userRef, {
        status: UserStatus.DEACTIVATED,
        updatedAt: serverTimestamp(),
      });
    }
    await appendAuditLog(
      batch,
      actor,
      'REVOKE_PLATFORM_ADMIN',
      'PlatformAdmin',
      target.uid,
      `Revoked platform Super Admin ${target.email}`
    );
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function ensurePlatformDefaults(actor: ActorContext): Promise<void> {
  const settingsRef = doc(db, 'platform_settings', 'default');
  try {
    const snap = await getDoc(settingsRef);
    if (!snap.exists()) {
      await setDoc(settingsRef, {
        supportEmail: actor.email,
        supportPhone: 'Support via email',
        upiId: '',
        upiPayeeName: 'GymOS',
        paymentInstructions:
          'Contact GymOS support for subscription renewal and payment verification instructions.',
        defaultGracePeriodDays: 7,
        allowPublicRegistration: true,
        updatedAt: serverTimestamp(),
      });
    }

    const plansSnap = await getDocs(collection(db, 'subscription_plans'));
    if (plansSnap.empty) {
      const batch = writeBatch(db);
      const defaults: Omit<SubscriptionPlan, 'createdAt' | 'updatedAt'>[] = [
        {
          id: 'plan_monthly_starter',
          name: 'Monthly Standard',
          billingDurationMonths: 1,
          price: 1499,
          currency: '₹',
          maxStaff: 5,
          maxMembers: 500,
          trialDays: 14,
          features: [
            'Member & membership lifecycle',
            'Manual Cash & UPI ledger + receipts',
            'Automated expiry reminders',
            'Daily & monthly reports',
          ],
          isActive: true,
        },
        {
          id: 'plan_quarterly_pro',
          name: 'Quarterly Growth',
          billingDurationMonths: 3,
          price: 3999,
          currency: '₹',
          maxStaff: 12,
          maxMembers: 1500,
          trialDays: 14,
          features: [
            'Up to 12 staff seats with RBAC',
            'CSV bulk import & export',
            'Custom renewal & grace policies',
            'Priority support',
          ],
          isActive: true,
        },
        {
          id: 'plan_half_yearly',
          name: 'Half-Yearly Scale',
          billingDurationMonths: 6,
          price: 7499,
          currency: '₹',
          maxStaff: 25,
          maxMembers: 3500,
          trialDays: 14,
          features: [
            'Up to 25 staff seats',
            'WhatsApp Cloud API ready',
            'Full audit logs & exports',
          ],
          isActive: true,
        },
        {
          id: 'plan_yearly_enterprise',
          name: 'Yearly Studio',
          billingDurationMonths: 12,
          price: 13999,
          currency: '₹',
          maxStaff: 50,
          maxMembers: 10000,
          trialDays: 14,
          features: [
            'Up to 50 staff accounts',
            'Unlimited historical retention',
            'Dedicated onboarding review',
          ],
          isActive: true,
        },
      ];

      for (const plan of defaults) {
        batch.set(doc(db, 'subscription_plans', plan.id), {
          ...plan,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'platform_settings/default');
  }
}

export async function updatePlatformSettings(
  actor: ActorContext,
  data: Omit<PlatformSettings, 'updatedAt'>
): Promise<void> {
  const path = 'platform_settings/default';
  try {
    const batch = writeBatch(db);
    batch.set(
      doc(db, 'platform_settings', 'default'),
      { ...data, updatedAt: serverTimestamp() },
      { merge: true }
    );
    await appendAuditLog(
      batch,
      actor,
      'UPDATE_PLATFORM_SETTINGS',
      'PlatformSettings',
      'default',
      'Updated GymOS platform settings and manual payment instructions'
    );
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function saveSubscriptionPlan(
  actor: ActorContext,
  plan: {
    id?: string;
    name: string;
    billingDurationMonths: number;
    price: number;
    currency: string;
    maxStaff: number;
    maxMembers: number;
    trialDays: number;
    features: string[];
    isActive: boolean;
  }
): Promise<string> {
  const id = plan.id || generateSecureId('splan');
  const path = `subscription_plans/${id}`;
  try {
    const ref = doc(db, 'subscription_plans', id);
    const existing = await getDoc(ref);
    const batch = writeBatch(db);

    if (existing.exists()) {
      batch.update(ref, {
        name: plan.name.trim(),
        billingDurationMonths: plan.billingDurationMonths,
        price: plan.price,
        currency: plan.currency,
        maxStaff: plan.maxStaff,
        maxMembers: plan.maxMembers,
        trialDays: plan.trialDays,
        features: plan.features.slice(0, 12),
        isActive: plan.isActive,
        updatedAt: serverTimestamp(),
      });
      await appendAuditLog(
        batch,
        actor,
        'UPDATE_SUBSCRIPTION_PLAN',
        'SubscriptionPlan',
        id,
        `Updated subscription plan ${plan.name}`
      );
    } else {
      batch.set(ref, {
        id,
        name: plan.name.trim(),
        billingDurationMonths: plan.billingDurationMonths,
        price: plan.price,
        currency: plan.currency,
        maxStaff: plan.maxStaff,
        maxMembers: plan.maxMembers,
        trialDays: plan.trialDays,
        features: plan.features.slice(0, 12),
        isActive: plan.isActive,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await appendAuditLog(
        batch,
        actor,
        'CREATE_SUBSCRIPTION_PLAN',
        'SubscriptionPlan',
        id,
        `Created subscription plan ${plan.name}`
      );
    }
    await batch.commit();
    return id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

// ---------------------------------------------------------------------------
// Gym Onboarding (Public Owner Registration & Super Admin Manual Creation)
// ---------------------------------------------------------------------------
const FULL_OWNER_PERMISSIONS: StaffPermissions = {
  canViewReports: true,
  canViewPayments: true,
  canRecordPayments: true,
  canManagePlans: true,
  canConfirmPayments: true,
  canDeleteMembers: true,
  canManageReminders: true,
  canManageAttendance: true,
};

export async function registerGymAsOwner(input: {
  uid: string;
  email: string;
  ownerName: string;
  gymName: string;
  phone: string;
  address?: string;
  plan: SubscriptionPlan;
  startMode: 'TRIAL' | 'PENDING';
}): Promise<string> {
  const gymId = generateSecureId('gym');
  const today = toIsoDate();
  const subStatus =
    input.startMode === 'TRIAL' ? SubscriptionStatus.TRIAL : SubscriptionStatus.PENDING;
  const endAt =
    input.startMode === 'TRIAL'
      ? addDaysSafe(today, Math.max(1, input.plan.trialDays || 14))
      : today;
  const graceDays = 7;

  try {
    const batch = writeBatch(db);
    const gymRef = doc(db, 'gyms', gymId);
    const userRef = doc(db, 'users', input.uid);
    const staffId = input.uid;
    const staffRef = doc(db, 'gyms', gymId, 'staff', staffId);
    const settingsRef = doc(db, 'gyms', gymId, 'settings', 'default');
    const pNotifId = generateSecureId('pnotif');
    const pNotifRef = doc(db, 'platform_notifications', pNotifId);

    batch.set(gymRef, {
      id: gymId,
      name: input.gymName.trim(),
      ownerUid: input.uid,
      ownerName: input.ownerName.trim(),
      email: input.email.trim().toLowerCase(),
      phone: input.phone.trim(),
      ...(input.address?.trim() ? { address: input.address.trim() } : {}),
      accountStatus: AccountStatus.ACTIVE,
      subscriptionStatus: subStatus,
      subscriptionPlanId: input.plan.id,
      subscriptionPlanName: input.plan.name,
      subscriptionStartAt: today,
      subscriptionEndAt: endAt,
      subscriptionAccessUntil: buildSubscriptionAccessTimestamp(endAt, graceDays, subStatus),
      gracePeriodDays: graceDays,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(userRef, {
      uid: input.uid,
      email: input.email.trim().toLowerCase(),
      displayName: input.ownerName.trim(),
      role: UserRole.GYM_OWNER,
      gymId,
      status: UserStatus.ACTIVE,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(staffRef, {
      id: staffId,
      gymId,
      uid: input.uid,
      email: input.email.trim().toLowerCase(),
      fullName: input.ownerName.trim(),
      phone: input.phone.trim(),
      role: UserRole.GYM_OWNER,
      roleTitle: 'Gym Owner',
      status: UserStatus.ACTIVE,
      permissions: FULL_OWNER_PERMISSIONS,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(settingsRef, {
      gymId,
      gracePeriodDays: graceDays,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
      reminderDaysBefore: [7, 3, 1],
      sendOnExpiryDay: true,
      sendAfterExpiryDays: [3, 7],
      paymentRemindersEnabled: true,
      upcomingPaymentReminderDays: 3,
      overduePaymentReminderDays: [1, 3, 7, 14],
      ownerSubReminderDays: [7, 3, 1, 0, -3],
      emailEnabled: true,
      emailFromName: input.gymName.trim(),
      inAppEnabled: true,
      whatsappEnabled: false,
      currencySymbol: '₹',
      updatedAt: serverTimestamp(),
    });

    batch.set(pNotifRef, {
      id: pNotifId,
      type: 'NEW_GYM_REGISTERED',
      title: `New gym onboarded: ${input.gymName.trim()}`,
      message: `${input.ownerName.trim()} (${input.email}) registered on ${input.plan.name} (${input.startMode}).`,
      gymId,
      isRead: false,
      createdAt: serverTimestamp(),
    });

    await appendAuditLog(
      batch,
      {
        uid: input.uid,
        email: input.email,
        displayName: input.ownerName,
        role: UserRole.GYM_OWNER,
      },
      'GYM_REGISTERED',
      'Gym',
      gymId,
      `Gym ${input.gymName.trim()} registered on plan ${input.plan.name}`,
      gymId
    );

    await batch.commit();
    return gymId;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `gyms/${gymId}`);
  }
}

export async function createGymBySuperAdmin(
  actor: ActorContext,
  input: {
    gymName: string;
    ownerName: string;
    ownerEmail: string;
    phone: string;
    address?: string;
    plan: SubscriptionPlan;
    subscriptionStatus: SubscriptionStatus;
    accountStatus: AccountStatus;
    gracePeriodDays?: number;
  }
): Promise<string> {
  const gymId = generateSecureId('gym');
  const ownerInviteId = generateSecureId('inv');
  const today = toIsoDate();
  const endAt =
    input.subscriptionStatus === SubscriptionStatus.TRIAL
      ? addDaysSafe(today, Math.max(1, input.plan.trialDays || 14))
      : addMonthsSafe(today, input.plan.billingDurationMonths);
  const placeholderOwnerUid = generateSecureId('owner_pending');
  const graceDays = Math.max(0, input.gracePeriodDays ?? 7);
  const cleanEmail = input.ownerEmail.trim().toLowerCase();

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'gyms', gymId), {
      id: gymId,
      name: input.gymName.trim(),
      ownerUid: placeholderOwnerUid,
      ownerName: input.ownerName.trim(),
      email: cleanEmail,
      phone: input.phone.trim(),
      ...(input.address?.trim() ? { address: input.address.trim() } : {}),
      accountStatus: input.accountStatus,
      subscriptionStatus: input.subscriptionStatus,
      subscriptionPlanId: input.plan.id,
      subscriptionPlanName: input.plan.name,
      subscriptionStartAt: today,
      subscriptionEndAt: endAt,
      subscriptionAccessUntil: buildSubscriptionAccessTimestamp(
        endAt,
        graceDays,
        input.subscriptionStatus
      ),
      ownerInvitationId: ownerInviteId,
      gracePeriodDays: graceDays,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(db, 'invitations', ownerInviteId), {
      id: ownerInviteId,
      gymId,
      gymName: input.gymName.trim(),
      email: cleanEmail,
      fullName: input.ownerName.trim(),
      role: UserRole.GYM_OWNER,
      roleTitle: 'Gym Owner',
      permissions: FULL_OWNER_PERMISSIONS,
      status: 'PENDING',
      invitedByUid: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(db, 'gyms', gymId, 'settings', 'default'), {
      gymId,
      gracePeriodDays: graceDays,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
      reminderDaysBefore: [7, 3, 1],
      sendOnExpiryDay: true,
      sendAfterExpiryDays: [3, 7],
      paymentRemindersEnabled: true,
      upcomingPaymentReminderDays: 3,
      overduePaymentReminderDays: [1, 3, 7, 14],
      ownerSubReminderDays: [7, 3, 1, 0, -3],
      emailEnabled: true,
      emailFromName: input.gymName.trim(),
      inAppEnabled: true,
      whatsappEnabled: false,
      currencySymbol: '₹',
      updatedAt: serverTimestamp(),
    });

    await appendAuditLog(
      batch,
      actor,
      'ADMIN_CREATE_GYM',
      'Gym',
      gymId,
      `Super Admin created gym ${input.gymName.trim()} and owner invitation for ${cleanEmail}`,
      gymId
    );
    await batch.commit();
    return gymId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `gyms/${gymId}`);
  }
}

export async function claimOwnerInvitation(
  invitation: StaffInvitation,
  user: { uid: string; email: string; displayName: string }
): Promise<void> {
  const path = `gyms/${invitation.gymId}`;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'invitations', invitation.id), {
      status: 'ACCEPTED',
      acceptedByUid: user.uid,
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, 'gyms', invitation.gymId), {
      ownerUid: user.uid,
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'users', user.uid), {
      uid: user.uid,
      email: user.email.toLowerCase(),
      displayName: user.displayName || invitation.fullName,
      role: UserRole.GYM_OWNER,
      gymId: invitation.gymId,
      invitationId: invitation.id,
      status: UserStatus.ACTIVE,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'gyms', invitation.gymId, 'staff', user.uid), {
      id: user.uid,
      gymId: invitation.gymId,
      uid: user.uid,
      invitationId: invitation.id,
      email: user.email.toLowerCase(),
      fullName: user.displayName || invitation.fullName,
      role: UserRole.GYM_OWNER,
      roleTitle: 'Gym Owner',
      status: UserStatus.ACTIVE,
      permissions: FULL_OWNER_PERMISSIONS,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await appendAuditLog(
      batch,
      {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || invitation.fullName,
        role: UserRole.GYM_OWNER,
      },
      'CLAIM_OWNER_INVITATION',
      'Gym',
      invitation.gymId,
      `${user.email} claimed owner access for ${invitation.gymName}`,
      invitation.gymId
    );
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

// ---------------------------------------------------------------------------
// Super Admin Governance: Freeze/Lock, Reactivation, Plan Changes, Manual Billing
// ---------------------------------------------------------------------------
export async function updateGymAccountState(
  actor: ActorContext,
  gym: Gym,
  updates: {
    accountStatus?: AccountStatus;
    subscriptionStatus?: SubscriptionStatus;
    subscriptionPlanId?: string;
    subscriptionPlanName?: string;
    subscriptionEndAt?: string;
    gracePeriodDays?: number;
    suspensionReason?: string;
  },
  auditSummary: string
): Promise<void> {
  const path = `gyms/${gym.id}`;
  try {
    const batch = writeBatch(db);
    const gymRef = doc(db, 'gyms', gym.id);
    const nextEnd = updates.subscriptionEndAt ?? gym.subscriptionEndAt;
    const nextStatus = updates.subscriptionStatus ?? gym.subscriptionStatus;
    const nextGrace = updates.gracePeriodDays ?? gym.gracePeriodDays;

    const payload: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };
    if (updates.accountStatus !== undefined) payload.accountStatus = updates.accountStatus;
    if (updates.subscriptionStatus !== undefined)
      payload.subscriptionStatus = updates.subscriptionStatus;
    if (updates.subscriptionPlanId !== undefined)
      payload.subscriptionPlanId = updates.subscriptionPlanId;
    if (updates.subscriptionPlanName !== undefined)
      payload.subscriptionPlanName = updates.subscriptionPlanName;
    if (updates.subscriptionEndAt !== undefined)
      payload.subscriptionEndAt = updates.subscriptionEndAt;
    if (updates.gracePeriodDays !== undefined)
      payload.gracePeriodDays = updates.gracePeriodDays;
    if (updates.suspensionReason !== undefined)
      payload.suspensionReason = updates.suspensionReason;

    if (
      updates.subscriptionEndAt !== undefined ||
      updates.subscriptionStatus !== undefined ||
      updates.gracePeriodDays !== undefined
    ) {
      payload.subscriptionAccessUntil = buildSubscriptionAccessTimestamp(
        nextEnd,
        nextGrace,
        nextStatus
      );
    }

    batch.update(gymRef, payload);

    const action =
      updates.accountStatus === AccountStatus.SUSPENDED
        ? 'SUSPEND_GYM'
        : updates.accountStatus === AccountStatus.ACTIVE &&
            gym.accountStatus === AccountStatus.SUSPENDED
          ? 'REACTIVATE_GYM'
          : 'UPDATE_GYM_SUBSCRIPTION';

    await appendAuditLog(batch, actor, action, 'Gym', gym.id, auditSummary, gym.id);
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function recordManualSubscriptionPayment(
  actor: ActorContext,
  input: {
    gym: Gym;
    plan: SubscriptionPlan;
    amount: number;
    paymentMode: PaymentMode;
    transactionReference?: string;
    paymentDate: string;
    periodStart: string;
    periodEnd: string;
    notes?: string;
    verifyImmediately: boolean;
    initialStatus?: SubscriptionPaymentStatus.PENDING | SubscriptionPaymentStatus.RECORDED;
  }
): Promise<string> {
  const paymentId = generateSecureId('spay');
  const idempotencyKey = generateSecureId('idem');
  const path = `subscription_payments/${paymentId}`;

  try {
    if (input.paymentMode === PaymentMode.UPI && input.transactionReference?.trim()) {
      const dupQuery = query(
        collection(db, 'subscription_payments'),
        where('transactionReference', '==', input.transactionReference.trim())
      );
      const dupSnap = await getDocs(dupQuery);
      if (!dupSnap.empty) {
        throw new Error(
          `Duplicate UPI transaction reference detected: ${input.transactionReference.trim()}`
        );
      }
    }

    await runTransaction(db, async (tx) => {
      const gymRef = doc(db, 'gyms', input.gym.id);
      const gymSnap = await tx.get(gymRef);
      if (!gymSnap.exists()) {
        throw new Error('Target gym does not exist.');
      }
      const currentGym = gymSnap.data() as Gym;
      const payRef = doc(db, 'subscription_payments', paymentId);

      const status = input.verifyImmediately
        ? SubscriptionPaymentStatus.VERIFIED
        : input.initialStatus || SubscriptionPaymentStatus.RECORDED;

      tx.set(payRef, {
        id: paymentId,
        gymId: currentGym.id,
        gymName: currentGym.name,
        ownerUid: currentGym.ownerUid,
        planId: input.plan.id,
        planName: input.plan.name,
        amount: input.amount,
        paymentMode: input.paymentMode,
        ...(input.transactionReference?.trim()
          ? { transactionReference: input.transactionReference.trim() }
          : {}),
        idempotencyKey,
        paymentDate: input.paymentDate,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status,
        ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
        recordedByUid: actor.uid,
        ...(input.verifyImmediately ? { verifiedByUid: actor.uid } : {}),
        extensionApplied: input.verifyImmediately,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (input.verifyImmediately) {
        tx.update(gymRef, {
          accountStatus: AccountStatus.ACTIVE,
          subscriptionStatus: SubscriptionStatus.ACTIVE,
          subscriptionPlanId: input.plan.id,
          subscriptionPlanName: input.plan.name,
          subscriptionStartAt: input.periodStart,
          subscriptionEndAt: input.periodEnd,
          subscriptionAccessUntil: buildSubscriptionAccessTimestamp(
            input.periodEnd,
            currentGym.gracePeriodDays ?? 7,
            SubscriptionStatus.ACTIVE
          ),
          suspensionReason: '',
          updatedAt: serverTimestamp(),
        });
      }

      await appendAuditLog(
        tx,
        actor,
        input.verifyImmediately
          ? 'VERIFY_SUBSCRIPTION_PAYMENT_AND_EXTEND'
          : 'RECORD_SUBSCRIPTION_PAYMENT',
        'SubscriptionPayment',
        paymentId,
        `${input.verifyImmediately ? 'Verified & extended' : `Recorded (${status})`} ${input.paymentMode} payment of ${input.amount} for ${currentGym.name} (${input.periodStart} to ${input.periodEnd})`,
        currentGym.id
      );
    });

    return paymentId;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Duplicate UPI')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function verifyExistingSubscriptionPayment(
  actor: ActorContext,
  paymentId: string
): Promise<void> {
  const path = `subscription_payments/${paymentId}`;
  try {
    await runTransaction(db, async (tx) => {
      const payRef = doc(db, 'subscription_payments', paymentId);
      const paySnap = await tx.get(payRef);
      if (!paySnap.exists()) throw new Error('Subscription payment record not found.');
      const payment = paySnap.data() as SubscriptionPayment;

      if (
        (payment.status !== SubscriptionPaymentStatus.RECORDED &&
          payment.status !== SubscriptionPaymentStatus.PENDING) ||
        payment.extensionApplied
      ) {
        throw new Error(
          'This payment has already been processed. Double extension is prevented.'
        );
      }

      const gymRef = doc(db, 'gyms', payment.gymId);
      const gymSnap = await tx.get(gymRef);
      if (!gymSnap.exists()) throw new Error('Associated gym not found.');
      const currentGym = gymSnap.data() as Gym;

      tx.update(payRef, {
        status: SubscriptionPaymentStatus.VERIFIED,
        verifiedByUid: actor.uid,
        extensionApplied: true,
        updatedAt: serverTimestamp(),
      });

      tx.update(gymRef, {
        accountStatus: AccountStatus.ACTIVE,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        subscriptionPlanId: payment.planId,
        subscriptionPlanName: payment.planName,
        subscriptionStartAt: payment.periodStart,
        subscriptionEndAt: payment.periodEnd,
        subscriptionAccessUntil: buildSubscriptionAccessTimestamp(
          payment.periodEnd,
          currentGym.gracePeriodDays ?? 7,
          SubscriptionStatus.ACTIVE
        ),
        suspensionReason: '',
        updatedAt: serverTimestamp(),
      });

      await appendAuditLog(
        tx,
        actor,
        'VERIFY_SUBSCRIPTION_PAYMENT',
        'SubscriptionPayment',
        paymentId,
        `Verified payment ${paymentId} and extended ${payment.gymName} through ${payment.periodEnd}`,
        payment.gymId
      );
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Double extension is prevented')
    ) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function rejectSubscriptionPayment(
  actor: ActorContext,
  payment: SubscriptionPayment,
  reason: string
): Promise<void> {
  const path = `subscription_payments/${payment.id}`;
  try {
    await runTransaction(db, async (tx) => {
      const payRef = doc(db, 'subscription_payments', payment.id);
      const paySnap = await tx.get(payRef);
      if (!paySnap.exists()) throw new Error('Subscription payment not found.');
      const current = paySnap.data() as SubscriptionPayment;
      if (
        current.status !== SubscriptionPaymentStatus.PENDING &&
        current.status !== SubscriptionPaymentStatus.RECORDED
      ) {
        throw new Error('Only pending or recorded subscription payments can be rejected.');
      }
      tx.update(payRef, {
        status: SubscriptionPaymentStatus.REJECTED,
        verifiedByUid: actor.uid,
        notes: `${current.notes ? `${current.notes} | ` : ''}REJECTED: ${reason}`.slice(0, 500),
        updatedAt: serverTimestamp(),
      });
      await appendAuditLog(
        tx,
        actor,
        'REJECT_SUBSCRIPTION_PAYMENT',
        'SubscriptionPayment',
        payment.id,
        `Rejected subscription payment ${payment.id} for ${payment.gymName}: ${reason}`,
        payment.gymId
      );
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// ---------------------------------------------------------------------------
// Staff Invitations & Management
// ---------------------------------------------------------------------------
export async function createStaffInvitation(
  actor: ActorContext,
  gym: Gym,
  input: {
    email: string;
    fullName: string;
    role: AssignableStaffRole;
    roleTitle?: string;
    permissions: StaffPermissions;
  }
): Promise<string> {
  const invitationId = generateSecureId('inv');
  const path = `invitations/${invitationId}`;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'invitations', invitationId), {
      id: invitationId,
      gymId: gym.id,
      gymName: gym.name,
      email: input.email.trim().toLowerCase(),
      fullName: input.fullName.trim(),
      role: input.role,
      ...(input.roleTitle?.trim() ? { roleTitle: input.roleTitle.trim().slice(0, 64) } : {}),
      permissions: input.permissions,
      status: 'PENDING',
      invitedByUid: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await appendAuditLog(
      batch,
      actor,
      'INVITE_STAFF',
      'StaffInvitation',
      invitationId,
      `Invited ${input.email.trim().toLowerCase()} as ${input.role}`,
      gym.id
    );
    await batch.commit();
    return invitationId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function acceptStaffInvitation(
  invitation: StaffInvitation,
  user: { uid: string; email: string; displayName: string }
): Promise<void> {
  if (invitation.role === UserRole.GYM_OWNER) {
    return claimOwnerInvitation(invitation, user);
  }
  const path = `invitations/${invitation.id}`;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'invitations', invitation.id), {
      status: 'ACCEPTED',
      acceptedByUid: user.uid,
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(db, 'users', user.uid), {
      uid: user.uid,
      email: user.email.toLowerCase(),
      displayName: user.displayName || invitation.fullName,
      role: invitation.role,
      gymId: invitation.gymId,
      invitationId: invitation.id,
      status: UserStatus.ACTIVE,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(db, 'gyms', invitation.gymId, 'staff', user.uid), {
      id: user.uid,
      gymId: invitation.gymId,
      uid: user.uid,
      invitationId: invitation.id,
      email: user.email.toLowerCase(),
      fullName: user.displayName || invitation.fullName,
      role: invitation.role,
      ...(invitation.roleTitle ? { roleTitle: invitation.roleTitle } : {}),
      status: UserStatus.ACTIVE,
      permissions: invitation.permissions,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await appendAuditLog(
      batch,
      {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || invitation.fullName,
        role: invitation.role,
      },
      'ACCEPT_STAFF_INVITATION',
      'GymStaff',
      user.uid,
      `${user.email} accepted ${invitation.role} invitation for ${invitation.gymName}`,
      invitation.gymId
    );

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateGymStaffMember(
  actor: ActorContext,
  gymId: string,
  staff: GymStaff,
  updates: {
    role?: AssignableStaffRole;
    roleTitle?: string;
    status?: UserStatus;
    permissions?: StaffPermissions;
  }
): Promise<void> {
  const path = `gyms/${gymId}/staff/${staff.id}`;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'gyms', gymId, 'staff', staff.id), {
      ...(updates.role ? { role: updates.role } : {}),
      ...(updates.roleTitle !== undefined ? { roleTitle: updates.roleTitle.trim().slice(0, 64) } : {}),
      ...(updates.status ? { status: updates.status } : {}),
      ...(updates.permissions ? { permissions: updates.permissions } : {}),
      updatedAt: serverTimestamp(),
    });
    if (staff.uid) {
      batch.update(doc(db, 'users', staff.uid), {
        ...(updates.role ? { role: updates.role } : {}),
        ...(updates.status ? { status: updates.status } : {}),
        updatedAt: serverTimestamp(),
      });
    }
    await appendAuditLog(
      batch,
      actor,
      'UPDATE_STAFF',
      'GymStaff',
      staff.id,
      `Updated staff ${staff.fullName} (${updates.status ?? staff.status}, ${updates.role ?? staff.role})`,
      gymId
    );
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function revokeStaffInvitation(
  actor: ActorContext,
  invitation: StaffInvitation
): Promise<void> {
  const path = `invitations/${invitation.id}`;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'invitations', invitation.id), {
      status: 'REVOKED',
      updatedAt: serverTimestamp(),
    });
    await appendAuditLog(
      batch,
      actor,
      'REVOKE_STAFF_INVITATION',
      'StaffInvitation',
      invitation.id,
      `Revoked invitation for ${invitation.email}`,
      invitation.gymId
    );
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// ---------------------------------------------------------------------------
// Membership Plans CRUD
// ---------------------------------------------------------------------------
export async function saveMembershipPlan(
  actor: ActorContext,
  gymId: string,
  plan: {
    id?: string;
    name: string;
    durationType: MembershipDurationType;
    durationValue: number;
    price: number;
    description?: string;
    benefits: string[];
    status: 'ACTIVE' | 'INACTIVE';
  }
): Promise<string> {
  const id = plan.id || generateSecureId('mplan');
  const path = `gyms/${gymId}/membership_plans/${id}`;
  try {
    const ref = doc(db, 'gyms', gymId, 'membership_plans', id);
    const snap = await getDoc(ref);
    const batch = writeBatch(db);

    if (snap.exists()) {
      batch.update(ref, {
        name: plan.name.trim(),
        durationType: plan.durationType,
        durationValue: plan.durationValue,
        price: plan.price,
        description: plan.description?.trim() ?? '',
        benefits: plan.benefits.slice(0, 12),
        status: plan.status,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(ref, {
        id,
        gymId,
        name: plan.name.trim(),
        durationType: plan.durationType,
        durationValue: plan.durationValue,
        price: plan.price,
        ...(plan.description?.trim() ? { description: plan.description.trim() } : {}),
        benefits: plan.benefits.slice(0, 12),
        status: plan.status,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    await appendAuditLog(
      batch,
      actor,
      snap.exists() ? 'UPDATE_MEMBERSHIP_PLAN' : 'CREATE_MEMBERSHIP_PLAN',
      'MembershipPlan',
      id,
      `${snap.exists() ? 'Updated' : 'Created'} membership plan ${plan.name}`,
      gymId
    );
    await batch.commit();
    return id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteMembershipPlan(
  actor: ActorContext,
  gymId: string,
  plan: MembershipPlan
): Promise<void> {
  const path = `gyms/${gymId}/membership_plans/${plan.id}`;
  try {
    // Prevent deleting a plan actively assigned to members or referenced by memberships
    const inUseMembers = await getDocs(
      query(
        collection(db, 'gyms', gymId, 'members'),
        where('currentPlanId', '==', plan.id),
        limit(1)
      )
    );
    if (!inUseMembers.empty) {
      throw new Error(
        `Plan "${plan.name}" is currently assigned to one or more members. Mark it INACTIVE instead of deleting.`
      );
    }

    const inUseHistory = await getDocs(
      query(
        collection(db, 'gyms', gymId, 'memberships'),
        where('planId', '==', plan.id),
        limit(1)
      )
    );
    if (!inUseHistory.empty) {
      throw new Error(
        `Plan "${plan.name}" has existing membership history. Mark it INACTIVE to preserve historical records.`
      );
    }

    const batch = writeBatch(db);
    batch.delete(doc(db, 'gyms', gymId, 'membership_plans', plan.id));
    await appendAuditLog(
      batch,
      actor,
      'DELETE_MEMBERSHIP_PLAN',
      'MembershipPlan',
      plan.id,
      `Deleted membership plan ${plan.name}`,
      gymId
    );
    await batch.commit();
  } catch (error) {
    if (error instanceof Error && error.message.includes('INACTIVE')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// ---------------------------------------------------------------------------
// Member Registration, Update, CSV Import, Archive, Attendance
// ---------------------------------------------------------------------------
export async function createGymMember(
  actor: ActorContext,
  gym: Gym,
  input: {
    fullName: string;
    phone: string;
    email?: string;
    gender?: string;
    dateOfBirth?: string;
    address?: string;
    joiningDate: string;
    emergencyContact?: string;
    notes?: string;
    reminderOptOut?: boolean;
    initialPlan?: MembershipPlan;
    startDate?: string;
    discountAmount?: number;
    discountReason?: string;
    dueDate?: string;
    paymentAmount?: number;
    paymentMode?: PaymentMode;
    transactionReference?: string;
    confirmPaymentNow?: boolean;
  }
): Promise<string> {
  const memberId = generateSecureId('mem');
  const memberCode = generateHumanCode('GYM');
  const path = `gyms/${gym.id}/members/${memberId}`;

  try {
    const batch = writeBatch(db);
    const today = toIsoDate();
    let membershipStartDate: string | undefined;
    let membershipExpiryDate: string | undefined;
    let membershipStatus = MembershipStatus.NONE;
    let outstandingBalance = 0;

    if (input.initialPlan) {
      const start = input.startDate || input.joiningDate || today;
      const expiry = calculateMembershipExpiry(
        start,
        input.initialPlan.durationType,
        input.initialPlan.durationValue
      );
      membershipStartDate = start;
      membershipExpiryDate = expiry;
      membershipStatus = deriveMemberMembershipStatus(expiry, today);

      const { discount, netPrice } = calculateNetPlanAmount(
        input.initialPlan.price,
        input.discountAmount
      );
      const paidConfirmed =
        input.paymentAmount && input.paymentAmount > 0 && input.confirmPaymentNow
          ? input.paymentAmount
          : 0;
      outstandingBalance = Math.max(0, Number((netPrice - paidConfirmed).toFixed(2)));

      const membershipId = generateSecureId('ms');
      batch.set(doc(db, 'gyms', gym.id, 'memberships', membershipId), {
        id: membershipId,
        gymId: gym.id,
        memberId,
        memberName: input.fullName.trim(),
        planId: input.initialPlan.id,
        planName: input.initialPlan.name,
        actionType: MembershipActionType.INITIAL,
        startDate: start,
        expiryDate: expiry,
        planPrice: input.initialPlan.price,
        ...(discount > 0 ? { discountAmount: discount } : {}),
        ...(discount > 0 && input.discountReason?.trim()
          ? { discountReason: input.discountReason.trim().slice(0, 200) }
          : {}),
        amountPaid: paidConfirmed,
        balanceDue: outstandingBalance,
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        status: MembershipRecordStatus.ACTIVE,
        recordedByUid: actor.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (input.paymentAmount && input.paymentAmount > 0) {
        const paymentId = generateSecureId('pay');
        const paymentCode = generateHumanCode('PAY');
        const receiptNum = input.confirmPaymentNow ? generateHumanCode('RCP') : undefined;
        batch.set(doc(db, 'gyms', gym.id, 'member_payments', paymentId), {
          id: paymentId,
          paymentCode,
          gymId: gym.id,
          memberId,
          memberName: input.fullName.trim(),
          membershipId,
          amount: input.paymentAmount,
          ...(discount > 0 ? { discountAmount: discount } : {}),
          ...(discount > 0 && input.discountReason?.trim()
            ? { discountReason: input.discountReason.trim().slice(0, 200) }
            : {}),
          paymentMode: input.paymentMode || PaymentMode.CASH,
          paymentPurpose: MemberPaymentPurpose.MEMBERSHIP,
          ...(input.transactionReference?.trim()
            ? { transactionReference: input.transactionReference.trim() }
            : {}),
          paymentDate: today,
          ...(input.dueDate ? { dueDate: input.dueDate } : {}),
          status: input.confirmPaymentNow
            ? MemberPaymentStatus.CONFIRMED
            : MemberPaymentStatus.PENDING,
          recordedByUid: actor.uid,
          recordedByName: actor.displayName,
          ...(input.confirmPaymentNow ? { confirmedByUid: actor.uid } : {}),
          ...(receiptNum ? { receiptNumber: receiptNum } : {}),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        if (input.confirmPaymentNow && receiptNum) {
          const receiptId = generateSecureId('rcp');
          batch.set(doc(db, 'gyms', gym.id, 'payment_receipts', receiptId), {
            id: receiptId,
            receiptNumber: receiptNum,
            gymId: gym.id,
            gymName: gym.name,
            paymentId,
            memberId,
            memberName: input.fullName.trim(),
            memberCode,
            amount: input.paymentAmount,
            paymentMode: input.paymentMode || PaymentMode.CASH,
            ...(input.transactionReference?.trim()
              ? { transactionReference: input.transactionReference.trim() }
              : {}),
            issuedAt: serverTimestamp(),
            issuedByUid: actor.uid,
          });
        }
      }
    }

    batch.set(doc(db, 'gyms', gym.id, 'members', memberId), {
      id: memberId,
      gymId: gym.id,
      memberCode,
      fullName: input.fullName.trim(),
      phone: input.phone.trim(),
      ...(input.email?.trim() ? { email: input.email.trim().toLowerCase() } : {}),
      ...(input.gender?.trim() ? { gender: input.gender.trim() } : {}),
      ...(input.dateOfBirth?.trim() ? { dateOfBirth: input.dateOfBirth.trim() } : {}),
      ...(input.address?.trim() ? { address: input.address.trim() } : {}),
      joiningDate: input.joiningDate || today,
      ...(input.emergencyContact?.trim()
        ? { emergencyContact: input.emergencyContact.trim() }
        : {}),
      ...(input.initialPlan
        ? {
            currentPlanId: input.initialPlan.id,
            currentPlanName: input.initialPlan.name,
            membershipStartDate,
            membershipExpiryDate,
          }
        : {}),
      membershipStatus,
      outstandingBalance,
      reminderOptOut: Boolean(input.reminderOptOut),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      isArchived: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const notifId = generateSecureId('gnotif');
    batch.set(doc(db, 'gyms', gym.id, 'notifications', notifId), {
      id: notifId,
      gymId: gym.id,
      type: 'MEMBER_REGISTERED',
      title: 'New member registered',
      message: `${input.fullName.trim()} (${memberCode}) joined ${input.initialPlan ? `on ${input.initialPlan.name}` : 'without a plan'}.`,
      isRead: false,
      createdAt: serverTimestamp(),
    });

    await appendAuditLog(
      batch,
      actor,
      'REGISTER_MEMBER',
      'Member',
      memberId,
      `Registered member ${input.fullName.trim()} (${memberCode})`,
      gym.id
    );

    await batch.commit();
    return memberId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateGymMember(
  actor: ActorContext,
  gymId: string,
  memberId: string,
  updates: Partial<
    Pick<
      Member,
      | 'fullName'
      | 'phone'
      | 'email'
      | 'gender'
      | 'dateOfBirth'
      | 'address'
      | 'emergencyContact'
      | 'reminderOptOut'
      | 'notes'
      | 'isArchived'
    >
  >
): Promise<void> {
  const path = `gyms/${gymId}/members/${memberId}`;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'gyms', gymId, 'members', memberId), {
      ...updates,
      updatedAt: serverTimestamp(),
    });
    await appendAuditLog(
      batch,
      actor,
      updates.isArchived !== undefined
        ? updates.isArchived
          ? 'ARCHIVE_MEMBER'
          : 'RESTORE_MEMBER'
        : 'UPDATE_MEMBER',
      'Member',
      memberId,
      `Updated member ${memberId}`,
      gymId
    );
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteGymMemberPermanently(
  actor: ActorContext,
  gymId: string,
  member: Member
): Promise<void> {
  const path = `gyms/${gymId}/members/${member.id}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'gyms', gymId, 'members', member.id));
    await appendAuditLog(
      batch,
      actor,
      'DELETE_MEMBER',
      'Member',
      member.id,
      `Deleted member ${member.fullName} (${member.memberCode})`,
      gymId
    );
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function bulkImportGymMembers(
  actor: ActorContext,
  gymId: string,
  rows: {
    fullName: string;
    phone: string;
    email?: string;
    gender?: string;
    joiningDate: string;
    notes?: string;
  }[]
): Promise<number> {
  if (rows.length === 0) return 0;
  try {
    const batch = writeBatch(db);
    for (const row of rows) {
      const memberId = generateSecureId('mem');
      const memberCode = generateHumanCode('GYM');
      batch.set(doc(db, 'gyms', gymId, 'members', memberId), {
        id: memberId,
        gymId,
        memberCode,
        fullName: row.fullName,
        phone: row.phone,
        ...(row.email ? { email: row.email.toLowerCase() } : {}),
        ...(row.gender ? { gender: row.gender } : {}),
        joiningDate: row.joiningDate,
        membershipStatus: MembershipStatus.NONE,
        outstandingBalance: 0,
        reminderOptOut: false,
        ...(row.notes ? { notes: row.notes } : {}),
        isArchived: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    await appendAuditLog(
      batch,
      actor,
      'BULK_IMPORT_MEMBERS',
      'Member',
      gymId,
      `Imported ${rows.length} members via CSV`,
      gymId
    );
    await batch.commit();
    return rows.length;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `gyms/${gymId}/members`);
  }
}

// ---------------------------------------------------------------------------
// Attendance Check-In & Check-Out
// ---------------------------------------------------------------------------
export async function recordAttendanceCheckIn(
  actor: ActorContext,
  gymId: string,
  member: Member,
  notes?: string
): Promise<string> {
  const attendanceId = generateSecureId('att');
  const now = new Date();
  const checkInDate = toIsoDate(now);
  const checkInTime = now.toISOString();
  const path = `gyms/${gymId}/attendance/${attendanceId}`;

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'gyms', gymId, 'attendance', attendanceId), {
      id: attendanceId,
      gymId,
      memberId: member.id,
      memberCode: member.memberCode,
      memberName: member.fullName,
      checkInDate,
      checkInTime,
      recordedByUid: actor.uid,
      recordedByName: actor.displayName,
      ...(notes?.trim() ? { notes: notes.trim().slice(0, 300) } : {}),
      createdAt: serverTimestamp(),
    });
    await appendAuditLog(
      batch,
      actor,
      'ATTENDANCE_CHECK_IN',
      'AttendanceRecord',
      attendanceId,
      `Checked in ${member.fullName} (${member.memberCode})`,
      gymId
    );
    await batch.commit();
    return attendanceId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function recordAttendanceCheckOut(
  gymId: string,
  attendanceId: string
): Promise<void> {
  const path = `gyms/${gymId}/attendance/${attendanceId}`;
  try {
    await updateDoc(doc(db, 'gyms', gymId, 'attendance', attendanceId), {
      checkOutTime: new Date().toISOString(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// ---------------------------------------------------------------------------
// Membership Renewal / Upgrade / Downgrade / Manual Extension / Cancellation
// ---------------------------------------------------------------------------
export async function assignOrRenewMembership(
  actor: ActorContext,
  gym: Gym,
  member: Member,
  plan: MembershipPlan,
  actionType: MembershipActionType,
  settings: GymSettings,
  options: {
    customExpiryDate?: string;
    discountAmount?: number;
    discountReason?: string;
    dueDate?: string;
    amountPaidNow?: number;
    paymentMode?: PaymentMode;
    transactionReference?: string;
    confirmPaymentNow?: boolean;
    notes?: string;
  }
): Promise<void> {
  const today = toIsoDate();
  const path = `gyms/${gym.id}/members/${member.id}`;

  try {
    await runTransaction(db, async (tx) => {
      const memRef = doc(db, 'gyms', gym.id, 'members', member.id);
      const memSnap = await tx.get(memRef);
      if (!memSnap.exists()) throw new Error('Member not found.');
      const currentMem = memSnap.data() as Member;

      let startDate = today;
      let expiryDate = '';

      if (actionType === MembershipActionType.MANUAL_EXTENSION && options.customExpiryDate) {
        startDate = currentMem.membershipStartDate || today;
        expiryDate = options.customExpiryDate;
      } else if (
        actionType === MembershipActionType.RENEWAL ||
        actionType === MembershipActionType.UPGRADE ||
        actionType === MembershipActionType.DOWNGRADE
      ) {
        const calc = calculateRenewalDates({
          currentExpiryDate: currentMem.membershipExpiryDate,
          todayIso: today,
          durationType: plan.durationType,
          durationValue: plan.durationValue,
          renewalPolicy: settings.renewalPolicy,
          gracePeriodDays: settings.gracePeriodDays,
        });
        startDate = calc.startDate;
        expiryDate = calc.expiryDate;
      } else {
        expiryDate = calculateMembershipExpiry(
          today,
          plan.durationType,
          plan.durationValue
        );
      }

      const grossPrice =
        actionType === MembershipActionType.MANUAL_EXTENSION ? 0 : plan.price;
      const { discount, netPrice } = calculateNetPlanAmount(grossPrice, options.discountAmount);
      const paidNow =
        options.amountPaidNow && options.amountPaidNow > 0 && options.confirmPaymentNow
          ? options.amountPaidNow
          : 0;
      const addedBalance = Math.max(0, Number((netPrice - paidNow).toFixed(2)));
      const newOutstanding = Number(
        ((currentMem.outstandingBalance || 0) + addedBalance).toFixed(2)
      );

      const membershipId = generateSecureId('ms');
      tx.set(doc(db, 'gyms', gym.id, 'memberships', membershipId), {
        id: membershipId,
        gymId: gym.id,
        memberId: currentMem.id,
        memberName: currentMem.fullName,
        planId: plan.id,
        planName: plan.name,
        actionType,
        startDate,
        expiryDate,
        planPrice: grossPrice,
        ...(discount > 0 ? { discountAmount: discount } : {}),
        ...(discount > 0 && options.discountReason?.trim()
          ? { discountReason: options.discountReason.trim().slice(0, 200) }
          : {}),
        amountPaid: paidNow,
        balanceDue: addedBalance,
        ...(options.dueDate ? { dueDate: options.dueDate } : {}),
        status: MembershipRecordStatus.ACTIVE,
        recordedByUid: actor.uid,
        ...(options.notes?.trim() ? { notes: options.notes.trim() } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      tx.update(memRef, {
        currentPlanId: plan.id,
        currentPlanName: plan.name,
        membershipStartDate: startDate,
        membershipExpiryDate: expiryDate,
        membershipStatus: deriveMemberMembershipStatus(expiryDate, today),
        outstandingBalance: newOutstanding,
        updatedAt: serverTimestamp(),
      });

      if (options.amountPaidNow && options.amountPaidNow > 0) {
        const paymentId = generateSecureId('pay');
        const paymentCode = generateHumanCode('PAY');
        const receiptNumber = options.confirmPaymentNow ? generateHumanCode('RCP') : undefined;
        tx.set(doc(db, 'gyms', gym.id, 'member_payments', paymentId), {
          id: paymentId,
          paymentCode,
          gymId: gym.id,
          memberId: currentMem.id,
          memberName: currentMem.fullName,
          membershipId,
          amount: options.amountPaidNow,
          ...(discount > 0 ? { discountAmount: discount } : {}),
          ...(discount > 0 && options.discountReason?.trim()
            ? { discountReason: options.discountReason.trim().slice(0, 200) }
            : {}),
          paymentMode: options.paymentMode || PaymentMode.CASH,
          paymentPurpose:
            actionType === MembershipActionType.RENEWAL
              ? MemberPaymentPurpose.RENEWAL
              : MemberPaymentPurpose.MEMBERSHIP,
          ...(options.transactionReference?.trim()
            ? { transactionReference: options.transactionReference.trim() }
            : {}),
          paymentDate: today,
          ...(options.dueDate ? { dueDate: options.dueDate } : {}),
          status: options.confirmPaymentNow
            ? MemberPaymentStatus.CONFIRMED
            : MemberPaymentStatus.PENDING,
          recordedByUid: actor.uid,
          recordedByName: actor.displayName,
          ...(options.confirmPaymentNow ? { confirmedByUid: actor.uid } : {}),
          ...(receiptNumber ? { receiptNumber } : {}),
          ...(options.notes?.trim() ? { notes: options.notes.trim() } : {}),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        if (options.confirmPaymentNow && receiptNumber) {
          const receiptId = generateSecureId('rcp');
          tx.set(doc(db, 'gyms', gym.id, 'payment_receipts', receiptId), {
            id: receiptId,
            receiptNumber,
            gymId: gym.id,
            gymName: gym.name,
            paymentId,
            memberId: currentMem.id,
            memberName: currentMem.fullName,
            memberCode: currentMem.memberCode,
            amount: options.amountPaidNow,
            paymentMode: options.paymentMode || PaymentMode.CASH,
            ...(options.transactionReference?.trim()
              ? { transactionReference: options.transactionReference.trim() }
              : {}),
            issuedAt: serverTimestamp(),
            issuedByUid: actor.uid,
          });
        }
      }

      const notifId = generateSecureId('gnotif');
      tx.set(doc(db, 'gyms', gym.id, 'notifications', notifId), {
        id: notifId,
        gymId: gym.id,
        type: 'MEMBERSHIP_UPDATED',
        title: `Membership ${actionType.toLowerCase().replace('_', ' ')}`,
        message: `${currentMem.fullName} updated to ${plan.name} (valid through ${expiryDate}).`,
        isRead: false,
        createdAt: serverTimestamp(),
      });

      await appendAuditLog(
        tx,
        actor,
        `MEMBERSHIP_${actionType}`,
        'Membership',
        membershipId,
        `${actionType} for ${currentMem.fullName}: ${plan.name} (${startDate} to ${expiryDate})`,
        gym.id
      );
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function cancelMemberMembership(
  actor: ActorContext,
  gymId: string,
  member: Member,
  activeMembership: Membership | undefined,
  reason: string
): Promise<void> {
  const path = `gyms/${gymId}/members/${member.id}`;
  const today = toIsoDate();
  try {
    await runTransaction(db, async (tx) => {
      const memRef = doc(db, 'gyms', gymId, 'members', member.id);
      const memSnap = await tx.get(memRef);
      if (!memSnap.exists()) throw new Error('Member not found.');

      if (activeMembership) {
        const msRef = doc(db, 'gyms', gymId, 'memberships', activeMembership.id);
        const msSnap = await tx.get(msRef);
        if (msSnap.exists()) {
          tx.update(msRef, {
            status: MembershipRecordStatus.CANCELLED,
            cancelledAt: today,
            cancellationReason: reason.trim().slice(0, 300),
            updatedAt: serverTimestamp(),
          });
        }
      }

      tx.update(memRef, {
        membershipStatus: MembershipStatus.CANCELLED,
        membershipExpiryDate: '',
        updatedAt: serverTimestamp(),
      });

      const notifId = generateSecureId('gnotif');
      tx.set(doc(db, 'gyms', gymId, 'notifications', notifId), {
        id: notifId,
        gymId,
        type: 'MEMBERSHIP_CANCELLED',
        title: 'Membership cancelled',
        message: `${member.fullName}'s membership was cancelled (${reason.trim()}).`,
        isRead: false,
        createdAt: serverTimestamp(),
      });

      await appendAuditLog(
        tx,
        actor,
        'CANCEL_MEMBERSHIP',
        'Member',
        member.id,
        `Cancelled membership for ${member.fullName} (${member.memberCode}): ${reason}`,
        gymId
      );
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// ---------------------------------------------------------------------------
// Member Manual Cash & UPI Payments (Idempotent Confirmation + Receipts)
// ---------------------------------------------------------------------------
export async function recordMemberPayment(
  actor: ActorContext,
  gym: Gym,
  member: Member,
  existingPayments: MemberPayment[],
  input: {
    amount: number;
    membershipId?: string;
    discountAmount?: number;
    discountReason?: string;
    dueDate?: string;
    paymentMode: PaymentMode;
    paymentPurpose: MemberPaymentPurpose;
    transactionReference?: string;
    attachmentName?: string;
    paymentDate: string;
    notes?: string;
    confirmImmediately: boolean;
    allowDuplicateCash?: boolean;
  }
): Promise<string> {
  if (input.amount <= 0) {
    throw new Error('Payment amount must be greater than zero.');
  }
  if (
    input.paymentMode === PaymentMode.UPI &&
    input.transactionReference &&
    isDuplicateUpiReference(existingPayments, input.transactionReference)
  ) {
    throw new Error(
      `Duplicate UPI transaction reference (${input.transactionReference}) already exists for this gym.`
    );
  }
  if (
    !input.allowDuplicateCash &&
    input.paymentMode === PaymentMode.CASH &&
    isPotentialDuplicateCashPayment(existingPayments, member.id, input.amount, input.paymentDate)
  ) {
    throw new Error(
      `Duplicate payment warning: a ${input.amount} CASH entry already exists for ${member.fullName} on ${input.paymentDate}. Enable "Allow same-day duplicate cash entry" if intentional.`
    );
  }
  if (
    input.confirmImmediately &&
    input.paymentMode === PaymentMode.UPI &&
    !input.transactionReference?.trim()
  ) {
    throw new Error(
      'Enter the verified UPI transaction reference before confirming a UPI payment.'
    );
  }

  let linkedMembershipId = input.membershipId;
  if (!linkedMembershipId && input.paymentPurpose === MemberPaymentPurpose.BALANCE_SETTLEMENT) {
    const msSnap = await getDocs(
      query(
        collection(db, 'gyms', gym.id, 'memberships'),
        where('memberId', '==', member.id)
      )
    );
    const dueMs = msSnap.docs
      .map((d) => d.data() as Membership)
      .find((ms) => ms.status === MembershipRecordStatus.ACTIVE && ms.balanceDue > 0);
    if (dueMs) linkedMembershipId = dueMs.id;
  }

  const paymentId = generateSecureId('pay');
  const paymentCode = generateHumanCode('PAY');
  const path = `gyms/${gym.id}/member_payments/${paymentId}`;

  try {
    await runTransaction(db, async (tx) => {
      const memRef = doc(db, 'gyms', gym.id, 'members', member.id);
      const memSnap = await tx.get(memRef);
      if (!memSnap.exists()) throw new Error('Member not found.');
      const currentMem = memSnap.data() as Member;

      let msSnapData: Membership | null = null;
      const msRef = linkedMembershipId
        ? doc(db, 'gyms', gym.id, 'memberships', linkedMembershipId)
        : null;
      if (msRef) {
        const snap = await tx.get(msRef);
        if (snap.exists()) msSnapData = snap.data() as Membership;
      }

      const receiptNumber = input.confirmImmediately ? generateHumanCode('RCP') : undefined;
      const payRef = doc(db, 'gyms', gym.id, 'member_payments', paymentId);
      const safeDiscount = Math.max(0, Number(input.discountAmount) || 0);

      tx.set(payRef, {
        id: paymentId,
        paymentCode,
        gymId: gym.id,
        memberId: currentMem.id,
        memberName: currentMem.fullName,
        ...(linkedMembershipId ? { membershipId: linkedMembershipId } : {}),
        amount: input.amount,
        ...(safeDiscount > 0 ? { discountAmount: safeDiscount } : {}),
        ...(safeDiscount > 0 && input.discountReason?.trim()
          ? { discountReason: input.discountReason.trim().slice(0, 200) }
          : {}),
        paymentMode: input.paymentMode,
        paymentPurpose: input.paymentPurpose,
        ...(input.transactionReference?.trim()
          ? { transactionReference: input.transactionReference.trim() }
          : {}),
        ...(input.attachmentName?.trim()
          ? { attachmentName: input.attachmentName.trim() }
          : {}),
        paymentDate: input.paymentDate,
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        status: input.confirmImmediately
          ? MemberPaymentStatus.CONFIRMED
          : MemberPaymentStatus.PENDING,
        recordedByUid: actor.uid,
        recordedByName: actor.displayName,
        ...(input.confirmImmediately ? { confirmedByUid: actor.uid } : {}),
        ...(receiptNumber ? { receiptNumber } : {}),
        ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (input.confirmImmediately && receiptNumber) {
        const totalSettlement = input.amount + safeDiscount;
        const nextBalance = calculateOutstandingAfterPayment(
          currentMem.outstandingBalance,
          totalSettlement,
          input.paymentPurpose
        );
        tx.update(memRef, {
          outstandingBalance: nextBalance,
          updatedAt: serverTimestamp(),
        });

        if (msRef && msSnapData) {
          tx.update(msRef, {
            amountPaid: Number((msSnapData.amountPaid + input.amount).toFixed(2)),
            balanceDue: Math.max(
              0,
              Number((msSnapData.balanceDue - totalSettlement).toFixed(2))
            ),
            updatedAt: serverTimestamp(),
          });
        }

        const receiptId = generateSecureId('rcp');
        tx.set(doc(db, 'gyms', gym.id, 'payment_receipts', receiptId), {
          id: receiptId,
          receiptNumber,
          gymId: gym.id,
          gymName: gym.name,
          paymentId,
          memberId: currentMem.id,
          memberName: currentMem.fullName,
          memberCode: currentMem.memberCode,
          amount: input.amount,
          paymentMode: input.paymentMode,
          ...(input.transactionReference?.trim()
            ? { transactionReference: input.transactionReference.trim() }
            : {}),
          issuedAt: serverTimestamp(),
          issuedByUid: actor.uid,
        });

        const notifId = generateSecureId('gnotif');
        tx.set(doc(db, 'gyms', gym.id, 'notifications', notifId), {
          id: notifId,
          gymId: gym.id,
          type: 'PAYMENT_CONFIRMED',
          title: 'Payment confirmed',
          message: `${input.paymentMode} payment of ${input.amount} from ${currentMem.fullName} confirmed (Receipt ${receiptNumber}).`,
          isRead: false,
          createdAt: serverTimestamp(),
        });
      }

      await appendAuditLog(
        tx,
        actor,
        input.confirmImmediately ? 'CONFIRM_MEMBER_PAYMENT' : 'RECORD_PENDING_PAYMENT',
        'MemberPayment',
        paymentId,
        `${input.confirmImmediately ? 'Confirmed' : 'Recorded pending'} ${input.paymentMode} payment of ${input.amount} for ${currentMem.fullName}`,
        gym.id
      );
    });

    return paymentId;
  } catch (error) {
    if (error instanceof Error && (error.message.includes('Duplicate') || error.message.includes('UPI'))) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function confirmPendingMemberPayment(
  actor: ActorContext,
  gym: Gym,
  paymentId: string
): Promise<string> {
  const path = `gyms/${gym.id}/member_payments/${paymentId}`;
  try {
    let generatedReceiptNumber = '';
    await runTransaction(db, async (tx) => {
      const payRef = doc(db, 'gyms', gym.id, 'member_payments', paymentId);
      const paySnap = await tx.get(payRef);
      if (!paySnap.exists()) throw new Error('Payment record not found.');
      const payment = paySnap.data() as MemberPayment;

      const check = validatePaymentConfirmationTransition(payment);
      if (!check.allowed) {
        throw new Error(check.reason);
      }

      const memRef = doc(db, 'gyms', gym.id, 'members', payment.memberId);
      const memSnap = await tx.get(memRef);
      if (!memSnap.exists()) throw new Error('Member not found.');
      const member = memSnap.data() as Member;

      let msSnapData: Membership | null = null;
      const msRef = payment.membershipId
        ? doc(db, 'gyms', gym.id, 'memberships', payment.membershipId)
        : null;
      if (msRef) {
        const snap = await tx.get(msRef);
        if (snap.exists()) msSnapData = snap.data() as Membership;
      }

      const receiptNumber = generateHumanCode('RCP');
      generatedReceiptNumber = receiptNumber;

      tx.update(payRef, {
        status: MemberPaymentStatus.CONFIRMED,
        confirmedByUid: actor.uid,
        receiptNumber,
        updatedAt: serverTimestamp(),
      });

      const nextBalance = calculateOutstandingAfterPayment(
        member.outstandingBalance,
        payment.amount + (Number(payment.discountAmount) || 0),
        payment.paymentPurpose
      );

      tx.update(memRef, {
        outstandingBalance: nextBalance,
        updatedAt: serverTimestamp(),
      });

      if (msRef && msSnapData) {
        tx.update(msRef, {
          amountPaid: Number((msSnapData.amountPaid + payment.amount).toFixed(2)),
          balanceDue: Math.max(
            0,
            Number(
              (
                msSnapData.balanceDue -
                payment.amount -
                (Number(payment.discountAmount) || 0)
              ).toFixed(2)
            )
          ),
          updatedAt: serverTimestamp(),
        });
      }

      const receiptId = generateSecureId('rcp');
      tx.set(doc(db, 'gyms', gym.id, 'payment_receipts', receiptId), {
        id: receiptId,
        receiptNumber,
        gymId: gym.id,
        gymName: gym.name,
        paymentId: payment.id,
        memberId: member.id,
        memberName: member.fullName,
        memberCode: member.memberCode,
        amount: payment.amount,
        paymentMode: payment.paymentMode,
        ...(payment.transactionReference
          ? { transactionReference: payment.transactionReference }
          : {}),
        issuedAt: serverTimestamp(),
        issuedByUid: actor.uid,
      });

      const notifId = generateSecureId('gnotif');
      tx.set(doc(db, 'gyms', gym.id, 'notifications', notifId), {
        id: notifId,
        gymId: gym.id,
        type: 'PAYMENT_CONFIRMED',
        title: 'Payment verified & receipt issued',
        message: `${payment.paymentMode} payment ${payment.paymentCode} (${payment.amount}) confirmed for ${member.fullName}.`,
        isRead: false,
        createdAt: serverTimestamp(),
      });

      await appendAuditLog(
        tx,
        actor,
        'CONFIRM_MEMBER_PAYMENT',
        'MemberPayment',
        payment.id,
        `Confirmed payment ${payment.paymentCode} and issued receipt ${receiptNumber}`,
        gym.id
      );
    });

    return generatedReceiptNumber;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('Duplicate confirmation') ||
        error.message.includes('UPI transaction reference'))
    ) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function rejectOrRefundMemberPayment(
  actor: ActorContext,
  gymId: string,
  payment: MemberPayment,
  targetStatus: MemberPaymentStatus.REJECTED | MemberPaymentStatus.REFUNDED,
  reason: string
): Promise<void> {
  const path = `gyms/${gymId}/member_payments/${payment.id}`;
  try {
    await runTransaction(db, async (tx) => {
      const payRef = doc(db, 'gyms', gymId, 'member_payments', payment.id);
      const paySnap = await tx.get(payRef);
      if (!paySnap.exists()) throw new Error('Payment not found.');
      const current = paySnap.data() as MemberPayment;

      if (
        targetStatus === MemberPaymentStatus.REJECTED &&
        current.status !== MemberPaymentStatus.PENDING
      ) {
        throw new Error('Only pending payments can be rejected.');
      }
      if (
        targetStatus === MemberPaymentStatus.REFUNDED &&
        current.status !== MemberPaymentStatus.CONFIRMED
      ) {
        throw new Error('Only confirmed payments can be refunded.');
      }

      const memRef = doc(db, 'gyms', gymId, 'members', current.memberId);
      const memSnap = await tx.get(memRef);
      let msSnapData: Membership | null = null;
      const msRef = current.membershipId
        ? doc(db, 'gyms', gymId, 'memberships', current.membershipId)
        : null;
      if (msRef) {
        const snap = await tx.get(msRef);
        if (snap.exists()) msSnapData = snap.data() as Membership;
      }

      tx.update(payRef, {
        status: targetStatus,
        notes: `${current.notes ? `${current.notes} | ` : ''}${targetStatus}: ${reason}`.slice(0, 500),
        updatedAt: serverTimestamp(),
      });

      if (targetStatus === MemberPaymentStatus.REFUNDED) {
        if (memSnap.exists() && current.paymentPurpose !== MemberPaymentPurpose.ADVANCE) {
          const member = memSnap.data() as Member;
          tx.update(memRef, {
            outstandingBalance: Number(
              ((member.outstandingBalance || 0) + current.amount).toFixed(2)
            ),
            updatedAt: serverTimestamp(),
          });
        }
        if (msRef && msSnapData) {
          tx.update(msRef, {
            amountPaid: Math.max(0, Number((msSnapData.amountPaid - current.amount).toFixed(2))),
            balanceDue: Number((msSnapData.balanceDue + current.amount).toFixed(2)),
            updatedAt: serverTimestamp(),
          });
        }
      }

      await appendAuditLog(
        tx,
        actor,
        `${targetStatus}_MEMBER_PAYMENT`,
        'MemberPayment',
        payment.id,
        `${targetStatus} payment ${payment.paymentCode}: ${reason}`,
        gymId
      );
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// ---------------------------------------------------------------------------
// Gym Settings & Real Automated Reminder Engine
// ---------------------------------------------------------------------------
export async function updateGymSettings(
  actor: ActorContext,
  gymId: string,
  settings: Omit<GymSettings, 'gymId' | 'updatedAt'>
): Promise<void> {
  const path = `gyms/${gymId}/settings/default`;
  try {
    const settingsRef = doc(db, 'gyms', gymId, 'settings', 'default');
    const existing = await getDoc(settingsRef);
    const cleanUpdates: Record<string, unknown> = {
      gracePeriodDays: settings.gracePeriodDays,
      renewalPolicy: settings.renewalPolicy,
      reminderDaysBefore: settings.reminderDaysBefore,
      sendOnExpiryDay: settings.sendOnExpiryDay,
      sendAfterExpiryDays: settings.sendAfterExpiryDays,
      paymentRemindersEnabled: settings.paymentRemindersEnabled ?? true,
      upcomingPaymentReminderDays: settings.upcomingPaymentReminderDays ?? 3,
      overduePaymentReminderDays: settings.overduePaymentReminderDays ?? [1, 3, 7, 14],
      ownerSubReminderDays: settings.ownerSubReminderDays ?? [7, 3, 1, 0, -3],
      emailEnabled: settings.emailEnabled,
      inAppEnabled: settings.inAppEnabled,
      whatsappEnabled: settings.whatsappEnabled,
      currencySymbol: settings.currencySymbol,
      updatedAt: serverTimestamp(),
    };
    if (settings.emailFromName !== undefined) {
      cleanUpdates.emailFromName = settings.emailFromName;
    }
    if (settings.whatsappPhoneNumberId !== undefined) {
      cleanUpdates.whatsappPhoneNumberId = settings.whatsappPhoneNumberId;
    }
    if (settings.whatsappApprovedTemplate !== undefined) {
      cleanUpdates.whatsappApprovedTemplate = settings.whatsappApprovedTemplate;
    }

    const batch = writeBatch(db);
    if (existing.exists()) {
      batch.update(settingsRef, cleanUpdates);
    } else {
      batch.set(settingsRef, {
        ...cleanUpdates,
        gymId,
      });
    }
    // Note: gyme.gracePeriodDays is SaaS billing grace (Super Admin controlled);
    // only member renewalPolicy syncs on gym doc.
    batch.update(doc(db, 'gyms', gymId), {
      renewalPolicy: settings.renewalPolicy,
      updatedAt: serverTimestamp(),
    });
    await appendAuditLog(
      batch,
      actor,
      'UPDATE_GYM_SETTINGS',
      'GymSettings',
      gymId,
      'Updated gym renewal policy, member grace period, and reminder channels',
      gymId
    );
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function runReminderBatchForGym(
  actor: ActorContext,
  gym: Gym,
  members: Member[],
  settings: GymSettings,
  existingLogs: NotificationLog[],
  memberships: Membership[] = []
): Promise<{ sent: number; skippedOptOut: number; failed: number }> {
  const today = toIsoDate();
  const candidates = evaluateDueReminders(members, settings, existingLogs, today, {
    memberships,
    gym,
  });
  if (candidates.length === 0) {
    return { sent: 0, skippedOptOut: 0, failed: 0 };
  }

  let sent = 0;
  let skippedOptOut = 0;
  let failed = 0;

  try {
    const batch = writeBatch(db);
    for (const c of candidates) {
      const logId = generateSecureId('nlog');
      const attemptTime = new Date().toISOString();
      let status = DeliveryStatus.SENT;
      let errorDetails: string | undefined;
      let providerMessageId: string | undefined;
      let sentAt: string | undefined;

      if (c.skippedOptOut) {
        status = DeliveryStatus.SKIPPED_OPT_OUT;
        skippedOptOut += 1;
      } else if (c.channel === ReminderChannel.IN_APP) {
        sent += 1;
        sentAt = attemptTime;
        const notifId = generateSecureId('gnotif');
        batch.set(doc(db, 'gyms', gym.id, 'notifications', notifId), {
          id: notifId,
          gymId: gym.id,
          type: `REMINDER_${c.category}`,
          title: c.subject.slice(0, 160),
          message: c.message.slice(0, 500),
          isRead: false,
          createdAt: serverTimestamp(),
        });
      } else if (c.channel === ReminderChannel.EMAIL) {
        const outcome = await dispatchExternalReminder({
          channel: ReminderChannel.EMAIL,
          recipient: c.recipient,
          subject: c.subject,
          message: c.message,
          fromName: settings.emailFromName || gym.name,
        });
        if (outcome.delivered) {
          sent += 1;
          status = DeliveryStatus.SENT;
          providerMessageId = outcome.providerMessageId;
          sentAt = outcome.sentAt || attemptTime;
        } else {
          failed += 1;
          status = DeliveryStatus.RETRY_SCHEDULED;
          errorDetails = outcome.errorDetails || 'Email delivery failed';
        }
      } else if (c.channel === ReminderChannel.WHATSAPP_CLOUD) {
        const outcome = await dispatchExternalReminder({
          channel: ReminderChannel.WHATSAPP_CLOUD,
          recipient: c.recipient,
          subject: c.subject,
          message: c.message,
          whatsappPhoneNumberId: settings.whatsappPhoneNumberId,
          whatsappApprovedTemplate: settings.whatsappApprovedTemplate,
          whatsappTemplateParams: [c.memberName, c.template.replace(/_/g, ' ')],
        });
        if (outcome.delivered) {
          sent += 1;
          status = DeliveryStatus.SENT;
          providerMessageId = outcome.providerMessageId;
          sentAt = outcome.sentAt || attemptTime;
        } else {
          failed += 1;
          status = DeliveryStatus.RETRY_SCHEDULED;
          errorDetails = outcome.errorDetails || 'WhatsApp delivery failed';
        }
      }

      batch.set(doc(db, 'gyms', gym.id, 'notification_logs', logId), {
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
        deliveryStatus: status,
        retryCount: 0,
        lastAttemptAt: attemptTime,
        ...(sentAt ? { sentAt } : {}),
        ...(providerMessageId ? { providerMessageId } : {}),
        ...(errorDetails ? { errorDetails: errorDetails.slice(0, 400) } : {}),
        ...(status === DeliveryStatus.RETRY_SCHEDULED
          ? { nextRetryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() }
          : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    batch.update(doc(db, 'gyms', gym.id, 'settings', 'default'), {
      lastReminderRunDate: today,
      updatedAt: serverTimestamp(),
    });

    await appendAuditLog(
      batch,
      actor,
      'RUN_REMINDER_ENGINE',
      'NotificationLog',
      gym.id,
      `Processed ${candidates.length} due reminders (${sent} delivered, ${skippedOptOut} opt-out, ${failed} scheduled for retry)`,
      gym.id
    );
    await batch.commit();
    return { sent, skippedOptOut, failed };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `gyms/${gym.id}/notification_logs`);
  }
}

export async function retryNotificationLog(
  gym: Gym,
  settings: GymSettings,
  log: NotificationLog
): Promise<{ delivered: boolean; errorDetails?: string }> {
  const path = `gyms/${gym.id}/notification_logs/${log.id}`;
  const attemptTime = new Date().toISOString();

  let delivered = false;
  let providerMessageId: string | undefined;
  let errorDetails: string | undefined;

  if (log.channel === ReminderChannel.IN_APP) {
    delivered = true;
    providerMessageId = `inapp_retry_${Date.now()}`;
  } else {
    const subject = `${gym.name}: Reminder (${log.template.replace(/_/g, ' ')})`;
    const message = `Hi ${log.memberName}, this is a follow-up reminder from ${gym.name} regarding ${log.template.replace(/_/g, ' ').toLowerCase()}.`;
    const outcome = await dispatchExternalReminder({
      channel: log.channel,
      recipient: log.recipient,
      subject,
      message,
      fromName: settings.emailFromName || gym.name,
      whatsappPhoneNumberId: settings.whatsappPhoneNumberId,
      whatsappApprovedTemplate: settings.whatsappApprovedTemplate,
      whatsappTemplateParams: [log.memberName, log.template.replace(/_/g, ' ')],
    });
    delivered = outcome.delivered;
    providerMessageId = outcome.providerMessageId;
    errorDetails = outcome.errorDetails;
  }

  const next = computeNextRetryState(log, delivered, errorDetails);

  try {
    await updateDoc(doc(db, 'gyms', gym.id, 'notification_logs', log.id), {
      deliveryStatus: next.nextStatus,
      retryCount: next.nextRetryCount,
      lastAttemptAt: attemptTime,
      ...(delivered
        ? {
            errorDetails: '',
            sentAt: attemptTime,
            ...(providerMessageId ? { providerMessageId } : {}),
            nextRetryAt: '',
          }
        : {
            errorDetails: (next.errorDetails || 'Delivery retry failed').slice(0, 400),
            ...(next.canRetry
              ? { nextRetryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() }
              : { nextRetryAt: '' }),
          }),
      updatedAt: serverTimestamp(),
    });
    return { delivered, errorDetails: next.errorDetails };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function markNotificationRead(
  collectionPath: string,
  id: string
): Promise<void> {
  try {
    await updateDoc(doc(db, collectionPath, id), { isRead: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${collectionPath}/${id}`);
  }
}

// ---------------------------------------------------------------------------
// Full Gym JSON Backup Export & Validated Restore
// ---------------------------------------------------------------------------
export async function exportGymBackupPayload(gym: Gym): Promise<GymBackupPayload> {
  try {
    const [
      settingsSnap,
      plansSnap,
      membersSnap,
      membershipsSnap,
      paymentsSnap,
      receiptsSnap,
      attendanceSnap,
      logsSnap,
    ] = await Promise.all([
      getDoc(doc(db, 'gyms', gym.id, 'settings', 'default')),
      getDocs(collection(db, 'gyms', gym.id, 'membership_plans')),
      getDocs(collection(db, 'gyms', gym.id, 'members')),
      getDocs(collection(db, 'gyms', gym.id, 'memberships')),
      getDocs(collection(db, 'gyms', gym.id, 'member_payments')),
      getDocs(collection(db, 'gyms', gym.id, 'payment_receipts')),
      getDocs(collection(db, 'gyms', gym.id, 'attendance')),
      getDocs(collection(db, 'gyms', gym.id, 'notification_logs')),
    ]);

    return {
      schemaVersion: 'gymos.backup.v1',
      exportedAt: new Date().toISOString(),
      gymId: gym.id,
      gymName: gym.name,
      settings: settingsSnap.exists() ? (settingsSnap.data() as GymSettings) : null,
      membershipPlans: plansSnap.docs.map((d) => d.data() as MembershipPlan),
      members: membersSnap.docs.map((d) => d.data() as Member),
      memberships: membershipsSnap.docs.map((d) => d.data() as Membership),
      memberPayments: paymentsSnap.docs.map((d) => d.data() as MemberPayment),
      paymentReceipts: receiptsSnap.docs.map((d) => d.data() as PaymentReceipt),
      attendance: attendanceSnap.docs.map((d) => d.data() as AttendanceRecord),
      notificationLogs: logsSnap.docs.map((d) => d.data() as NotificationLog),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `gyms/${gym.id}`);
  }
}

export async function restoreGymBackupPayload(
  actor: ActorContext,
  gym: Gym,
  rawJsonText: string
): Promise<{ restoredCount: number }> {
  let parsed: GymBackupPayload;
  try {
    parsed = JSON.parse(rawJsonText) as GymBackupPayload;
  } catch {
    throw new Error('Invalid JSON file. Could not parse backup.');
  }

  if (!parsed || parsed.schemaVersion !== 'gymos.backup.v1') {
    throw new Error('Unsupported backup format. Expected schemaVersion "gymos.backup.v1".');
  }
  if (parsed.gymId && parsed.gymId !== gym.id) {
    throw new Error(
      `Tenant mismatch: this backup belongs to gym "${parsed.gymName}" (${parsed.gymId}), not "${gym.name}" (${gym.id}).`
    );
  }
  if (
    !Array.isArray(parsed.membershipPlans) ||
    !Array.isArray(parsed.members) ||
    !Array.isArray(parsed.memberships) ||
    !Array.isArray(parsed.memberPayments)
  ) {
    throw new Error('Malformed backup payload: missing required arrays.');
  }

  const ops: { ref: ReturnType<typeof doc>; data: Record<string, unknown> }[] = [];
  const validIdRe = /^[a-zA-Z0-9_-]{1,128}$/;

  for (const p of parsed.membershipPlans) {
    if (!p?.id || !validIdRe.test(p.id)) continue;
    ops.push({
      ref: doc(db, 'gyms', gym.id, 'membership_plans', p.id),
      data: {
        ...p,
        gymId: gym.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
  }

  for (const m of parsed.members) {
    if (!m?.id || !validIdRe.test(m.id)) continue;
    ops.push({
      ref: doc(db, 'gyms', gym.id, 'members', m.id),
      data: {
        ...m,
        gymId: gym.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
  }

  for (const ms of parsed.memberships) {
    if (!ms?.id || !validIdRe.test(ms.id)) continue;
    ops.push({
      ref: doc(db, 'gyms', gym.id, 'memberships', ms.id),
      data: {
        ...ms,
        gymId: gym.id,
        recordedByUid: actor.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
  }

  for (const pay of parsed.memberPayments) {
    if (!pay?.id || !validIdRe.test(pay.id)) continue;
    ops.push({
      ref: doc(db, 'gyms', gym.id, 'member_payments', pay.id),
      data: {
        ...pay,
        gymId: gym.id,
        recordedByUid: actor.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
  }

  if (Array.isArray(parsed.attendance)) {
    for (const att of parsed.attendance) {
      if (!att?.id || !validIdRe.test(att.id)) continue;
      ops.push({
        ref: doc(db, 'gyms', gym.id, 'attendance', att.id),
        data: {
          ...att,
          gymId: gym.id,
          recordedByUid: actor.uid,
          createdAt: serverTimestamp(),
        },
      });
    }
  }

  try {
    const chunkSize = 400;
    for (let i = 0; i < ops.length; i += chunkSize) {
      const batch = writeBatch(db);
      const chunk = ops.slice(i, i + chunkSize);
      for (const item of chunk) {
        batch.set(item.ref, item.data, { merge: true });
      }
      if (i + chunkSize >= ops.length) {
        await appendAuditLog(
          batch,
          actor,
          'RESTORE_GYM_BACKUP',
          'Gym',
          gym.id,
          `Restored ${ops.length} records from backup exported ${parsed.exportedAt}`,
          gym.id
        );
      }
      await batch.commit();
    }
    return { restoredCount: ops.length };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `gyms/${gym.id}`);
  }
}
