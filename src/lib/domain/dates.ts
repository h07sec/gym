import {
  MembershipDurationType,
  MembershipStatus,
  RenewalPolicy,
} from '../../types/gymos';

export function parseIsoDateParts(isoDate: string): { year: number; month: number; day: number } {
  const clean = isoDate.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (!match) {
    throw new Error(`Invalid ISO date format: ${isoDate}. Expected YYYY-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${isoDate}`);
  }
  return { year, month, day };
}

export function formatIsoDateParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

/**
 * Adds months cleanly while preserving month-end and leap-year semantics.
 * Example: 2024-01-31 + 1 month => 2024-02-29 (leap year)
 * Example: 2025-01-31 + 1 month => 2025-02-28 (non-leap year)
 * Example: 2024-02-29 + 12 months => 2025-02-28
 */
export function addMonthsSafe(isoDate: string, months: number): string {
  const { year, month, day } = parseIsoDateParts(isoDate);
  const totalMonths = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  const maxDay = daysInMonth(targetYear, targetMonth);
  const targetDay = Math.min(day, maxDay);
  return formatIsoDateParts(targetYear, targetMonth, targetDay);
}

export function addDaysSafe(isoDate: string, days: number): string {
  const { year, month, day } = parseIsoDateParts(isoDate);
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return formatIsoDateParts(
    dt.getUTCFullYear(),
    dt.getUTCMonth() + 1,
    dt.getUTCDate()
  );
}

export function diffDays(fromIso: string, toIso: string): number {
  const a = parseIsoDateParts(fromIso);
  const b = parseIsoDateParts(toIso);
  const utcA = Date.UTC(a.year, a.month - 1, a.day);
  const utcB = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((utcB - utcA) / (1000 * 60 * 60 * 24));
}

export function calculateMembershipExpiry(
  startDateIso: string,
  durationType: MembershipDurationType,
  durationValue: number
): string {
  switch (durationType) {
    case MembershipDurationType.MONTHLY:
      return addMonthsSafe(startDateIso, durationValue || 1);
    case MembershipDurationType.QUARTERLY:
      return addMonthsSafe(startDateIso, (durationValue || 1) * 3);
    case MembershipDurationType.HALF_YEARLY:
      return addMonthsSafe(startDateIso, (durationValue || 1) * 6);
    case MembershipDurationType.YEARLY:
      return addMonthsSafe(startDateIso, (durationValue || 1) * 12);
    case MembershipDurationType.CUSTOM_DAYS:
      return addDaysSafe(startDateIso, Math.max(1, durationValue));
    default:
      return addMonthsSafe(startDateIso, 1);
  }
}

export interface RenewalCalculationInput {
  currentExpiryDate?: string | null;
  todayIso: string;
  durationType: MembershipDurationType;
  durationValue: number;
  renewalPolicy: RenewalPolicy;
  gracePeriodDays: number;
}

export function calculateRenewalDates(input: RenewalCalculationInput): {
  startDate: string;
  expiryDate: string;
  extendedFromActiveExpiry: boolean;
} {
  const {
    currentExpiryDate,
    todayIso,
    durationType,
    durationValue,
    renewalPolicy,
    gracePeriodDays,
  } = input;

  if (!currentExpiryDate) {
    return {
      startDate: todayIso,
      expiryDate: calculateMembershipExpiry(todayIso, durationType, durationValue),
      extendedFromActiveExpiry: false,
    };
  }

  const daysUntilExpiry = diffDays(todayIso, currentExpiryDate);

  // Member is still active (renewing on or before current expiry) -> extend from existing expiry date
  if (daysUntilExpiry >= 0) {
    return {
      startDate: currentExpiryDate,
      expiryDate: calculateMembershipExpiry(currentExpiryDate, durationType, durationValue),
      extendedFromActiveExpiry: true,
    };
  }

  // Member has already expired: daysSinceExpiry = -daysUntilExpiry
  const daysSinceExpiry = Math.abs(daysUntilExpiry);
  if (
    renewalPolicy === RenewalPolicy.EXTEND_FROM_EXPIRY &&
    daysSinceExpiry <= Math.max(0, gracePeriodDays)
  ) {
    return {
      startDate: currentExpiryDate,
      expiryDate: calculateMembershipExpiry(currentExpiryDate, durationType, durationValue),
      extendedFromActiveExpiry: true,
    };
  }

  return {
    startDate: todayIso,
    expiryDate: calculateMembershipExpiry(todayIso, durationType, durationValue),
    extendedFromActiveExpiry: false,
  };
}

export function deriveMemberMembershipStatus(
  expiryDateIso?: string | null,
  todayIso?: string,
  expiringSoonWindowDays = 7
): MembershipStatus {
  if (!expiryDateIso) return MembershipStatus.NONE;
  const today = todayIso ?? new Date().toISOString().slice(0, 10);
  const remaining = diffDays(today, expiryDateIso);
  if (remaining < 0) return MembershipStatus.EXPIRED;
  if (remaining <= expiringSoonWindowDays) return MembershipStatus.EXPIRING_SOON;
  return MembershipStatus.ACTIVE;
}
