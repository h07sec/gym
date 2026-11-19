import { describe, expect, it } from 'vitest';
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
  canStaffConfirmPayment,
  canStaffRecordPayment,
  canStaffViewPayments,
  deriveMemberPaymentDisplayStatus,
  isDuplicateUpiReference,
  isPotentialDuplicateCashPayment,
  validatePaymentConfirmationTransition,
} from '../lib/domain/payments';
import {
  computeDailyReport,
  computeDateRangeReport,
  computeExpiringMembershipsReport,
  computeGymDashboardMetrics,
  computeMonthlyReport,
  computeOutstandingBalancesReport,
  computePlatformOverview,
  computeWeeklyReport,
} from '../lib/domain/metrics';
import {
  buildDedupKey,
  buildReminderLogId,
  computeNextRetryState,
  computeRetryBackoffMinutes,
  evaluateDueReminders,
  isRetryDue,
  isWhatsAppReady,
  MAX_REMINDER_RETRIES,
  RETRY_BACKOFF_MINUTES,
} from '../lib/domain/reminders';
import {
  computeEffectiveAccessEndIso,
  evaluateGymSubscriptionAccess,
} from '../lib/domain/subscription';
import {
  exportMembersToCsv,
  parseAndValidateMemberCsv,
} from '../lib/domain/csv';
import {
  AccountStatus,
  DeliveryStatus,
  Gym,
  GymSettings,
  Member,
  MemberPayment,
  MemberPaymentDisplayStatus,
  MemberPaymentPurpose,
  MemberPaymentStatus,
  Membership,
  MembershipActionType,
  MembershipDurationType,
  MembershipRecordStatus,
  MembershipStatus,
  NotificationLog,
  PaymentMode,
  ReminderCategory,
  ReminderChannel,
  RenewalPolicy,
  StaffPermissions,
  SubscriptionPayment,
  SubscriptionPaymentStatus,
  SubscriptionPlan,
  SubscriptionStatus,
  UserRole,
} from '../types/gymos';

describe('GymOS Date & Membership Expiry Calculations', () => {
  it('handles month-end overflow on leap and non-leap years safely', () => {
    expect(addMonthsSafe('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsSafe('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonthsSafe('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonthsSafe('2024-02-29', 48)).toBe('2028-02-29');
    expect(addDaysSafe('2024-02-28', 2)).toBe('2024-03-01');
  });

  it('calculates expiry for all duration types', () => {
    expect(calculateMembershipExpiry('2025-01-31', MembershipDurationType.MONTHLY, 1)).toBe(
      '2025-02-28'
    );
    expect(calculateMembershipExpiry('2025-01-15', MembershipDurationType.QUARTERLY, 1)).toBe(
      '2025-04-15'
    );
    expect(calculateMembershipExpiry('2025-03-31', MembershipDurationType.HALF_YEARLY, 1)).toBe(
      '2025-09-30'
    );
    expect(calculateMembershipExpiry('2024-02-29', MembershipDurationType.YEARLY, 1)).toBe(
      '2025-02-28'
    );
    expect(calculateMembershipExpiry('2025-05-01', MembershipDurationType.CUSTOM_DAYS, 45)).toBe(
      '2025-06-15'
    );
  });

  it('extends from existing expiry when renewing an active membership', () => {
    const res = calculateRenewalDates({
      currentExpiryDate: '2025-06-20',
      todayIso: '2025-06-10',
      durationType: MembershipDurationType.MONTHLY,
      durationValue: 1,
      renewalPolicy: RenewalPolicy.START_TODAY_IF_EXPIRED,
      gracePeriodDays: 7,
    });
    expect(res.extendedFromActiveExpiry).toBe(true);
    expect(res.startDate).toBe('2025-06-20');
    expect(res.expiryDate).toBe('2025-07-20');
  });

  it('respects grace period vs START_TODAY_IF_EXPIRED for expired memberships', () => {
    const withinGrace = calculateRenewalDates({
      currentExpiryDate: '2025-06-05',
      todayIso: '2025-06-10',
      durationType: MembershipDurationType.MONTHLY,
      durationValue: 1,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
      gracePeriodDays: 7,
    });
    expect(withinGrace.extendedFromActiveExpiry).toBe(true);
    expect(withinGrace.startDate).toBe('2025-06-05');
    expect(withinGrace.expiryDate).toBe('2025-07-05');

    const beyondGrace = calculateRenewalDates({
      currentExpiryDate: '2025-06-01',
      todayIso: '2025-06-10',
      durationType: MembershipDurationType.MONTHLY,
      durationValue: 1,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
      gracePeriodDays: 7,
    });
    expect(beyondGrace.extendedFromActiveExpiry).toBe(false);
    expect(beyondGrace.startDate).toBe('2025-06-10');
    expect(beyondGrace.expiryDate).toBe('2025-07-10');

    const startTodayPolicy = calculateRenewalDates({
      currentExpiryDate: '2025-06-08',
      todayIso: '2025-06-10',
      durationType: MembershipDurationType.MONTHLY,
      durationValue: 1,
      renewalPolicy: RenewalPolicy.START_TODAY_IF_EXPIRED,
      gracePeriodDays: 7,
    });
    expect(startTodayPolicy.extendedFromActiveExpiry).toBe(false);
    expect(startTodayPolicy.startDate).toBe('2025-06-10');
  });

  it('derives ACTIVE, EXPIRING_SOON, EXPIRED, and NONE accurately', () => {
    expect(deriveMemberMembershipStatus(undefined, '2025-06-10')).toBe(MembershipStatus.NONE);
    expect(deriveMemberMembershipStatus('2025-06-09', '2025-06-10')).toBe(
      MembershipStatus.EXPIRED
    );
    expect(deriveMemberMembershipStatus('2025-06-10', '2025-06-10')).toBe(
      MembershipStatus.EXPIRING_SOON
    );
    expect(deriveMemberMembershipStatus('2025-06-17', '2025-06-10')).toBe(
      MembershipStatus.EXPIRING_SOON
    );
    expect(deriveMemberMembershipStatus('2025-06-18', '2025-06-10')).toBe(MembershipStatus.ACTIVE);
  });
});

describe('GymOS Manual Cash/UPI Payments & RBAC Verification', () => {
  const basePayment: MemberPayment = {
    id: 'pay_1',
    paymentCode: 'PAY-1001',
    gymId: 'gym_a',
    memberId: 'mem_1',
    memberName: 'Aarav Mehta',
    amount: 1500,
    paymentMode: PaymentMode.UPI,
    paymentPurpose: MemberPaymentPurpose.MEMBERSHIP,
    transactionReference: 'UTR44556677',
    paymentDate: '2025-06-10',
    status: MemberPaymentStatus.PENDING,
    recordedByUid: 'staff_1',
    recordedByName: 'Front Desk',
    createdAt: null,
    updatedAt: null,
  };

  it('blocks duplicate payment confirmation and requires UPI transaction reference', () => {
    expect(validatePaymentConfirmationTransition(basePayment).allowed).toBe(true);
    expect(
      validatePaymentConfirmationTransition({
        ...basePayment,
        status: MemberPaymentStatus.CONFIRMED,
      }).allowed
    ).toBe(false);
    expect(
      validatePaymentConfirmationTransition({
        ...basePayment,
        status: MemberPaymentStatus.REJECTED,
      }).allowed
    ).toBe(false);
    expect(
      validatePaymentConfirmationTransition({
        ...basePayment,
        transactionReference: '   ',
      }).allowed
    ).toBe(false);
  });

  it('detects duplicate UPI transaction references case-insensitively while ignoring rejected payments', () => {
    const existing: MemberPayment[] = [
      { ...basePayment, status: MemberPaymentStatus.CONFIRMED },
      {
        ...basePayment,
        id: 'pay_2',
        transactionReference: 'UTR9999',
        status: MemberPaymentStatus.REJECTED,
      },
    ];
    expect(isDuplicateUpiReference(existing, 'utr44556677')).toBe(true);
    expect(isDuplicateUpiReference(existing, 'UTR9999')).toBe(false);
    expect(isDuplicateUpiReference(existing, 'UTR8888')).toBe(false);
  });

  it('calculates remaining outstanding balance without going negative', () => {
    expect(
      calculateOutstandingAfterPayment(2000, 1200, MemberPaymentPurpose.BALANCE_SETTLEMENT)
    ).toBe(800);
    expect(calculateOutstandingAfterPayment(500, 1000, MemberPaymentPurpose.ADVANCE)).toBe(0);
  });

  it('enforces payment recording, viewing, and confirmation authority by role and 8-key permissions', () => {
    const basePerms: StaffPermissions = {
      canViewReports: false,
      canViewPayments: false,
      canRecordPayments: false,
      canManagePlans: false,
      canConfirmPayments: false,
      canDeleteMembers: false,
      canManageReminders: false,
      canManageAttendance: false,
    };

    expect(canStaffConfirmPayment(UserRole.GYM_OWNER, null)).toBe(true);
    expect(canStaffConfirmPayment(UserRole.GYM_RECEPTIONIST, basePerms)).toBe(false);
    expect(
      canStaffConfirmPayment(UserRole.GYM_RECEPTIONIST, {
        ...basePerms,
        canConfirmPayments: true,
      })
    ).toBe(true);

    expect(canStaffRecordPayment(UserRole.GYM_OWNER, null)).toBe(true);
    expect(canStaffRecordPayment(UserRole.GYM_MANAGER, basePerms)).toBe(true);
    expect(canStaffRecordPayment(UserRole.GYM_TRAINER, basePerms)).toBe(false);
    expect(
      canStaffRecordPayment(UserRole.GYM_TRAINER, {
        ...basePerms,
        canRecordPayments: true,
      })
    ).toBe(true);

    expect(canStaffViewPayments(UserRole.GYM_TRAINER, basePerms)).toBe(false);
    expect(
      canStaffViewPayments(UserRole.GYM_TRAINER, {
        ...basePerms,
        canViewPayments: true,
      })
    ).toBe(true);
    expect(
      canStaffViewPayments(UserRole.GYM_RECEPTIONIST, {
        ...basePerms,
        canViewPayments: false,
        canRecordPayments: true,
      })
    ).toBe(true);
  });

  it('calculates net plan amounts, detects duplicate cash payments, and derives payment display statuses', () => {
    expect(calculateNetPlanAmount(2500, 300)).toEqual({
      grossPrice: 2500,
      discount: 300,
      netPrice: 2200,
    });
    expect(calculateNetPlanAmount(1000, 1500)).toEqual({
      grossPrice: 1000,
      discount: 1000,
      netPrice: 0,
    });

    const cashPayment: MemberPayment = {
      ...basePayment,
      id: 'pay_cash_1',
      paymentMode: PaymentMode.CASH,
      transactionReference: undefined,
      amount: 1500,
      paymentDate: '2025-06-10',
      status: MemberPaymentStatus.CONFIRMED,
    };
    expect(isPotentialDuplicateCashPayment([cashPayment], 'mem_1', 1500, '2025-06-10')).toBe(true);
    expect(isPotentialDuplicateCashPayment([cashPayment], 'mem_1', 1500, '2025-06-11')).toBe(false);
    expect(
      isPotentialDuplicateCashPayment(
        [{ ...cashPayment, status: MemberPaymentStatus.REJECTED }],
        'mem_1',
        1500,
        '2025-06-10'
      )
    ).toBe(false);

    const member: Member = {
      id: 'mem_1',
      gymId: 'gym_a',
      memberCode: 'M-001',
      fullName: 'Aarav Mehta',
      phone: '9876543210',
      joiningDate: '2025-06-01',
      membershipExpiryDate: '2025-07-01',
      membershipStatus: MembershipStatus.ACTIVE,
      outstandingBalance: 1000,
      reminderOptOut: false,
      isArchived: false,
      createdAt: null,
      updatedAt: null,
    };
    const membership: Membership = {
      id: 'ms_1',
      gymId: 'gym_a',
      memberId: 'mem_1',
      memberName: 'Aarav Mehta',
      planId: 'plan_1',
      planName: 'Monthly',
      actionType: MembershipActionType.INITIAL,
      startDate: '2025-06-01',
      expiryDate: '2025-07-01',
      planPrice: 2000,
      amountPaid: 1000,
      balanceDue: 1000,
      dueDate: '2025-06-15',
      status: MembershipRecordStatus.ACTIVE,
      recordedByUid: 'u1',
      createdAt: null,
      updatedAt: null,
    };

    expect(
      deriveMemberPaymentDisplayStatus(member, [basePayment], [membership], '2025-06-10')
    ).toBe(MemberPaymentDisplayStatus.PENDING_VERIFICATION);
    expect(
      deriveMemberPaymentDisplayStatus(
        { ...member, outstandingBalance: 0 },
        [],
        [membership],
        '2025-06-10'
      )
    ).toBe(MemberPaymentDisplayStatus.PAID);
    expect(
      deriveMemberPaymentDisplayStatus(member, [], [membership], '2025-06-10')
    ).toBe(MemberPaymentDisplayStatus.PARTIALLY_PAID);
    expect(
      deriveMemberPaymentDisplayStatus(member, [], [membership], '2025-06-18')
    ).toBe(MemberPaymentDisplayStatus.OVERDUE);
    expect(
      deriveMemberPaymentDisplayStatus(
        member,
        [],
        [{ ...membership, amountPaid: 0 }],
        '2025-06-10'
      )
    ).toBe(MemberPaymentDisplayStatus.UNPAID);
  });
});

describe('GymOS Real Dashboard & Platform Metrics', () => {
  const members: Member[] = [
    {
      id: 'm1',
      gymId: 'g1',
      memberCode: 'GYM-01',
      fullName: 'Active Member',
      phone: '9876543210',
      joiningDate: '2025-06-02',
      membershipExpiryDate: '2025-07-02',
      membershipStatus: MembershipStatus.ACTIVE,
      outstandingBalance: 500,
      reminderOptOut: false,
      isArchived: false,
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'm2',
      gymId: 'g1',
      memberCode: 'GYM-02',
      fullName: 'Expiring Member',
      phone: '9876543211',
      joiningDate: '2025-05-12',
      membershipExpiryDate: '2025-06-12',
      membershipStatus: MembershipStatus.EXPIRING_SOON,
      outstandingBalance: 0,
      reminderOptOut: false,
      isArchived: false,
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'm3',
      gymId: 'g1',
      memberCode: 'GYM-03',
      fullName: 'Archived Member',
      phone: '9876543212',
      joiningDate: '2025-06-05',
      membershipExpiryDate: '2025-06-30',
      membershipStatus: MembershipStatus.ACTIVE,
      outstandingBalance: 999,
      reminderOptOut: false,
      isArchived: true,
      createdAt: null,
      updatedAt: null,
    },
  ];

  const payments: MemberPayment[] = [
    {
      id: 'p1',
      paymentCode: 'PAY-1',
      gymId: 'g1',
      memberId: 'm1',
      memberName: 'Active Member',
      amount: 1500,
      paymentMode: PaymentMode.CASH,
      paymentPurpose: MemberPaymentPurpose.MEMBERSHIP,
      paymentDate: '2025-06-10',
      status: MemberPaymentStatus.CONFIRMED,
      recordedByUid: 'u1',
      recordedByName: 'Owner',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'p2',
      paymentCode: 'PAY-2',
      gymId: 'g1',
      memberId: 'm2',
      memberName: 'Expiring Member',
      amount: 2000,
      paymentMode: PaymentMode.UPI,
      paymentPurpose: MemberPaymentPurpose.RENEWAL,
      paymentDate: '2025-06-10',
      status: MemberPaymentStatus.PENDING,
      recordedByUid: 'u1',
      recordedByName: 'Front Desk',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'p3',
      paymentCode: 'PAY-3',
      gymId: 'g1',
      memberId: 'm2',
      memberName: 'Expiring Member',
      amount: 1000,
      paymentMode: PaymentMode.UPI,
      paymentPurpose: MemberPaymentPurpose.BALANCE_SETTLEMENT,
      paymentDate: '2025-06-03',
      status: MemberPaymentStatus.CONFIRMED,
      recordedByUid: 'u1',
      recordedByName: 'Owner',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const memberships: Membership[] = [
    {
      id: 'ms1',
      gymId: 'g1',
      memberId: 'm2',
      memberName: 'Expiring Member',
      planId: 'pl1',
      planName: 'Monthly Pro',
      actionType: MembershipActionType.RENEWAL,
      startDate: '2025-06-03',
      expiryDate: '2025-07-03',
      planPrice: 2000,
      amountPaid: 2000,
      balanceDue: 0,
      status: MembershipRecordStatus.ACTIVE,
      recordedByUid: 'u1',
      createdAt: null,
      updatedAt: null,
    },
  ];

  it('includes ONLY confirmed payments in revenue KPIs and excludes archived members', () => {
    const dash = computeGymDashboardMetrics(members, payments, memberships, '2025-06-10');
    expect(dash.totalMembers).toBe(2);
    expect(dash.activeMembers).toBe(2);
    expect(dash.expiringSoonMemberships).toBe(1);
    expect(dash.todaysCollections).toBe(1500);
    expect(dash.monthlyCollections).toBe(2500);
    expect(dash.pendingPaymentsCount).toBe(1);
    expect(dash.pendingPaymentsAmount).toBe(2000);
    expect(dash.totalOutstandingFees).toBe(500);
    expect(dash.newMembersThisMonth).toBe(1);
    expect(dash.renewalsThisMonth).toBe(1);

    const daily = computeDailyReport(members, payments, '2025-06-10');
    expect(daily.cashCollections).toBe(1500);
    expect(daily.upiCollections).toBe(0);
    expect(daily.totalConfirmedCollections).toBe(1500);
    expect(daily.pendingPaymentsAmount).toBe(2000);

    const monthly = computeMonthlyReport(members, payments, memberships, '2025-06');
    expect(monthly.totalRevenue).toBe(2500);
    expect(monthly.cashRevenue).toBe(1500);
    expect(monthly.upiRevenue).toBe(1000);
  });

  it('computes platform MRR from active gyms and verified subscription revenue', () => {
    const plans: SubscriptionPlan[] = [
      {
        id: 'p_qtr',
        name: 'Quarterly',
        billingDurationMonths: 3,
        price: 3000,
        currency: '₹',
        maxStaff: 10,
        maxMembers: 500,
        trialDays: 14,
        features: [],
        isActive: true,
        createdAt: null,
        updatedAt: null,
      },
    ];
    const gyms: Gym[] = [
      {
        id: 'g1',
        name: 'Iron Forge',
        ownerUid: 'u1',
        ownerName: 'Owner 1',
        email: 'o1@example.com',
        phone: '9999999999',
        accountStatus: AccountStatus.ACTIVE,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        subscriptionPlanId: 'p_qtr',
        subscriptionPlanName: 'Quarterly',
        subscriptionStartAt: '2025-06-01',
        subscriptionEndAt: '2025-09-01',
        gracePeriodDays: 7,
        renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
        createdAt: null,
        updatedAt: null,
      },
      {
        id: 'g2',
        name: 'Suspended Gym',
        ownerUid: 'u2',
        ownerName: 'Owner 2',
        email: 'o2@example.com',
        phone: '8888888888',
        accountStatus: AccountStatus.SUSPENDED,
        subscriptionStatus: SubscriptionStatus.EXPIRED,
        subscriptionPlanId: 'p_qtr',
        subscriptionPlanName: 'Quarterly',
        subscriptionStartAt: '2025-01-01',
        subscriptionEndAt: '2025-04-01',
        gracePeriodDays: 7,
        renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
        createdAt: null,
        updatedAt: null,
      },
    ];
    const subPayments: SubscriptionPayment[] = [
      {
        id: 'sp1',
        gymId: 'g1',
        gymName: 'Iron Forge',
        ownerUid: 'u1',
        planId: 'p_qtr',
        planName: 'Quarterly',
        amount: 3000,
        paymentMode: PaymentMode.UPI,
        idempotencyKey: 'idem1',
        paymentDate: '2025-06-01',
        periodStart: '2025-06-01',
        periodEnd: '2025-09-01',
        status: SubscriptionPaymentStatus.VERIFIED,
        recordedByUid: 'admin',
        extensionApplied: true,
        createdAt: null,
        updatedAt: null,
      },
      {
        id: 'sp2',
        gymId: 'g2',
        gymName: 'Suspended Gym',
        ownerUid: 'u2',
        planId: 'p_qtr',
        planName: 'Quarterly',
        amount: 3000,
        paymentMode: PaymentMode.CASH,
        idempotencyKey: 'idem2',
        paymentDate: '2025-06-05',
        periodStart: '2025-06-05',
        periodEnd: '2025-09-05',
        status: SubscriptionPaymentStatus.RECORDED,
        recordedByUid: 'admin',
        extensionApplied: false,
        createdAt: null,
        updatedAt: null,
      },
    ];

    const overview = computePlatformOverview(gyms, plans, subPayments, '2025-06-10');
    expect(overview.totalGyms).toBe(2);
    expect(overview.activeGyms).toBe(1);
    expect(overview.suspendedGyms).toBe(1);
    expect(overview.monthlyRecurringRevenue).toBe(1000);
    expect(overview.verifiedSubscriptionCollections).toBe(3000);
  });

  it('computes weekly, custom date-range, outstanding balances, and expiring membership reports', () => {
    const dueMemberships: Membership[] = [
      ...memberships,
      {
        id: 'ms2',
        gymId: 'g1',
        memberId: 'm1',
        memberName: 'Active Member',
        planId: 'pl1',
        planName: 'Monthly Pro',
        actionType: MembershipActionType.INITIAL,
        startDate: '2025-06-02',
        expiryDate: '2025-07-02',
        planPrice: 2000,
        amountPaid: 1500,
        balanceDue: 500,
        dueDate: '2025-06-05',
        status: MembershipRecordStatus.ACTIVE,
        recordedByUid: 'u1',
        createdAt: null,
        updatedAt: null,
      },
    ];

    const weekly = computeWeeklyReport(members, payments, dueMemberships, '2025-06-10');
    expect(weekly.startDate).toBe('2025-06-04');
    expect(weekly.endDate).toBe('2025-06-10');
    expect(weekly.totalRevenue).toBe(1500);
    expect(weekly.pendingPaymentsCount).toBe(1);

    const range = computeDateRangeReport(
      members,
      payments,
      dueMemberships,
      '2025-06-01',
      '2025-06-10'
    );
    expect(range.totalRevenue).toBe(2500);
    expect(range.cashRevenue).toBe(1500);
    expect(range.upiRevenue).toBe(1000);
    expect(range.newMembers).toBe(1);
    expect(range.renewals).toBe(1);

    const outstanding = computeOutstandingBalancesReport(members, dueMemberships, '2025-06-10');
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0].memberId).toBe('m1');
    expect(outstanding[0].outstandingBalance).toBe(500);
    expect(outstanding[0].daysOverdue).toBe(5);

    const expiring = computeExpiringMembershipsReport(members, '2025-06-10', 14);
    expect(expiring.some((row) => row.memberId === 'm2' && row.daysRemaining === 2)).toBe(true);
    expect(expiring.some((row) => row.memberId === 'm1')).toBe(false);
  });
});

describe('GymOS Subscription Access & Grace Period Enforcement', () => {
  const baseGym = {
    accountStatus: AccountStatus.ACTIVE,
    subscriptionStatus: SubscriptionStatus.ACTIVE,
    subscriptionEndAt: '2025-06-10',
    gracePeriodDays: 7,
  };

  it('computes effective access date and detects grace period vs expired lock', () => {
    expect(computeEffectiveAccessEndIso('2025-06-10T00:00:00Z', 7)).toBe('2025-06-17');

    const active = evaluateGymSubscriptionAccess(baseGym, '2025-06-05');
    expect(active.isLocked).toBe(false);
    expect(active.inGracePeriod).toBe(false);

    const inGrace = evaluateGymSubscriptionAccess(baseGym, '2025-06-15');
    expect(inGrace.isLocked).toBe(false);
    expect(inGrace.inGracePeriod).toBe(true);
    expect(inGrace.reason).toBe('ACTIVE');

    const pastGrace = evaluateGymSubscriptionAccess(baseGym, '2025-06-18');
    expect(pastGrace.isLocked).toBe(true);
    expect(pastGrace.reason).toBe('EXPIRED');

    const suspended = evaluateGymSubscriptionAccess(
      { ...baseGym, accountStatus: AccountStatus.SUSPENDED },
      '2025-06-05'
    );
    expect(suspended.isLocked).toBe(true);
    expect(suspended.reason).toBe('SUSPENDED');

    const pending = evaluateGymSubscriptionAccess(
      { ...baseGym, subscriptionStatus: SubscriptionStatus.PENDING },
      '2025-06-05'
    );
    expect(pending.isLocked).toBe(true);
    expect(pending.reason).toBe('PENDING_VERIFICATION');

    const cancelled = evaluateGymSubscriptionAccess(
      { ...baseGym, subscriptionStatus: SubscriptionStatus.CANCELLED },
      '2025-06-05'
    );
    expect(cancelled.isLocked).toBe(true);
    expect(cancelled.reason).toBe('CANCELLED');
  });
});

describe('GymOS Reminder Automation, Deduplication, Opt-Out & CSV', () => {
  const settings: GymSettings = {
    gymId: 'g1',
    gracePeriodDays: 7,
    renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
    reminderDaysBefore: [7, 3, 1],
    sendOnExpiryDay: true,
    sendAfterExpiryDays: [3],
    emailEnabled: true,
    inAppEnabled: true,
    whatsappEnabled: true,
    whatsappPhoneNumberId: '',
    whatsappApprovedTemplate: '',
    currencySymbol: '₹',
    updatedAt: null,
  };

  it('keeps WhatsApp Cloud API disabled unless official credentials & template are configured', () => {
    expect(isWhatsAppReady(settings)).toBe(false);
    expect(
      isWhatsAppReady({
        ...settings,
        whatsappPhoneNumberId: '123456789',
        whatsappApprovedTemplate: 'gym_renewal_v1',
      })
    ).toBe(true);
  });

  it('respects opt-out flags and deduplication keys during reminder evaluation', () => {
    const members: Member[] = [
      {
        id: 'm1',
        gymId: 'g1',
        memberCode: 'GYM-01',
        fullName: 'Riya',
        phone: '9999999999',
        email: 'riya@example.com',
        joiningDate: '2025-05-01',
        membershipExpiryDate: '2025-06-13',
        membershipStatus: MembershipStatus.EXPIRING_SOON,
        outstandingBalance: 0,
        reminderOptOut: false,
        isArchived: false,
        createdAt: null,
        updatedAt: null,
      },
      {
        id: 'm2',
        gymId: 'g1',
        memberCode: 'GYM-02',
        fullName: 'Karan OptOut',
        phone: '8888888888',
        email: 'karan@example.com',
        joiningDate: '2025-05-01',
        membershipExpiryDate: '2025-06-10',
        membershipStatus: MembershipStatus.EXPIRING_SOON,
        outstandingBalance: 0,
        reminderOptOut: true,
        isArchived: false,
        createdAt: null,
        updatedAt: null,
      },
    ];

    const alreadySentKey = buildDedupKey(
      'm1',
      'EXPIRING_IN_3_DAYS',
      '2025-06-10',
      ReminderChannel.EMAIL
    );
    const existingLogs: NotificationLog[] = [
      {
        id: 'log1',
        gymId: 'g1',
        memberId: 'm1',
        memberName: 'Riya',
        recipient: 'riya@example.com',
        channel: ReminderChannel.EMAIL,
        template: 'EXPIRING_IN_3_DAYS',
        dedupKey: alreadySentKey,
        scheduledDate: '2025-06-10',
        deliveryStatus: DeliveryStatus.SENT,
        retryCount: 0,
        createdAt: null,
        updatedAt: null,
      },
    ];

    const candidates = evaluateDueReminders(members, settings, existingLogs, '2025-06-10');
    expect(candidates.some((c) => c.dedupKey === alreadySentKey)).toBe(false);
    expect(
      candidates.some(
        (c) => c.memberId === 'm1' && c.channel === ReminderChannel.IN_APP && !c.skippedOptOut
      )
    ).toBe(true);
    expect(
      candidates.filter((c) => c.memberId === 'm2').every((c) => c.skippedOptOut === true)
    ).toBe(true);
  });

  it('evaluates upcoming/overdue payment reminders and gym owner subscription expiry alerts', () => {
    const members: Member[] = [
      {
        id: 'm_due',
        gymId: 'g1',
        memberCode: 'GYM-10',
        fullName: 'Vikram Rao',
        phone: '9988776655',
        email: 'vikram@example.com',
        joiningDate: '2025-06-01',
        membershipExpiryDate: '2025-07-01',
        membershipStatus: MembershipStatus.ACTIVE,
        outstandingBalance: 1200,
        reminderOptOut: false,
        isArchived: false,
        createdAt: null,
        updatedAt: null,
      },
      {
        id: 'm_overdue',
        gymId: 'g1',
        memberCode: 'GYM-11',
        fullName: 'Sneha Nair',
        phone: '9988776644',
        email: 'sneha@example.com',
        joiningDate: '2025-05-01',
        membershipExpiryDate: '2025-06-01',
        membershipStatus: MembershipStatus.EXPIRED,
        outstandingBalance: 800,
        reminderOptOut: false,
        isArchived: false,
        createdAt: null,
        updatedAt: null,
      },
    ];
    const memberships: Membership[] = [
      {
        id: 'ms_due',
        gymId: 'g1',
        memberId: 'm_due',
        memberName: 'Vikram Rao',
        planId: 'p1',
        planName: 'Monthly',
        actionType: MembershipActionType.INITIAL,
        startDate: '2025-06-01',
        expiryDate: '2025-07-01',
        planPrice: 2000,
        amountPaid: 800,
        balanceDue: 1200,
        dueDate: '2025-06-12',
        status: MembershipRecordStatus.ACTIVE,
        recordedByUid: 'u1',
        createdAt: null,
        updatedAt: null,
      },
      {
        id: 'ms_overdue',
        gymId: 'g1',
        memberId: 'm_overdue',
        memberName: 'Sneha Nair',
        planId: 'p1',
        planName: 'Monthly',
        actionType: MembershipActionType.INITIAL,
        startDate: '2025-05-01',
        expiryDate: '2025-06-01',
        planPrice: 1500,
        amountPaid: 700,
        balanceDue: 800,
        dueDate: '2025-06-07',
        status: MembershipRecordStatus.ACTIVE,
        recordedByUid: 'u1',
        createdAt: null,
        updatedAt: null,
      },
    ];
    const gym: Gym = {
      id: 'g1',
      name: 'Pulse Athletics',
      ownerUid: 'owner_1',
      ownerName: 'Arjun',
      email: 'arjun@pulse.test',
      phone: '9876543210',
      accountStatus: AccountStatus.ACTIVE,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      subscriptionPlanId: 'plan_1',
      subscriptionPlanName: 'Monthly Standard',
      subscriptionStartAt: '2025-05-13',
      subscriptionEndAt: '2025-06-13',
      gracePeriodDays: 7,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
      createdAt: null,
      updatedAt: null,
    };

    const candidates = evaluateDueReminders(
      members,
      {
        ...settings,
        paymentRemindersEnabled: true,
        upcomingPaymentReminderDays: 3,
        overduePaymentReminderDays: [1, 3, 7],
        ownerSubReminderDays: [7, 3, 1, 0],
      },
      [],
      '2025-06-10',
      { memberships, gym }
    );

    expect(
      candidates.some(
        (c) =>
          c.memberId === 'm_due' &&
          c.category === ReminderCategory.UPCOMING_PAYMENT &&
          c.template === 'PAYMENT_DUE_IN_2_DAYS'
      )
    ).toBe(true);
    expect(
      candidates.some(
        (c) =>
          c.memberId === 'm_overdue' &&
          c.category === ReminderCategory.OVERDUE_PAYMENT &&
          c.template === 'PAYMENT_OVERDUE_3_DAYS'
      )
    ).toBe(true);
    expect(
      candidates.some(
        (c) =>
          c.memberId === 'owner_g1' &&
          c.category === ReminderCategory.SUBSCRIPTION_EXPIRY &&
          c.template === 'OWNER_SUB_EXPIRING_IN_3_DAYS'
      )
    ).toBe(true);
  });

  it('caps reminder retries at MAX_REMINDER_RETRIES and computes exponential nextRetryAt backoff', () => {
    expect(RETRY_BACKOFF_MINUTES).toEqual([15, 60, 240]);
    expect(computeRetryBackoffMinutes(0)).toBe(15);
    expect(computeRetryBackoffMinutes(1)).toBe(60);
    expect(computeRetryBackoffMinutes(2)).toBe(240);

    const key = buildDedupKey('m1', 'EXPIRING_TODAY', '2025-06-10', ReminderChannel.EMAIL);
    expect(buildReminderLogId(key)).toBe(buildReminderLogId(key));
    expect(buildReminderLogId(key)).toMatch(/^nlog_[0-9a-f]{16}$/);

    const baseNow = Date.parse('2025-06-10T10:00:00.000Z');
    const maxedLog: NotificationLog = {
      id: 'l1',
      gymId: 'g1',
      memberId: 'm1',
      memberName: 'Riya',
      recipient: 'riya@example.com',
      channel: ReminderChannel.EMAIL,
      template: 'EXPIRING_TODAY',
      dedupKey: 'k1',
      scheduledDate: '2025-06-10',
      deliveryStatus: DeliveryStatus.RETRY_SCHEDULED,
      retryCount: MAX_REMINDER_RETRIES,
      createdAt: null,
      updatedAt: null,
    };
    const nextMaxed = computeNextRetryState(maxedLog, false, 'SMTP timeout', baseNow);
    expect(nextMaxed.canRetry).toBe(false);
    expect(nextMaxed.nextStatus).toBe(DeliveryStatus.FAILED);
    expect(nextMaxed.nextRetryAt).toBe('');

    const retryableLog: NotificationLog = { ...maxedLog, retryCount: 0 };
    const nextRetry1 = computeNextRetryState(retryableLog, false, 'Temporary error', baseNow);
    expect(nextRetry1.canRetry).toBe(true);
    expect(nextRetry1.nextRetryCount).toBe(1);
    expect(nextRetry1.nextStatus).toBe(DeliveryStatus.RETRY_SCHEDULED);
    expect(nextRetry1.nextRetryAt).toBe('2025-06-10T11:00:00.000Z'); // +60m

    const futureRetryLog: NotificationLog = {
      ...retryableLog,
      retryCount: 1,
      nextRetryAt: nextRetry1.nextRetryAt,
    };
    expect(isRetryDue(futureRetryLog, '2025-06-10T10:30:00.000Z')).toBe(false);
    expect(isRetryDue(futureRetryLog, '2025-06-10T11:00:00.000Z')).toBe(true);
    expect(isRetryDue(maxedLog, '2025-06-10T11:00:00.000Z')).toBe(false);

    const succeeded = computeNextRetryState(retryableLog, true, undefined, baseNow);
    expect(succeeded.canRetry).toBe(false);
    expect(succeeded.nextRetryCount).toBe(1);
    expect(succeeded.nextStatus).toBe(DeliveryStatus.SENT);
    expect(succeeded.nextRetryAt).toBe('');
  });

  it('validates CSV rows, detects duplicate phones, and exports sanitized CSV', () => {
    const existing: Member[] = [
      {
        id: 'm1',
        gymId: 'g1',
        memberCode: 'GYM-01',
        fullName: 'Existing User',
        phone: '+91 98765-43210',
        joiningDate: '2025-01-01',
        membershipStatus: MembershipStatus.NONE,
        outstandingBalance: 0,
        reminderOptOut: false,
        isArchived: false,
        createdAt: null,
        updatedAt: null,
      },
    ];
    const csv = [
      'Full Name,Phone,Email,Gender,Joining Date,Notes',
      'Neha Sharma,9123456789,neha@example.com,Female,2025-06-01,"Morning batch, VIP"',
      'Duplicate Existing,919876543210,dup@example.com,Male,2025-06-01,Matches existing +91 number',
      'X,123,bad-email,Other,2025-06-01,Invalid row',
    ].join('\n');

    const parsed = parseAndValidateMemberCsv(csv, existing, '2025-06-10');
    expect(parsed).toHaveLength(3);
    expect(parsed[0].isValid).toBe(true);
    expect(parsed[0].notes).toBe('Morning batch, VIP');
    expect(parsed[1].isDuplicate).toBe(true);
    expect(parsed[1].isValid).toBe(false);
    expect(parsed[2].isValid).toBe(false);
    expect(parsed[2].errors.length).toBeGreaterThanOrEqual(2);

    // Intra-file duplicate detection
    const dupCsv = [
      'Full Name,Phone,Email',
      'First Person,9988776655,first@example.com',
      'Second Person,9988776655,second@example.com',
    ].join('\n');
    const dupParsed = parseAndValidateMemberCsv(dupCsv, existing, '2025-06-10');
    expect(dupParsed[0].isValid).toBe(true);
    expect(dupParsed[1].isDuplicate).toBe(true);
    expect(dupParsed[1].isValid).toBe(false);

    const exported = exportMembersToCsv(existing);
    expect(exported).toContain('GYM-01');
    expect(exported).toContain('Existing User');
  });
});
