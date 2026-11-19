import {
  AccountStatus,
  Gym,
  Member,
  MemberPayment,
  MemberPaymentStatus,
  Membership,
  MembershipActionType,
  MembershipRecordStatus,
  MembershipStatus,
  PaymentMode,
  SubscriptionPayment,
  SubscriptionPaymentStatus,
  SubscriptionPlan,
  SubscriptionStatus,
} from '../../types/gymos';
import { addDaysSafe, deriveMemberMembershipStatus, diffDays } from './dates';

export interface GymDashboardMetrics {
  totalMembers: number;
  activeMembers: number;
  expiredMemberships: number;
  expiringSoonMemberships: number;
  todaysCollections: number;
  monthlyCollections: number;
  pendingPaymentsCount: number;
  pendingPaymentsAmount: number;
  totalOutstandingFees: number;
  newMembersThisMonth: number;
  renewalsThisMonth: number;
}

export interface MonthlyChartPoint {
  month: string;
  revenue: number;
  newMembers: number;
  renewals: number;
}

export interface DailyReportSummary {
  date: string;
  newRegistrations: number;
  activeMembers: number;
  expiredMembers: number;
  expiringSoonMembers: number;
  cashCollections: number;
  upiCollections: number;
  pendingPaymentsCount: number;
  pendingPaymentsAmount: number;
  totalConfirmedCollections: number;
}

export interface RangeReportSummary {
  startDate: string;
  endDate: string;
  totalRevenue: number;
  cashRevenue: number;
  upiRevenue: number;
  confirmedPaymentsCount: number;
  pendingPaymentsCount: number;
  pendingPaymentsAmount: number;
  newMembers: number;
  renewals: number;
  cancellations: number;
  planPerformance: { planName: string; count: number; revenue: number }[];
}

export interface MonthlyReportSummary {
  monthKey: string;
  totalRevenue: number;
  cashRevenue: number;
  upiRevenue: number;
  newMembers: number;
  renewals: number;
  cancellations: number;
  outstandingBalances: number;
  planPerformance: { planName: string; count: number; revenue: number }[];
}

export interface OutstandingBalanceRow {
  memberId: string;
  memberCode: string;
  fullName: string;
  phone: string;
  currentPlanName: string;
  membershipExpiryDate: string;
  membershipStatus: MembershipStatus;
  outstandingBalance: number;
  dueDate: string;
  daysOverdue: number;
}

export interface ExpiringMembershipRow {
  memberId: string;
  memberCode: string;
  fullName: string;
  phone: string;
  email: string;
  currentPlanName: string;
  membershipExpiryDate: string;
  daysRemaining: number;
  outstandingBalance: number;
}

export function computeGymDashboardMetrics(
  members: Member[],
  payments: MemberPayment[],
  memberships: Membership[],
  referenceDateIso: string
): GymDashboardMetrics {
  const activeRecords = members.filter((m) => !m.isArchived);
  const monthPrefix = referenceDateIso.slice(0, 7);

  let activeMembers = 0;
  let expiredMemberships = 0;
  let expiringSoonMemberships = 0;
  let totalOutstandingFees = 0;
  let newMembersThisMonth = 0;

  for (const m of activeRecords) {
    if (m.membershipStatus === MembershipStatus.CANCELLED) {
      totalOutstandingFees += Math.max(0, Number(m.outstandingBalance) || 0);
      if ((m.joiningDate || '').startsWith(monthPrefix)) newMembersThisMonth += 1;
      continue;
    }
    const derived = deriveMemberMembershipStatus(m.membershipExpiryDate, referenceDateIso, 7);
    if (derived === MembershipStatus.ACTIVE) {
      activeMembers += 1;
    } else if (derived === MembershipStatus.EXPIRING_SOON) {
      activeMembers += 1;
      expiringSoonMemberships += 1;
    } else if (derived === MembershipStatus.EXPIRED) {
      expiredMemberships += 1;
    }
    totalOutstandingFees += Math.max(0, Number(m.outstandingBalance) || 0);
    if ((m.joiningDate || '').startsWith(monthPrefix)) {
      newMembersThisMonth += 1;
    }
  }

  let todaysCollections = 0;
  let monthlyCollections = 0;
  let pendingPaymentsCount = 0;
  let pendingPaymentsAmount = 0;

  for (const p of payments) {
    if (p.status === MemberPaymentStatus.CONFIRMED) {
      if (p.paymentDate === referenceDateIso) {
        todaysCollections += p.amount;
      }
      if ((p.paymentDate || '').startsWith(monthPrefix)) {
        monthlyCollections += p.amount;
      }
    } else if (p.status === MemberPaymentStatus.PENDING) {
      pendingPaymentsCount += 1;
      pendingPaymentsAmount += p.amount;
    }
  }

  const renewalsThisMonth = memberships.filter(
    (ms) =>
      ms.actionType === MembershipActionType.RENEWAL &&
      ms.status !== MembershipRecordStatus.CANCELLED &&
      (ms.startDate || '').startsWith(monthPrefix)
  ).length;

  return {
    totalMembers: activeRecords.length,
    activeMembers,
    expiredMemberships,
    expiringSoonMemberships,
    todaysCollections: Number(todaysCollections.toFixed(2)),
    monthlyCollections: Number(monthlyCollections.toFixed(2)),
    pendingPaymentsCount,
    pendingPaymentsAmount: Number(pendingPaymentsAmount.toFixed(2)),
    totalOutstandingFees: Number(totalOutstandingFees.toFixed(2)),
    newMembersThisMonth,
    renewalsThisMonth,
  };
}

export function computeMonthlyTrends(
  members: Member[],
  payments: MemberPayment[],
  memberships: Membership[],
  referenceDateIso: string,
  monthsBack = 6
): MonthlyChartPoint[] {
  const refYear = Number(referenceDateIso.slice(0, 4));
  const refMonth = Number(referenceDateIso.slice(5, 7));
  const points: MonthlyChartPoint[] = [];

  for (let i = monthsBack - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(refYear, refMonth - 1 - i, 1));
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const key = `${y}-${m}`;
    const label = dt.toLocaleDateString('en-US', {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    });

    const revenue = payments
      .filter((p) => p.status === MemberPaymentStatus.CONFIRMED && p.paymentDate.startsWith(key))
      .reduce((sum, p) => sum + p.amount, 0);

    const newMembers = members.filter(
      (mem) => !mem.isArchived && mem.joiningDate.startsWith(key)
    ).length;

    const renewals = memberships.filter(
      (ms) => ms.actionType === MembershipActionType.RENEWAL && ms.startDate.startsWith(key)
    ).length;

    points.push({
      month: label,
      revenue: Number(revenue.toFixed(2)),
      newMembers,
      renewals,
    });
  }

  return points;
}

export function computeDailyReport(
  members: Member[],
  payments: MemberPayment[],
  targetDateIso: string
): DailyReportSummary {
  const activeRecords = members.filter((m) => !m.isArchived);
  let activeMembers = 0;
  let expiredMembers = 0;
  let expiringSoonMembers = 0;

  for (const m of activeRecords) {
    if (m.membershipStatus === MembershipStatus.CANCELLED) continue;
    const st = deriveMemberMembershipStatus(m.membershipExpiryDate, targetDateIso, 7);
    if (st === MembershipStatus.ACTIVE) activeMembers += 1;
    else if (st === MembershipStatus.EXPIRING_SOON) {
      activeMembers += 1;
      expiringSoonMembers += 1;
    } else if (st === MembershipStatus.EXPIRED) expiredMembers += 1;
  }

  const dayPayments = payments.filter((p) => p.paymentDate === targetDateIso);
  const cashCollections = dayPayments
    .filter((p) => p.status === MemberPaymentStatus.CONFIRMED && p.paymentMode === PaymentMode.CASH)
    .reduce((s, p) => s + p.amount, 0);
  const upiCollections = dayPayments
    .filter((p) => p.status === MemberPaymentStatus.CONFIRMED && p.paymentMode === PaymentMode.UPI)
    .reduce((s, p) => s + p.amount, 0);
  const pending = dayPayments.filter((p) => p.status === MemberPaymentStatus.PENDING);

  return {
    date: targetDateIso,
    newRegistrations: activeRecords.filter((m) => m.joiningDate === targetDateIso).length,
    activeMembers,
    expiredMembers,
    expiringSoonMembers,
    cashCollections: Number(cashCollections.toFixed(2)),
    upiCollections: Number(upiCollections.toFixed(2)),
    pendingPaymentsCount: pending.length,
    pendingPaymentsAmount: Number(pending.reduce((s, p) => s + p.amount, 0).toFixed(2)),
    totalConfirmedCollections: Number((cashCollections + upiCollections).toFixed(2)),
  };
}

export function computeDateRangeReport(
  members: Member[],
  payments: MemberPayment[],
  memberships: Membership[],
  startDateIso: string,
  endDateIso: string
): RangeReportSummary {
  const inRange = (dt?: string) => Boolean(dt && dt >= startDateIso && dt <= endDateIso);
  const rangePayments = payments.filter((p) => inRange(p.paymentDate));
  const confirmed = rangePayments.filter((p) => p.status === MemberPaymentStatus.CONFIRMED);
  const pending = rangePayments.filter((p) => p.status === MemberPaymentStatus.PENDING);

  const cashRevenue = confirmed
    .filter((p) => p.paymentMode === PaymentMode.CASH)
    .reduce((s, p) => s + p.amount, 0);
  const upiRevenue = confirmed
    .filter((p) => p.paymentMode === PaymentMode.UPI)
    .reduce((s, p) => s + p.amount, 0);

  const rangeMemberships = memberships.filter((m) => inRange(m.startDate));
  const membershipById = new Map(memberships.map((ms) => [ms.id, ms]));
  const planMap = new Map<string, { planName: string; count: number; revenue: number }>();

  for (const ms of rangeMemberships) {
    const prev = planMap.get(ms.planName) ?? { planName: ms.planName, count: 0, revenue: 0 };
    prev.count += 1;
    planMap.set(ms.planName, prev);
  }

  for (const p of confirmed) {
    const ms = p.membershipId ? membershipById.get(p.membershipId) : undefined;
    const key = ms?.planName || 'General / Settlement';
    const prev = planMap.get(key) ?? { planName: key, count: 0, revenue: 0 };
    prev.revenue += p.amount;
    planMap.set(key, prev);
  }

  return {
    startDate: startDateIso,
    endDate: endDateIso,
    totalRevenue: Number((cashRevenue + upiRevenue).toFixed(2)),
    cashRevenue: Number(cashRevenue.toFixed(2)),
    upiRevenue: Number(upiRevenue.toFixed(2)),
    confirmedPaymentsCount: confirmed.length,
    pendingPaymentsCount: pending.length,
    pendingPaymentsAmount: Number(pending.reduce((s, p) => s + p.amount, 0).toFixed(2)),
    newMembers: members.filter((m) => !m.isArchived && inRange(m.joiningDate)).length,
    renewals: rangeMemberships.filter((m) => m.actionType === MembershipActionType.RENEWAL).length,
    cancellations: memberships.filter(
      (m) => m.status === MembershipRecordStatus.CANCELLED && inRange(m.cancelledAt || m.startDate)
    ).length,
    planPerformance: Array.from(planMap.values())
      .map((r) => ({ ...r, revenue: Number(r.revenue.toFixed(2)) }))
      .sort((a, b) => b.revenue - a.revenue),
  };
}

export function computeWeeklyReport(
  members: Member[],
  payments: MemberPayment[],
  memberships: Membership[],
  endDateIso: string
): RangeReportSummary {
  const startDateIso = addDaysSafe(endDateIso, -6);
  return computeDateRangeReport(members, payments, memberships, startDateIso, endDateIso);
}

export function computeMonthlyReport(
  members: Member[],
  payments: MemberPayment[],
  memberships: Membership[],
  monthKey: string
): MonthlyReportSummary {
  const confirmed = payments.filter(
    (p) => p.status === MemberPaymentStatus.CONFIRMED && p.paymentDate.startsWith(monthKey)
  );
  const cashRevenue = confirmed
    .filter((p) => p.paymentMode === PaymentMode.CASH)
    .reduce((s, p) => s + p.amount, 0);
  const upiRevenue = confirmed
    .filter((p) => p.paymentMode === PaymentMode.UPI)
    .reduce((s, p) => s + p.amount, 0);

  const monthMemberships = memberships.filter((m) => m.startDate.startsWith(monthKey));
  const membershipById = new Map(memberships.map((ms) => [ms.id, ms]));
  const planMap = new Map<string, { planName: string; count: number; revenue: number }>();

  for (const ms of monthMemberships) {
    const prev = planMap.get(ms.planName) ?? { planName: ms.planName, count: 0, revenue: 0 };
    prev.count += 1;
    planMap.set(ms.planName, prev);
  }

  for (const p of confirmed) {
    const ms = p.membershipId ? membershipById.get(p.membershipId) : undefined;
    const key = ms?.planName || 'Balance Settlement / Other';
    const prev = planMap.get(key) ?? { planName: key, count: 0, revenue: 0 };
    prev.revenue += p.amount;
    planMap.set(key, prev);
  }

  return {
    monthKey,
    totalRevenue: Number((cashRevenue + upiRevenue).toFixed(2)),
    cashRevenue: Number(cashRevenue.toFixed(2)),
    upiRevenue: Number(upiRevenue.toFixed(2)),
    newMembers: members.filter((m) => !m.isArchived && m.joiningDate.startsWith(monthKey)).length,
    renewals: monthMemberships.filter((m) => m.actionType === MembershipActionType.RENEWAL).length,
    cancellations: memberships.filter(
      (m) => m.status === MembershipRecordStatus.CANCELLED && (m.cancelledAt || m.startDate).startsWith(monthKey)
    ).length,
    outstandingBalances: Number(
      members
        .filter((m) => !m.isArchived)
        .reduce((s, m) => s + Math.max(0, m.outstandingBalance), 0)
        .toFixed(2)
    ),
    planPerformance: Array.from(planMap.values())
      .map((r) => ({ ...r, revenue: Number(r.revenue.toFixed(2)) }))
      .sort((a, b) => b.revenue - a.revenue),
  };
}

export function computeOutstandingBalancesReport(
  members: Member[],
  memberships: Membership[],
  todayIso: string
): OutstandingBalanceRow[] {
  return members
    .filter((m) => !m.isArchived && (Number(m.outstandingBalance) || 0) > 0)
    .map((m) => {
      const activeDue = memberships.find(
        (ms) => ms.memberId === m.id && ms.status === MembershipRecordStatus.ACTIVE && ms.dueDate
      );
      const dueDate = activeDue?.dueDate || m.membershipExpiryDate || m.joiningDate;
      const daysOverdue = dueDate && dueDate < todayIso ? Math.abs(diffDays(todayIso, dueDate)) : 0;
      const derivedStatus =
        m.membershipStatus === MembershipStatus.CANCELLED
          ? MembershipStatus.CANCELLED
          : deriveMemberMembershipStatus(m.membershipExpiryDate, todayIso, 7);
      return {
        memberId: m.id,
        memberCode: m.memberCode,
        fullName: m.fullName,
        phone: m.phone,
        currentPlanName: m.currentPlanName || 'No Plan',
        membershipExpiryDate: m.membershipExpiryDate || '',
        membershipStatus: derivedStatus,
        outstandingBalance: Number((Number(m.outstandingBalance) || 0).toFixed(2)),
        dueDate: dueDate || '',
        daysOverdue,
      };
    })
    .sort((a, b) => b.outstandingBalance - a.outstandingBalance);
}

export function computeExpiringMembershipsReport(
  members: Member[],
  todayIso: string,
  withinDays = 14
): ExpiringMembershipRow[] {
  return members
    .filter((m) => {
      if (m.isArchived || !m.membershipExpiryDate) return false;
      if (m.membershipStatus === MembershipStatus.CANCELLED) return false;
      const rem = diffDays(todayIso, m.membershipExpiryDate);
      return rem >= -30 && rem <= withinDays;
    })
    .map((m) => ({
      memberId: m.id,
      memberCode: m.memberCode,
      fullName: m.fullName,
      phone: m.phone,
      email: m.email || '',
      currentPlanName: m.currentPlanName || 'Plan',
      membershipExpiryDate: m.membershipExpiryDate || '',
      daysRemaining: diffDays(todayIso, m.membershipExpiryDate || todayIso),
      outstandingBalance: Number((Number(m.outstandingBalance) || 0).toFixed(2)),
    }))
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

export interface PlatformOverviewMetrics {
  totalGyms: number;
  activeGyms: number;
  suspendedGyms: number;
  trialGyms: number;
  expiredSubscriptions: number;
  newRegistrationsThisMonth: number;
  monthlyRecurringRevenue: number;
  verifiedSubscriptionCollections: number;
}

export function computePlatformOverview(
  gyms: Gym[],
  plans: SubscriptionPlan[],
  payments: SubscriptionPayment[],
  todayIso: string
): PlatformOverviewMetrics {
  const monthPrefix = todayIso.slice(0, 7);
  const planMap = new Map(plans.map((p) => [p.id, p]));

  let activeGyms = 0;
  let suspendedGyms = 0;
  let trialGyms = 0;
  let expiredSubscriptions = 0;
  let newRegistrationsThisMonth = 0;
  let monthlyRecurringRevenue = 0;

  for (const g of gyms) {
    if (g.accountStatus === AccountStatus.ACTIVE) activeGyms += 1;
    if (g.accountStatus === AccountStatus.SUSPENDED) suspendedGyms += 1;
    if (g.subscriptionStatus === SubscriptionStatus.TRIAL) trialGyms += 1;
    if (
      g.subscriptionStatus === SubscriptionStatus.EXPIRED ||
      (g.subscriptionEndAt && g.subscriptionEndAt.slice(0, 10) < todayIso)
    ) {
      expiredSubscriptions += 1;
    }
    if ((g.subscriptionStartAt || '').startsWith(monthPrefix)) {
      newRegistrationsThisMonth += 1;
    }
    if (
      g.accountStatus === AccountStatus.ACTIVE &&
      g.subscriptionStatus === SubscriptionStatus.ACTIVE
    ) {
      const plan = planMap.get(g.subscriptionPlanId);
      if (plan && plan.billingDurationMonths > 0) {
        monthlyRecurringRevenue += plan.price / plan.billingDurationMonths;
      }
    }
  }

  const verifiedSubscriptionCollections = payments
    .filter((p) => p.status === SubscriptionPaymentStatus.VERIFIED)
    .reduce((sum, p) => sum + p.amount, 0);

  return {
    totalGyms: gyms.length,
    activeGyms,
    suspendedGyms,
    trialGyms,
    expiredSubscriptions,
    newRegistrationsThisMonth,
    monthlyRecurringRevenue: Number(monthlyRecurringRevenue.toFixed(2)),
    verifiedSubscriptionCollections: Number(verifiedSubscriptionCollections.toFixed(2)),
  };
}
