export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  GYM_OWNER = 'GYM_OWNER',
  GYM_MANAGER = 'GYM_MANAGER',
  GYM_RECEPTIONIST = 'GYM_RECEPTIONIST',
  GYM_TRAINER = 'GYM_TRAINER',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  DEACTIVATED = 'DEACTIVATED',
}

export enum AccountStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
}

export enum SubscriptionStatus {
  TRIAL = 'TRIAL',
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  PENDING = 'PENDING',
  CANCELLED = 'CANCELLED',
}

export enum RenewalPolicy {
  EXTEND_FROM_EXPIRY = 'EXTEND_FROM_EXPIRY',
  START_TODAY_IF_EXPIRED = 'START_TODAY_IF_EXPIRED',
}

export enum PaymentMode {
  CASH = 'CASH',
  UPI = 'UPI',
}

export enum SubscriptionPaymentStatus {
  PENDING = 'PENDING',
  RECORDED = 'RECORDED',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

export enum MemberPaymentStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  REJECTED = 'REJECTED',
  REFUNDED = 'REFUNDED',
}

export enum MemberPaymentDisplayStatus {
  PAID = 'PAID',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  OVERDUE = 'OVERDUE',
  UNPAID = 'UNPAID',
}

export enum MemberPaymentPurpose {
  MEMBERSHIP = 'MEMBERSHIP',
  RENEWAL = 'RENEWAL',
  BALANCE_SETTLEMENT = 'BALANCE_SETTLEMENT',
  ADVANCE = 'ADVANCE',
}

export enum MembershipDurationType {
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  HALF_YEARLY = 'HALF_YEARLY',
  YEARLY = 'YEARLY',
  CUSTOM_DAYS = 'CUSTOM_DAYS',
}

export enum MembershipStatus {
  ACTIVE = 'ACTIVE',
  EXPIRING_SOON = 'EXPIRING_SOON',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
  NONE = 'NONE',
}

export enum MembershipRecordStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  SUPERSEDED = 'SUPERSEDED',
  CANCELLED = 'CANCELLED',
}

export enum MembershipActionType {
  INITIAL = 'INITIAL',
  RENEWAL = 'RENEWAL',
  UPGRADE = 'UPGRADE',
  DOWNGRADE = 'DOWNGRADE',
  MANUAL_EXTENSION = 'MANUAL_EXTENSION',
}

export enum ReminderChannel {
  EMAIL = 'EMAIL',
  IN_APP = 'IN_APP',
  WHATSAPP_CLOUD = 'WHATSAPP_CLOUD',
}

export enum ReminderCategory {
  MEMBERSHIP_EXPIRY = 'MEMBERSHIP_EXPIRY',
  UPCOMING_PAYMENT = 'UPCOMING_PAYMENT',
  OVERDUE_PAYMENT = 'OVERDUE_PAYMENT',
  SUBSCRIPTION_EXPIRY = 'SUBSCRIPTION_EXPIRY',
}

export enum DeliveryStatus {
  SENT = 'SENT',
  FAILED = 'FAILED',
  RETRY_SCHEDULED = 'RETRY_SCHEDULED',
  SKIPPED_OPT_OUT = 'SKIPPED_OPT_OUT',
}

export interface StaffPermissions {
  canViewMembers: boolean;
  canManageMembers: boolean;
  canViewReports: boolean;
  canViewPayments: boolean;
  canRecordPayments: boolean;
  canManagePlans: boolean;
  canConfirmPayments: boolean;
  canDeleteMembers: boolean;
  canManageReminders: boolean;
  canManageAttendance: boolean;
}

export interface PlatformAdmin {
  uid: string;
  email: string;
  displayName: string;
  createdAt: unknown;
}

export interface PlatformSettings {
  supportEmail: string;
  supportPhone: string;
  upiId: string;
  upiPayeeName: string;
  paymentInstructions: string;
  defaultGracePeriodDays: number;
  allowPublicRegistration: boolean;
  updatedAt: unknown;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  billingDurationMonths: number;
  price: number;
  currency: string;
  maxStaff: number;
  maxMembers: number;
  trialDays: number;
  features: string[];
  isActive: boolean;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  gymId?: string;
  invitationId?: string;
  status: UserStatus;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface Gym {
  id: string;
  name: string;
  ownerUid: string;
  ownerName: string;
  email: string;
  phone: string;
  address?: string;
  accountStatus: AccountStatus;
  subscriptionStatus: SubscriptionStatus;
  subscriptionPlanId: string;
  subscriptionPlanName: string;
  subscriptionStartAt: string;
  subscriptionEndAt: string;
  subscriptionAccessUntil?: unknown;
  ownerInvitationId?: string;
  gracePeriodDays: number;
  renewalPolicy: RenewalPolicy;
  suspensionReason?: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface SubscriptionPayment {
  id: string;
  gymId: string;
  gymName: string;
  ownerUid: string;
  planId: string;
  planName: string;
  amount: number;
  paymentMode: PaymentMode;
  transactionReference?: string;
  idempotencyKey: string;
  paymentDate: string;
  periodStart: string;
  periodEnd: string;
  status: SubscriptionPaymentStatus;
  notes?: string;
  recordedByUid: string;
  verifiedByUid?: string;
  extensionApplied: boolean;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface GymSettings {
  gymId: string;
  gracePeriodDays: number;
  renewalPolicy: RenewalPolicy;
  reminderDaysBefore: number[];
  sendOnExpiryDay: boolean;
  sendAfterExpiryDays: number[];
  paymentRemindersEnabled?: boolean;
  upcomingPaymentReminderDays?: number;
  overduePaymentReminderDays?: number[];
  ownerSubReminderDays?: number[];
  lastReminderRunDate?: string;
  emailEnabled: boolean;
  emailFromName?: string;
  inAppEnabled: boolean;
  whatsappEnabled: boolean;
  whatsappPhoneNumberId?: string;
  whatsappApprovedTemplate?: string;
  currencySymbol: string;
  updatedAt: unknown;
}

export type AssignableStaffRole =
  | UserRole.GYM_MANAGER
  | UserRole.GYM_RECEPTIONIST
  | UserRole.GYM_TRAINER;

export interface GymStaff {
  id: string;
  gymId: string;
  uid?: string;
  invitationId?: string;
  email: string;
  fullName: string;
  phone?: string;
  role: UserRole.GYM_OWNER | AssignableStaffRole;
  roleTitle?: string;
  status: UserStatus;
  permissions: StaffPermissions;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface StaffInvitation {
  id: string;
  gymId: string;
  gymName: string;
  email: string;
  fullName: string;
  role: UserRole.GYM_OWNER | AssignableStaffRole;
  roleTitle?: string;
  permissions: StaffPermissions;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  invitedByUid: string;
  acceptedByUid?: string;
  expiresAt?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface Member {
  id: string;
  gymId: string;
  memberCode: string;
  fullName: string;
  phone: string;
  email?: string;
  gender?: string;
  dateOfBirth?: string;
  address?: string;
  joiningDate: string;
  emergencyContact?: string;
  currentPlanId?: string;
  currentPlanName?: string;
  membershipStartDate?: string;
  membershipExpiryDate?: string;
  membershipStatus: MembershipStatus;
  outstandingBalance: number;
  reminderOptOut: boolean;
  notes?: string;
  isArchived: boolean;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface MembershipPlan {
  id: string;
  gymId: string;
  name: string;
  durationType: MembershipDurationType;
  durationValue: number;
  price: number;
  description?: string;
  benefits: string[];
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: unknown;
  updatedAt: unknown;
}

export interface Membership {
  id: string;
  gymId: string;
  memberId: string;
  memberName: string;
  planId: string;
  planName: string;
  actionType: MembershipActionType;
  startDate: string;
  expiryDate: string;
  planPrice: number;
  discountAmount?: number;
  discountReason?: string;
  amountPaid: number;
  balanceDue: number;
  dueDate?: string;
  status: MembershipRecordStatus;
  recordedByUid: string;
  cancelledAt?: string;
  cancellationReason?: string;
  notes?: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface MemberPayment {
  id: string;
  paymentCode: string;
  gymId: string;
  memberId: string;
  memberName: string;
  membershipId?: string;
  amount: number;
  discountAmount?: number;
  discountReason?: string;
  paymentMode: PaymentMode;
  paymentPurpose: MemberPaymentPurpose;
  transactionReference?: string;
  attachmentName?: string;
  paymentDate: string;
  dueDate?: string;
  status: MemberPaymentStatus;
  recordedByUid: string;
  recordedByName: string;
  confirmedByUid?: string;
  receiptNumber?: string;
  notes?: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface PaymentReceipt {
  id: string;
  receiptNumber: string;
  gymId: string;
  gymName: string;
  paymentId: string;
  memberId: string;
  memberName: string;
  memberCode: string;
  amount: number;
  paymentMode: PaymentMode;
  transactionReference?: string;
  issuedAt: unknown;
  issuedByUid: string;
}

export interface AttendanceRecord {
  id: string;
  gymId: string;
  memberId: string;
  memberCode: string;
  memberName: string;
  checkInDate: string;
  checkInTime: string;
  checkOutTime?: string;
  recordedByUid: string;
  recordedByName: string;
  notes?: string;
  createdAt: unknown;
}

export interface GymNotification {
  id: string;
  gymId: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: unknown;
}

export interface PlatformNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  gymId?: string;
  isRead: boolean;
  createdAt: unknown;
}

export interface NotificationLog {
  id: string;
  gymId: string;
  memberId: string;
  memberName: string;
  recipient: string;
  channel: ReminderChannel;
  category?: ReminderCategory;
  template: string;
  dedupKey: string;
  scheduledDate: string;
  deliveryStatus: DeliveryStatus;
  retryCount: number;
  errorDetails?: string;
  providerMessageId?: string;
  sentAt?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface AuditLog {
  id: string;
  actorUid: string;
  actorEmail: string;
  actorRole: string;
  gymId?: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  createdAt: unknown;
}
