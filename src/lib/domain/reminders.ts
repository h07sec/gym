import {
  DeliveryStatus,
  GymSettings,
  Member,
  NotificationLog,
  ReminderChannel,
} from '../../types/gymos';
import { diffDays } from './dates';

export interface ReminderCandidate {
  memberId: string;
  memberName: string;
  recipient: string;
  channel: ReminderChannel;
  template: string;
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

export function evaluateDueReminders(
  members: Member[],
  settings: GymSettings,
  existingLogs: NotificationLog[],
  todayIso: string
): ReminderCandidate[] {
  const existingDedupKeys = new Set(existingLogs.map((l) => l.dedupKey));
  const candidates: ReminderCandidate[] = [];

  const activeChannels: ReminderChannel[] = [];
  if (settings.inAppEnabled) activeChannels.push(ReminderChannel.IN_APP);
  if (settings.emailEnabled) activeChannels.push(ReminderChannel.EMAIL);
  if (isWhatsAppReady(settings)) activeChannels.push(ReminderChannel.WHATSAPP_CLOUD);

  for (const member of members) {
    if (member.isArchived || !member.membershipExpiryDate) continue;

    const daysToExpiry = diffDays(todayIso, member.membershipExpiryDate);
    let template: string | null = null;

    if (daysToExpiry > 0 && settings.reminderDaysBefore.includes(daysToExpiry)) {
      template = `EXPIRING_IN_${daysToExpiry}_DAYS`;
    } else if (daysToExpiry === 0 && settings.sendOnExpiryDay) {
      template = 'EXPIRING_TODAY';
    } else if (
      daysToExpiry < 0 &&
      settings.sendAfterExpiryDays.includes(Math.abs(daysToExpiry))
    ) {
      template = `EXPIRED_${Math.abs(daysToExpiry)}_DAYS_AGO`;
    }

    if (!template) continue;

    for (const channel of activeChannels) {
      const recipient =
        channel === ReminderChannel.EMAIL
          ? member.email?.trim() || ''
          : channel === ReminderChannel.WHATSAPP_CLOUD
            ? member.phone
            : member.memberCode;

      if (channel === ReminderChannel.EMAIL && !recipient) continue;

      const dedupKey = buildDedupKey(member.id, template, todayIso, channel);
      if (existingDedupKeys.has(dedupKey)) {
        continue;
      }

      candidates.push({
        memberId: member.id,
        memberName: member.fullName,
        recipient,
        channel,
        template,
        dedupKey,
        scheduledDate: todayIso,
        skippedOptOut: member.reminderOptOut,
      });
    }
  }

  return candidates;
}

export function computeNextRetryState(currentLog: NotificationLog): {
  canRetry: boolean;
  nextRetryCount: number;
  nextStatus: DeliveryStatus;
} {
  if (currentLog.deliveryStatus === DeliveryStatus.SENT) {
    return {
      canRetry: false,
      nextRetryCount: currentLog.retryCount,
      nextStatus: DeliveryStatus.SENT,
    };
  }
  if (currentLog.retryCount >= MAX_REMINDER_RETRIES) {
    return {
      canRetry: false,
      nextRetryCount: currentLog.retryCount,
      nextStatus: DeliveryStatus.FAILED,
    };
  }
  return {
    canRetry: true,
    nextRetryCount: currentLog.retryCount + 1,
    nextStatus: DeliveryStatus.SENT,
  };
}
