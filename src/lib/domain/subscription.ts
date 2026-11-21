import { AccountStatus, Gym, SubscriptionStatus } from '../../types/gymos';
import { addDaysSafe, diffDays } from './dates';

export interface SubscriptionAccessState {
  isLocked: boolean;
  reason: 'SUSPENDED' | 'PENDING_VERIFICATION' | 'EXPIRED' | 'CANCELLED' | 'ACTIVE';
  effectiveAccessUntil: string;
  daysUntilExpiry: number | null;
  inGracePeriod: boolean;
}

export function computeEffectiveAccessEndIso(
  subscriptionEndAtIso: string,
  gracePeriodDays: number
): string {
  const safeEnd = (subscriptionEndAtIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeEnd)) {
    return '';
  }
  return addDaysSafe(safeEnd, Math.max(0, Number(gracePeriodDays) || 0));
}

export function evaluateGymSubscriptionAccess(
  gym: Pick<
    Gym,
    | 'accountStatus'
    | 'subscriptionStatus'
    | 'subscriptionEndAt'
    | 'gracePeriodDays'
  >,
  todayIso: string
): SubscriptionAccessState {
  const endIso = (gym.subscriptionEndAt || '').slice(0, 10);
  const graceDays = Math.max(0, Number(gym.gracePeriodDays) || 0);
  const effectiveAccessUntil = computeEffectiveAccessEndIso(endIso, graceDays);
  const daysUntilExpiry = /^\d{4}-\d{2}-\d{2}$/.test(endIso)
    ? diffDays(todayIso, endIso)
    : null;

  if (gym.accountStatus === AccountStatus.SUSPENDED) {
    return {
      isLocked: true,
      reason: 'SUSPENDED',
      effectiveAccessUntil,
      daysUntilExpiry,
      inGracePeriod: false,
    };
  }

  if (gym.subscriptionStatus === SubscriptionStatus.PENDING) {
    return {
      isLocked: true,
      reason: 'PENDING_VERIFICATION',
      effectiveAccessUntil,
      daysUntilExpiry,
      inGracePeriod: false,
    };
  }

  if (gym.subscriptionStatus === SubscriptionStatus.CANCELLED) {
    return {
      isLocked: true,
      reason: 'CANCELLED',
      effectiveAccessUntil,
      daysUntilExpiry,
      inGracePeriod: false,
    };
  }

  if (gym.subscriptionStatus === SubscriptionStatus.EXPIRED) {
    return {
      isLocked: true,
      reason: 'EXPIRED',
      effectiveAccessUntil,
      daysUntilExpiry,
      inGracePeriod: false,
    };
  }

  if (!effectiveAccessUntil || todayIso > effectiveAccessUntil) {
    return {
      isLocked: true,
      reason: 'EXPIRED',
      effectiveAccessUntil,
      daysUntilExpiry,
      inGracePeriod: false,
    };
  }

  const inGracePeriod = Boolean(
    daysUntilExpiry !== null && daysUntilExpiry < 0 && effectiveAccessUntil && todayIso <= effectiveAccessUntil
  );

  return {
    isLocked: false,
    reason: 'ACTIVE',
    effectiveAccessUntil,
    daysUntilExpiry,
    inGracePeriod,
  };
}
