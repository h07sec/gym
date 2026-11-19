import {
  MemberPayment,
  MemberPaymentPurpose,
  MemberPaymentStatus,
  PaymentMode,
  StaffPermissions,
  UserRole,
} from '../../types/gymos';

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

export function canStaffConfirmPayment(
  role: UserRole,
  permissions?: StaffPermissions | null
): boolean {
  if (role === UserRole.SUPER_ADMIN || role === UserRole.GYM_OWNER) return true;
  if (role === UserRole.GYM_MANAGER) return permissions?.canConfirmPayments ?? true;
  if (role === UserRole.GYM_RECEPTIONIST) return permissions?.canConfirmPayments ?? false;
  return false;
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
