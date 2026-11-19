import {
  DeliveryStatus,
  Gym,
  GymSettings,
  Member,
  Membership,
  MembershipRecordStatus,
  NotificationLog,
  ReminderCategory,
  ReminderChannel,
} from '../../types/gymos';
import { diffDays } from './dates';

export interface ReminderCandidate {
  memberId: string;
  memberName: string;
  recipient: string;
  channel: ReminderChannel;
  category: ReminderCategory;
  template: string;
  subject: string;
  message: string;
  dedupKey: string;
  scheduledDate: string;
  skippedOptOut: boolean;
}

export const MAX_REMINDER_RETRIES = 3;

export function buildDedupKey(
  memberId: string,
  template: string,
  scheduledDate: string,
  channel: ReminderChannel
): string {
  return `${memberId}__${template}__${scheduledDate}__${channel}`;
}

export function isWhatsAppReady(settings: GymSettings): boolean {
  return Boolean(
    settings.whatsappEnabled &&
      settings.whatsappPhoneNumberId?.trim() &&
      settings.whatsappApprovedTemplate?.trim()
  );
}

function getActiveChannels(settings: GymSettings): ReminderChannel[] {
  const activeChannels: ReminderChannel[] = [];
  if (settings.inAppEnabled) activeChannels.push(ReminderChannel.IN_APP);
  if (settings.emailEnabled) activeChannels.push(ReminderChannel.EMAIL);
  if (isWhatsAppReady(settings)) activeChannels.push(ReminderChannel.WHATSAPP_CLOUD);
  return activeChannels;
}

export function evaluateDueReminders(
  members: Member[],
  settings: GymSettings,
  existingLogs: NotificationLog[],
  todayIso: string,
  options?: {
    memberships?: Membership[];
    gym?: Gym;
  }
): ReminderCandidate[] {
  const existingDedupKeys = new Set(existingLogs.map((l) => l.dedupKey));
  const candidates: ReminderCandidate[] = [];
  const activeChannels = getActiveChannels(settings);
  const currency = settings.currencySymbol || '₹';
  const gymName = options?.gym?.name || settings.emailFromName || 'Your Gym';

  // 1. Membership Expiry & Renewal Reminders
  for (const member of members) {
    if (member.isArchived || !member.membershipExpiryDate) continue;

    const daysToExpiry = diffDays(todayIso, member.membershipExpiryDate);
    let template: string | null = null;
    let subject = '';
    let message = '';

    if (daysToExpiry > 0 && settings.reminderDaysBefore.includes(daysToExpiry)) {
      template = `EXPIRING_IN_${daysToExpiry}_DAYS`;
      subject = `${gymName}: Your membership expires in ${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'}`;
      message = `Hi ${member.fullName}, your ${member.currentPlanName || 'gym'} membership expires on ${member.membershipExpiryDate} (in ${daysToExpiry} days). Renew at the desk to avoid interruption.`;
    } else if (daysToExpiry === 0 && settings.sendOnExpiryDay) {
      template = 'EXPIRING_TODAY';
      subject = `${gymName}: Your membership expires today`;
      message = `Hi ${member.fullName}, your ${member.currentPlanName || 'gym'} membership expires today (${member.membershipExpiryDate}). Please renew today to stay active.`;
    } else if (
      daysToExpiry < 0 &&
      settings.sendAfterExpiryDays.includes(Math.abs(daysToExpiry))
    ) {
      const overdue = Math.abs(daysToExpiry);
      template = `EXPIRED_${overdue}_DAYS_AGO`;
      subject = `${gymName}: Membership expired ${overdue} day${overdue === 1 ? '' : 's'} ago`;
      message = `Hi ${member.fullName}, your ${member.currentPlanName || 'gym'} membership expired on ${member.membershipExpiryDate}. Visit us to renew your plan.`;
    }

    if (template) {
      for (const channel of activeChannels) {
        const recipient =
          channel === ReminderChannel.EMAIL
            ? member.email?.trim() || ''
            : channel === ReminderChannel.WHATSAPP_CLOUD
              ? member.phone
              : member.memberCode;

        if (channel === ReminderChannel.EMAIL && !recipient) continue;
        if (channel === ReminderChannel.WHATSAPP_CLOUD && !recipient.trim()) continue;

        const dedupKey = buildDedupKey(member.id, template, todayIso, channel);
        if (existingDedupKeys.has(dedupKey)) continue;

        candidates.push({
          memberId: member.id,
          memberName: member.fullName,
          recipient,
          channel,
          category: ReminderCategory.MEMBERSHIP_EXPIRY,
          template,
          subject,
          message,
          dedupKey,
          scheduledDate: todayIso,
          skippedOptOut: member.reminderOptOut,
        });
      }
    }
  }

  // 2. Upcoming & Overdue Member Balance Payment Reminders
  const paymentRemindersEnabled = settings.paymentRemindersEnabled ?? true;
  if (paymentRemindersEnabled) {
    const upcomingWindow = Math.max(0, settings.upcomingPaymentReminderDays ?? 3);
    const overdueDaysList = settings.overduePaymentReminderDays ?? [1, 3, 7, 14];
    const memberships = options?.memberships ?? [];

    for (const member of members) {
      if (member.isArchived || (Number(member.outstandingBalance) || 0) <= 0) continue;

      const outstanding = Number(member.outstandingBalance).toFixed(2);
      const activeDueMs = memberships.find(
        (ms) =>
          ms.memberId === member.id &&
          ms.status === MembershipRecordStatus.ACTIVE &&
          ms.balanceDue > 0 &&
          ms.dueDate
      );

      let category: ReminderCategory | null = null;
      let template: string | null = null;
      let subject = '';
      let message = '';

      if (activeDueMs?.dueDate) {
        const daysToDue = diffDays(todayIso, activeDueMs.dueDate);
        if (daysToDue >= 0 && daysToDue <= upcomingWindow) {
          category = ReminderCategory.UPCOMING_PAYMENT;
          template = `PAYMENT_DUE_IN_${daysToDue}_DAYS`;
          subject = `${gymName}: Payment due reminder (${currency}${outstanding})`;
          message = `Hi ${member.fullName}, you have a balance of ${currency}${outstanding} due on ${activeDueMs.dueDate}. Pay via Cash or UPI at the front desk.`;
        } else if (daysToDue < 0 && overdueDaysList.includes(Math.abs(daysToDue))) {
          const daysPast = Math.abs(daysToDue);
          category = ReminderCategory.OVERDUE_PAYMENT;
          template = `PAYMENT_OVERDUE_${daysPast}_DAYS`;
          subject = `${gymName}: Overdue balance reminder (${currency}${outstanding})`;
          message = `Hi ${member.fullName}, your balance of ${currency}${outstanding} is overdue by ${daysPast} day${daysPast === 1 ? '' : 's'} (due ${activeDueMs.dueDate}). Kindly settle at your earliest convenience.`;
        }
      } else if (
        member.membershipExpiryDate &&
        diffDays(todayIso, member.membershipExpiryDate) < 0 &&
        overdueDaysList.includes(Math.abs(diffDays(todayIso, member.membershipExpiryDate)))
      ) {
        const daysPast = Math.abs(diffDays(todayIso, member.membershipExpiryDate));
        category = ReminderCategory.OVERDUE_PAYMENT;
        template = `BALANCE_OVERDUE_${daysPast}_DAYS`;
        subject = `${gymName}: Pending balance of ${currency}${outstanding}`;
        message = `Hi ${member.fullName}, an outstanding balance of ${currency}${outstanding} remains on your account. Please clear it at the reception desk.`;
      }

      if (category && template) {
        for (const channel of activeChannels) {
          const recipient =
            channel === ReminderChannel.EMAIL
              ? member.email?.trim() || ''
              : channel === ReminderChannel.WHATSAPP_CLOUD
                ? member.phone
                : member.memberCode;

          if (channel === ReminderChannel.EMAIL && !recipient) continue;
          if (channel === ReminderChannel.WHATSAPP_CLOUD && !recipient.trim()) continue;

          const dedupKey = buildDedupKey(member.id, template, todayIso, channel);
          if (existingDedupKeys.has(dedupKey)) continue;

          candidates.push({
            memberId: member.id,
            memberName: member.fullName,
            recipient,
            channel,
            category,
            template,
            subject,
            message,
            dedupKey,
            scheduledDate: todayIso,
            skippedOptOut: member.reminderOptOut,
          });
        }
      }
    }
  }

  // 3. Gym Owner GymOS Subscription Expiry Reminder
  if (options?.gym?.subscriptionEndAt) {
    const subEnd = options.gym.subscriptionEndAt.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(subEnd)) {
      const daysLeft = diffDays(todayIso, subEnd);
      const ownerAlertDays = settings.ownerSubReminderDays ?? [7, 3, 1, 0, -3];
      if (ownerAlertDays.includes(daysLeft)) {
        const template =
          daysLeft > 0
            ? `OWNER_SUB_EXPIRING_IN_${daysLeft}_DAYS`
            : daysLeft === 0
              ? 'OWNER_SUB_EXPIRING_TODAY'
              : `OWNER_SUB_EXPIRED_${Math.abs(daysLeft)}_DAYS_AGO`;
        const subject = `GymOS Subscription Alert for ${options.gym.name}`;
        const message =
          daysLeft > 0
            ? `Your GymOS ${options.gym.subscriptionPlanName} subscription expires on ${subEnd} (${daysLeft} days left). Contact support to renew.`
            : daysLeft === 0
              ? `Your GymOS ${options.gym.subscriptionPlanName} subscription expires today (${subEnd}). Please complete renewal to prevent lockout.`
              : `Your GymOS ${options.gym.subscriptionPlanName} subscription expired on ${subEnd}. Renew immediately to restore uninterrupted access.`;

        for (const channel of [ReminderChannel.IN_APP, ReminderChannel.EMAIL]) {
          if (channel === ReminderChannel.EMAIL && !settings.emailEnabled) continue;
          const recipient =
            channel === ReminderChannel.EMAIL ? options.gym.email : options.gym.ownerUid;
          if (!recipient) continue;
          const dedupKey = buildDedupKey(`owner_${options.gym.id}`, template, todayIso, channel);
          if (existingDedupKeys.has(dedupKey)) continue;

          candidates.push({
            memberId: `owner_${options.gym.id}`,
            memberName: `${options.gym.ownerName} (Owner)`,
            recipient,
            channel,
            category: ReminderCategory.SUBSCRIPTION_EXPIRY,
            template,
            subject,
            message,
            dedupKey,
            scheduledDate: todayIso,
            skippedOptOut: false,
          });
        }
      }
    }
  }

  return candidates;
}

/**
 * Computes next retry attempt metadata. Delivery outcome (`SENT` vs `RETRY_SCHEDULED` / `FAILED`)
 * MUST come from actual provider/server delivery results—never synthesized blindly.
 */
export function computeNextRetryState(
  currentLog: NotificationLog,
  deliverySucceeded: boolean,
  errorMessage?: string
): {
  canRetry: boolean;
  nextRetryCount: number;
  nextStatus: DeliveryStatus;
  errorDetails?: string;
} {
  if (currentLog.deliveryStatus === DeliveryStatus.SENT) {
    return {
      canRetry: false,
      nextRetryCount: currentLog.retryCount,
      nextStatus: DeliveryStatus.SENT,
    };
  }

  const nextCount = currentLog.retryCount + 1;
  if (deliverySucceeded) {
    return {
      canRetry: false,
      nextRetryCount: nextCount,
      nextStatus: DeliveryStatus.SENT,
    };
  }

  if (nextCount >= MAX_REMINDER_RETRIES) {
    return {
      canRetry: false,
      nextRetryCount: nextCount,
      nextStatus: DeliveryStatus.FAILED,
      errorDetails: errorMessage || 'Maximum retries reached',
    };
  }

  return {
    canRetry: true,
    nextRetryCount: nextCount,
    nextStatus: DeliveryStatus.RETRY_SCHEDULED,
    errorDetails: errorMessage || 'Delivery attempt failed; scheduled for retry',
  };
}
