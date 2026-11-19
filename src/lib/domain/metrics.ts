import {
  AccountStatus,
  Gym,
  Member,
  MemberPayment,
  MemberPaymentStatus,
  Membership,
  MembershipActionType,
  MembershipStatus,
  PaymentMode,
  SubscriptionPayment,
  SubscriptionPaymentStatus,
  SubscriptionPlan,
  SubscriptionStatus,
} from '../../types/gymos';
import { deriveMemberMembershipStatus } from './dates';

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
    const label = dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

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
  const planMap = new Map<string, { planName: string; count: number; revenue: number }>();
  for (const ms of monthMemberships) {
    const prev = planMap.get(ms.planName) ?? { planName: ms.planName, count: 0, revenue: 0 };
    prev.count += 1;
    prev.revenue += ms.amountPaid;
    planMap.set(ms.planName, prev);
  }

  return {
    monthKey,
    totalRevenue: Number((cashRevenue + upiRevenue).toFixed(2)),
    cashRevenue: Number(cashRevenue.toFixed(2)),
    upiRevenue: Number(upiRevenue.toFixed(2)),
    newMembers: members.filter((m) => !m.isArchived && m.joiningDate.startsWith(monthKey)).length,
    renewals: monthMemberships.filter((m) => m.actionType === MembershipActionType.RENEWAL).length,
    cancellations: memberships.filter(
      (m) => m.status === 'CANCELLED' && m.startDate.startsWith(monthKey)
    ).length,
    outstandingBalances: Number(
      members
        .filter((m) => !m.isArchived)
        .reduce((s, m) => s + Math.max(0, m.outstandingBalance), 0)
        .toFixed(2)
    ),
    planPerformance: Array.from(planMap.values()).sort((a, b) => b.revenue - a.revenue),
  };
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
