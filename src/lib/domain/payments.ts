import {
  Member,
  MemberPayment,
  MemberPaymentDisplayStatus,
  MemberPaymentPurpose,
  MemberPaymentStatus,
  Membership,
  MembershipRecordStatus,
  PaymentMode,
  StaffPermissions,
  UserRole,
} from '../../types/gymos';

export function calculateNetPlanAmount(
  planPrice: number,
  discountAmount?: number
): { grossPrice: number; discount: number; netPrice: number } {
  const grossPrice = Math.max(0, Number(planPrice) || 0);
  const rawDiscount = Math.max(0, Number(discountAmount) || 0);
  const discount = Math.min(grossPrice, Number(rawDiscount.toFixed(2)));
  const netPrice = Math.max(0, Number((grossPrice - discount).toFixed(2)));
  return { grossPrice, discount, netPrice };
}

export function calculateOutstandingAfterPayment(
  currentOutstanding: number,
  paymentAmount: number,
  purpose: MemberPaymentPurpose
): number {
  const safeOutstanding = Math.max(0, Number(currentOutstanding) || 0);
  const safeAmount = Math.max(0, Number(paymentAmount) || 0);
  if (purpose === MemberPaymentPurpose.ADVANCE) {
    return Math.max(0, Number((safeOutstanding - safeAmount).toFixed(2)));
  }
  return Math.max(0, Number((safeOutstanding - safeAmount).toFixed(2)));
}

export function deriveMemberPaymentDisplayStatus(
  member: Member,
  memberPayments: MemberPayment[],
  memberMemberships: Membership[],
  todayIso: string
): MemberPaymentDisplayStatus {
  const hasPending = memberPayments.some(
    (p) => p.memberId === member.id && p.status === MemberPaymentStatus.PENDING
  );
  if (hasPending) {
    return MemberPaymentDisplayStatus.PENDING_VERIFICATION;
  }

  const outstanding = Math.max(0, Number(member.outstandingBalance) || 0);
  if (outstanding <= 0) {
    return MemberPaymentDisplayStatus.PAID;
  }

  const activeMemberships = memberMemberships.filter(
    (ms) =>
      ms.memberId === member.id &&
      ms.status === MembershipRecordStatus.ACTIVE &&
      ms.balanceDue > 0
  );
  const hasOverdueMembership = activeMemberships.some(
    (ms) => Boolean(ms.dueDate && ms.dueDate < todayIso)
  );
  const hasConfirmedTowardPlan =
    activeMemberships.some((ms) => ms.amountPaid > 0) ||
    memberPayments.some(
      (p) => p.memberId === member.id && p.status === MemberPaymentStatus.CONFIRMED
    );

  if (hasOverdueMembership || (member.membershipExpiryDate && member.membershipExpiryDate < todayIso)) {
    return MemberPaymentDisplayStatus.OVERDUE;
  }

  if (hasConfirmedTowardPlan) {
    return MemberPaymentDisplayStatus.PARTIALLY_PAID;
  }

  return MemberPaymentDisplayStatus.UNPAID;
}

export function canStaffConfirmPayment(
  role: UserRole,
  permissions?: StaffPermissions | null
): boolean {
  if (role === UserRole.SUPER_ADMIN || role === UserRole.GYM_OWNER) return true;
  if (role === UserRole.GYM_MANAGER) return permissions?.canConfirmPayments ?? true;
  if (role === UserRole.GYM_RECEPTIONIST) return permissions?.canConfirmPayments ?? false;
  return false;
}

export function canStaffRecordPayment(
  role: UserRole,
  permissions?: StaffPermissions | null
): boolean {
  if (role === UserRole.SUPER_ADMIN || role === UserRole.GYM_OWNER || role === UserRole.GYM_MANAGER) {
    return true;
  }
  if (role === UserRole.GYM_RECEPTIONIST) return permissions?.canRecordPayments ?? true;
  return permissions?.canRecordPayments ?? false;
}

export function canStaffViewPayments(
  role: UserRole,
  permissions?: StaffPermissions | null
): boolean {
  if (role === UserRole.SUPER_ADMIN || role === UserRole.GYM_OWNER || role === UserRole.GYM_MANAGER) {
    return true;
  }
  if (role === UserRole.GYM_RECEPTIONIST) {
    return (permissions?.canViewPayments ?? true) || (permissions?.canRecordPayments ?? false);
  }
  return Boolean(
    permissions?.canViewPayments || permissions?.canRecordPayments || permissions?.canConfirmPayments
  );
}

export function isDuplicateUpiReference(
  payments: MemberPayment[],
  transactionReference?: string
): boolean {
  const trimmed = (transactionReference ?? '').trim().toUpperCase();
  if (!trimmed) return false;
  return payments.some(
    (p) =>
      p.paymentMode === PaymentMode.UPI &&
      p.status !== MemberPaymentStatus.REJECTED &&
      (p.transactionReference ?? '').trim().toUpperCase() === trimmed
  );
}

export function isPotentialDuplicateCashPayment(
  payments: MemberPayment[],
  memberId: string,
  amount: number,
  paymentDate: string
): boolean {
  return payments.some(
    (p) =>
      p.memberId === memberId &&
      p.paymentMode === PaymentMode.CASH &&
      p.paymentDate === paymentDate &&
      Math.abs(p.amount - amount) < 0.01 &&
      (p.status === MemberPaymentStatus.PENDING || p.status === MemberPaymentStatus.CONFIRMED)
  );
}

export function validatePaymentConfirmationTransition(payment: MemberPayment): {
  allowed: boolean;
  reason?: string;
} {
  if (payment.status === MemberPaymentStatus.CONFIRMED) {
    return {
      allowed: false,
      reason: 'Payment is already confirmed. Duplicate confirmation is blocked.',
    };
  }
  if (payment.status === MemberPaymentStatus.REJECTED) {
    return {
      allowed: false,
      reason: 'Rejected payments cannot be confirmed. Record a new payment instead.',
    };
  }
  if (payment.status === MemberPaymentStatus.REFUNDED) {
    return {
      allowed: false,
      reason: 'Refunded payments cannot be confirmed.',
    };
  }
  if (payment.paymentMode === PaymentMode.UPI && !payment.transactionReference?.trim()) {
    return {
      allowed: false,
      reason: 'UPI transaction reference is required before confirming a UPI payment.',
    };
  }
  return { allowed: true };
}
