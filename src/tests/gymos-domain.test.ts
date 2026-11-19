import { describe, expect, it } from 'vitest';
import {
  addDaysSafe,
  addMonthsSafe,
  calculateMembershipExpiry,
  calculateRenewalDates,
  deriveMemberMembershipStatus,
} from '../lib/domain/dates';
import {
  calculateOutstandingAfterPayment,
  canStaffConfirmPayment,
  isDuplicateUpiReference,
  validatePaymentConfirmationTransition,
} from '../lib/domain/payments';
import {
  computeDailyReport,
  computeGymDashboardMetrics,
  computeMonthlyReport,
  computePlatformOverview,
} from '../lib/domain/metrics';
import {
  buildDedupKey,
  computeNextRetryState,
  evaluateDueReminders,
  isWhatsAppReady,
  MAX_REMINDER_RETRIES,
} from '../lib/domain/reminders';
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
  MemberPaymentPurpose,
  MemberPaymentStatus,
  Membership,
  MembershipActionType,
  MembershipDurationType,
  MembershipRecordStatus,
  MembershipStatus,
  NotificationLog,
  PaymentMode,
  ReminderChannel,
  RenewalPolicy,
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

  it('enforces payment confirmation authority by role and staff permission', () => {
    expect(canStaffConfirmPayment(UserRole.GYM_OWNER, null)).toBe(true);
    expect(
      canStaffConfirmPayment(UserRole.GYM_RECEPTIONIST, {
        canViewReports: false,
        canManagePlans: false,
        canConfirmPayments: false,
        canDeleteMembers: false,
        canManageReminders: false,
      })
    ).toBe(false);
    expect(
      canStaffConfirmPayment(UserRole.GYM_RECEPTIONIST, {
        canViewReports: false,
        canManagePlans: false,
        canConfirmPayments: true,
        canDeleteMembers: false,
        canManageReminders: false,
      })
    ).toBe(true);
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

  it('caps reminder retries at MAX_REMINDER_RETRIES', () => {
    const log: NotificationLog = {
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
    const next = computeNextRetryState(log);
    expect(next.canRetry).toBe(false);
    expect(next.nextStatus).toBe(DeliveryStatus.FAILED);
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
