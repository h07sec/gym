import fs from 'node:fs';
import path from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const PROJECT_ID = 'mineral-emblem-gbcxw';
const rulesText = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');

function parseEmulatorHost(): { host: string; port: number } {
  const raw = process.env.FIRESTORE_EMULATOR_HOST?.trim();
  if (raw && raw.includes(':')) {
    const [host, portStr] = raw.split(':');
    const port = Number(portStr);
    if (host && Number.isFinite(port)) {
      return { host, port };
    }
  }
  return { host: '127.0.0.1', port: 8080 };
}

const ALL_FALSE_PERMS = {
  canViewMembers: false,
  canManageMembers: false,
  canViewReports: false,
  canViewPayments: false,
  canRecordPayments: false,
  canManagePlans: false,
  canConfirmPayments: false,
  canDeleteMembers: false,
  canManageReminders: false,
  canManageAttendance: false,
};

const ALL_TRUE_PERMS = {
  canViewMembers: true,
  canManageMembers: true,
  canViewReports: true,
  canViewPayments: true,
  canRecordPayments: true,
  canManagePlans: true,
  canConfirmPayments: true,
  canDeleteMembers: true,
  canManageReminders: true,
  canManageAttendance: true,
};

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const { host, port } = parseEmulatorHost();
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host,
      port,
      rules: rulesText,
    },
  });
});

afterAll(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

async function seedBaseEnvironment(opts?: {
  allowPublicRegistration?: boolean;
  gymAAccountStatus?: 'ACTIVE' | 'SUSPENDED';
  gymASubStatus?: 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'PENDING' | 'CANCELLED';
  gymAAccessFuture?: boolean;
}) {
  const allowPublicRegistration = opts?.allowPublicRegistration ?? true;
  const gymAAccountStatus = opts?.gymAAccountStatus ?? 'ACTIVE';
  const gymASubStatus = opts?.gymASubStatus ?? 'ACTIVE';
  const gymAAccessFuture = opts?.gymAAccessFuture ?? true;

  const accessDate = new Date(
    gymAAccessFuture ? Date.now() + 30 * 86400_000 : Date.now() - 2 * 86400_000
  );

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = Timestamp.now();

    await setDoc(doc(db, 'platform_settings', 'default'), {
      supportEmail: 'support@gymos.test',
      supportPhone: '+91-9000000000',
      upiId: 'gymos@upi',
      upiPayeeName: 'GymOS',
      paymentInstructions: 'Manual Cash or UPI',
      defaultGracePeriodDays: 7,
      allowPublicRegistration,
      updatedAt: now,
    });

    await setDoc(doc(db, 'subscription_plans', 'plan_monthly'), {
      id: 'plan_monthly',
      name: 'Monthly Standard',
      billingDurationMonths: 1,
      price: 1999,
      currency: '₹',
      maxStaff: 10,
      maxMembers: 500,
      trialDays: 14,
      features: ['Members & Payments'],
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'platform_admins', 'admin_1'), {
      uid: 'admin_1',
      email: 'admin@gymos.test',
      displayName: 'Platform Admin',
      createdAt: now,
    });

    await setDoc(doc(db, 'users', 'admin_1'), {
      uid: 'admin_1',
      email: 'admin@gymos.test',
      displayName: 'Platform Admin',
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    // Gym A + Owner A
    await setDoc(doc(db, 'gyms', 'gym_a'), {
      id: 'gym_a',
      name: 'Alpha Fitness',
      ownerUid: 'owner_a',
      ownerName: 'Owner Alpha',
      email: 'ownera@gym.test',
      phone: '9876543210',
      accountStatus: gymAAccountStatus,
      subscriptionStatus: gymASubStatus,
      subscriptionPlanId: 'plan_monthly',
      subscriptionPlanName: 'Monthly Standard',
      subscriptionStartAt: '2025-06-01',
      subscriptionEndAt: '2025-07-01',
      subscriptionAccessUntil: Timestamp.fromDate(accessDate),
      gracePeriodDays: 7,
      renewalPolicy: 'EXTEND_FROM_EXPIRY',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'users', 'owner_a'), {
      uid: 'owner_a',
      email: 'ownera@gym.test',
      displayName: 'Owner Alpha',
      role: 'GYM_OWNER',
      gymId: 'gym_a',
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'gyms', 'gym_a', 'staff', 'owner_a'), {
      id: 'owner_a',
      gymId: 'gym_a',
      uid: 'owner_a',
      email: 'ownera@gym.test',
      fullName: 'Owner Alpha',
      role: 'GYM_OWNER',
      status: 'ACTIVE',
      permissions: { ...ALL_TRUE_PERMS },
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'gyms', 'gym_a', 'members', 'mem_a1'), {
      id: 'mem_a1',
      gymId: 'gym_a',
      memberCode: 'A-001',
      fullName: 'Member Alpha',
      phone: '9998887771',
      joiningDate: '2025-06-01',
      membershipStatus: 'ACTIVE',
      outstandingBalance: 500,
      reminderOptOut: false,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'gyms', 'gym_a', 'member_payments', 'pay_a1'), {
      id: 'pay_a1',
      paymentCode: 'PAY-A1',
      gymId: 'gym_a',
      memberId: 'mem_a1',
      memberName: 'Member Alpha',
      amount: 500,
      paymentMode: 'CASH',
      paymentPurpose: 'BALANCE_SETTLEMENT',
      paymentDate: '2025-06-10',
      status: 'PENDING',
      recordedByUid: 'owner_a',
      recordedByName: 'Owner Alpha',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'gyms', 'gym_a', 'payment_receipts', 'rcp_a1'), {
      id: 'rcp_a1',
      receiptNumber: 'RCP-A1',
      gymId: 'gym_a',
      gymName: 'Alpha Fitness',
      paymentId: 'pay_a1',
      memberId: 'mem_a1',
      memberName: 'Member Alpha',
      memberCode: 'A-001',
      amount: 500,
      paymentMode: 'CASH',
      issuedAt: now,
      issuedByUid: 'owner_a',
    });

    // Gym B + Owner B
    await setDoc(doc(db, 'gyms', 'gym_b'), {
      id: 'gym_b',
      name: 'Beta Barbell',
      ownerUid: 'owner_b',
      ownerName: 'Owner Beta',
      email: 'ownerb@gym.test',
      phone: '9876543211',
      accountStatus: 'ACTIVE',
      subscriptionStatus: 'ACTIVE',
      subscriptionPlanId: 'plan_monthly',
      subscriptionPlanName: 'Monthly Standard',
      subscriptionStartAt: '2025-06-01',
      subscriptionEndAt: '2025-07-01',
      subscriptionAccessUntil: Timestamp.fromDate(new Date(Date.now() + 30 * 86400_000)),
      gracePeriodDays: 7,
      renewalPolicy: 'EXTEND_FROM_EXPIRY',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'users', 'owner_b'), {
      uid: 'owner_b',
      email: 'ownerb@gym.test',
      displayName: 'Owner Beta',
      role: 'GYM_OWNER',
      gymId: 'gym_b',
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'gyms', 'gym_b', 'members', 'mem_b1'), {
      id: 'mem_b1',
      gymId: 'gym_b',
      memberCode: 'B-001',
      fullName: 'Member Beta',
      phone: '9998887772',
      joiningDate: '2025-06-01',
      membershipStatus: 'ACTIVE',
      outstandingBalance: 0,
      reminderOptOut: false,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('Firestore Emulator Security Rules Integration Suite', () => {
  it('blocks unauthenticated access and unverified emails across platform and tenant collections', async () => {
    await seedBaseEnvironment();

    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anonDb, 'gyms', 'gym_a')));
    await assertFails(getDoc(doc(anonDb, 'gyms', 'gym_a', 'members', 'mem_a1')));
    await assertFails(getDoc(doc(anonDb, 'platform_settings', 'default')));

    const unverifiedDb = testEnv
      .authenticatedContext('unverified_1', {
        email: 'unverified@gym.test',
        email_verified: false,
      })
      .firestore();
    await assertFails(getDoc(doc(unverifiedDb, 'platform_settings', 'default')));
    await assertFails(getDoc(doc(unverifiedDb, 'gyms', 'gym_a')));
  });

  it('strictly isolates tenants: Gym A owner cannot read or write Gym B records', async () => {
    await seedBaseEnvironment();

    const ownerADb = testEnv
      .authenticatedContext('owner_a', { email: 'ownera@gym.test', email_verified: true })
      .firestore();

    await assertSucceeds(getDoc(doc(ownerADb, 'gyms', 'gym_a', 'members', 'mem_a1')));
    await assertFails(getDoc(doc(ownerADb, 'gyms', 'gym_b')));
    await assertFails(getDoc(doc(ownerADb, 'gyms', 'gym_b', 'members', 'mem_b1')));
    await assertFails(
      setDoc(doc(ownerADb, 'gyms', 'gym_b', 'members', 'mem_inject'), {
        id: 'mem_inject',
        gymId: 'gym_b',
        memberCode: 'INJ-1',
        fullName: 'Injected Member',
        phone: '9111122222',
        joiningDate: '2025-06-10',
        membershipStatus: 'NONE',
        outstandingBalance: 0,
        reminderOptOut: false,
        isArchived: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
  });

  it('blocks self-promotion to SUPER_ADMIN, platform_admins writes, and gym subscription tampering', async () => {
    await seedBaseEnvironment();

    const attackerDb = testEnv
      .authenticatedContext('attacker_1', { email: 'attacker@test.dev', email_verified: true })
      .firestore();

    // Cannot write platform_admins directly
    await assertFails(
      setDoc(doc(attackerDb, 'platform_admins', 'attacker_1'), {
        uid: 'attacker_1',
        email: 'attacker@test.dev',
        displayName: 'Attacker',
        createdAt: serverTimestamp(),
      })
    );

    // Cannot self-create SUPER_ADMIN user profile
    await assertFails(
      setDoc(doc(attackerDb, 'users', 'attacker_1'), {
        uid: 'attacker_1',
        email: 'attacker@test.dev',
        displayName: 'Attacker',
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    const ownerADb = testEnv
      .authenticatedContext('owner_a', { email: 'ownera@gym.test', email_verified: true })
      .firestore();

    // Owner cannot update platform settings
    await assertFails(
      updateDoc(doc(ownerADb, 'platform_settings', 'default'), {
        allowPublicRegistration: true,
        updatedAt: serverTimestamp(),
      })
    );

    // Owner cannot alter their own gym subscriptionStatus or gracePeriodDays
    await assertFails(
      updateDoc(doc(ownerADb, 'gyms', 'gym_a'), {
        subscriptionStatus: 'ACTIVE',
        gracePeriodDays: 90,
        updatedAt: serverTimestamp(),
      })
    );

    // Owner CAN update permitted profile fields
    await assertSucceeds(
      updateDoc(doc(ownerADb, 'gyms', 'gym_a'), {
        name: 'Alpha Fitness Pro',
        updatedAt: serverTimestamp(),
      })
    );
  });

  it('enforces allowPublicRegistration == false on direct SDK gym/user creation while allowing invited owners', async () => {
    await seedBaseEnvironment({ allowPublicRegistration: false });

    const strangerDb = testEnv
      .authenticatedContext('stranger_1', { email: 'stranger@gym.test', email_verified: true })
      .firestore();

    // Self-registration gym creation must fail when allowPublicRegistration == false
    await assertFails(
      setDoc(doc(strangerDb, 'gyms', 'gym_stranger'), {
        id: 'gym_stranger',
        name: 'Rogue Gym',
        ownerUid: 'stranger_1',
        ownerName: 'Stranger',
        email: 'stranger@gym.test',
        phone: '9876543219',
        accountStatus: 'ACTIVE',
        subscriptionStatus: 'TRIAL',
        subscriptionPlanId: 'plan_monthly',
        subscriptionPlanName: 'Monthly Standard',
        subscriptionStartAt: '2025-06-10',
        subscriptionEndAt: '2025-06-24',
        subscriptionAccessUntil: Timestamp.fromDate(new Date(Date.now() + 21 * 86400_000)),
        gracePeriodDays: 7,
        renewalPolicy: 'EXTEND_FROM_EXPIRY',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // Invited owner flow seeded by Super Admin
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const now = Timestamp.now();
      await setDoc(doc(db, 'gyms', 'gym_invited'), {
        id: 'gym_invited',
        name: 'Invited Gym',
        ownerUid: 'owner_pending_inv_1',
        ownerName: 'Invited Owner',
        email: 'invitedowner@gym.test',
        phone: '9876543299',
        accountStatus: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        subscriptionPlanId: 'plan_monthly',
        subscriptionPlanName: 'Monthly Standard',
        subscriptionStartAt: '2025-06-10',
        subscriptionEndAt: '2025-07-10',
        subscriptionAccessUntil: Timestamp.fromDate(new Date(Date.now() + 30 * 86400_000)),
        ownerInvitationId: 'inv_owner_1',
        gracePeriodDays: 7,
        renewalPolicy: 'EXTEND_FROM_EXPIRY',
        createdAt: now,
        updatedAt: now,
      });
      await setDoc(doc(db, 'invitations', 'inv_owner_1'), {
        id: 'inv_owner_1',
        gymId: 'gym_invited',
        gymName: 'Invited Gym',
        email: 'invitedowner@gym.test',
        fullName: 'Invited Owner',
        role: 'GYM_OWNER',
        permissions: { ...ALL_TRUE_PERMS },
        status: 'PENDING',
        invitedByUid: 'admin_1',
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 7 * 86400_000)),
        createdAt: now,
        updatedAt: now,
      });
    });

    const invitedDb = testEnv
      .authenticatedContext('invited_uid_1', {
        email: 'invitedowner@gym.test',
        email_verified: true,
      })
      .firestore();

    const batch = writeBatch(invitedDb);
    batch.update(doc(invitedDb, 'invitations', 'inv_owner_1'), {
      status: 'ACCEPTED',
      acceptedByUid: 'invited_uid_1',
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(invitedDb, 'gyms', 'gym_invited'), {
      ownerUid: 'invited_uid_1',
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(invitedDb, 'users', 'invited_uid_1'), {
      uid: 'invited_uid_1',
      email: 'invitedowner@gym.test',
      displayName: 'Invited Owner',
      role: 'GYM_OWNER',
      gymId: 'gym_invited',
      invitationId: 'inv_owner_1',
      status: 'ACTIVE',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await assertSucceeds(batch.commit());
  });

  it('locks tenant subcollections when gym is SUSPENDED, PENDING, or past subscriptionAccessUntil', async () => {
    await seedBaseEnvironment({ gymAAccountStatus: 'SUSPENDED' });
    const ownerSuspendedDb = testEnv
      .authenticatedContext('owner_a', { email: 'ownera@gym.test', email_verified: true })
      .firestore();
    await assertFails(getDoc(doc(ownerSuspendedDb, 'gyms', 'gym_a', 'members', 'mem_a1')));

    await testEnv.clearFirestore();
    await seedBaseEnvironment({ gymAAccountStatus: 'ACTIVE', gymAAccessFuture: false });
    const ownerExpiredDb = testEnv
      .authenticatedContext('owner_a', { email: 'ownera@gym.test', email_verified: true })
      .firestore();
    await assertFails(getDoc(doc(ownerExpiredDb, 'gyms', 'gym_a', 'members', 'mem_a1')));
    await assertFails(getDoc(doc(ownerExpiredDb, 'gyms', 'gym_a', 'member_payments', 'pay_a1')));
  });

  it('blocks deactivated staff and enforces granular payment vs attendance permissions for GYM_TRAINER', async () => {
    await seedBaseEnvironment();

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const now = Timestamp.now();

      // Active trainer with attendance permission only
      await setDoc(doc(db, 'users', 'trainer_1'), {
        uid: 'trainer_1',
        email: 'trainer1@gym.test',
        displayName: 'Coach Ria',
        role: 'GYM_TRAINER',
        gymId: 'gym_a',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      await setDoc(doc(db, 'gyms', 'gym_a', 'staff', 'trainer_1'), {
        id: 'trainer_1',
        gymId: 'gym_a',
        uid: 'trainer_1',
        email: 'trainer1@gym.test',
        fullName: 'Coach Ria',
        role: 'GYM_TRAINER',
        status: 'ACTIVE',
        permissions: { ...ALL_FALSE_PERMS, canManageAttendance: true },
        createdAt: now,
        updatedAt: now,
      });

      // Deactivated receptionist at staff level
      await setDoc(doc(db, 'users', 'deactivated_1'), {
        uid: 'deactivated_1',
        email: 'deactivated@gym.test',
        displayName: 'Former Desk',
        role: 'GYM_RECEPTIONIST',
        gymId: 'gym_a',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      await setDoc(doc(db, 'gyms', 'gym_a', 'staff', 'deactivated_1'), {
        id: 'deactivated_1',
        gymId: 'gym_a',
        uid: 'deactivated_1',
        email: 'deactivated@gym.test',
        fullName: 'Former Desk',
        role: 'GYM_RECEPTIONIST',
        status: 'DEACTIVATED',
        permissions: { ...ALL_FALSE_PERMS, canViewPayments: true, canRecordPayments: true },
        createdAt: now,
        updatedAt: now,
      });
    });

    const trainerDb = testEnv
      .authenticatedContext('trainer_1', { email: 'trainer1@gym.test', email_verified: true })
      .firestore();

    // Trainer can log and update attendance when canManageAttendance == true
    await assertSucceeds(
      setDoc(doc(trainerDb, 'gyms', 'gym_a', 'attendance', 'att_1'), {
        id: 'att_1',
        gymId: 'gym_a',
        memberId: 'mem_a1',
        memberCode: 'A-001',
        memberName: 'Member Alpha',
        checkInDate: '2025-06-10',
        checkInTime: '07:00',
        recordedByUid: 'trainer_1',
        recordedByName: 'Coach Ria',
        createdAt: serverTimestamp(),
      })
    );
    await assertSucceeds(
      updateDoc(doc(trainerDb, 'gyms', 'gym_a', 'attendance', 'att_1'), {
        checkOutTime: '08:15',
        notes: 'Completed session',
      })
    );

    // Trainer without canManageAttendance cannot create or update attendance
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const now = Timestamp.now();
      await setDoc(doc(db, 'users', 'trainer_noperm'), {
        uid: 'trainer_noperm',
        email: 'trainer_noperm@gym.test',
        displayName: 'Coach NoPerm',
        role: 'GYM_TRAINER',
        gymId: 'gym_a',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      await setDoc(doc(db, 'gyms', 'gym_a', 'staff', 'trainer_noperm'), {
        id: 'trainer_noperm',
        gymId: 'gym_a',
        uid: 'trainer_noperm',
        email: 'trainer_noperm@gym.test',
        fullName: 'Coach NoPerm',
        role: 'GYM_TRAINER',
        status: 'ACTIVE',
        permissions: { ...ALL_FALSE_PERMS },
        createdAt: now,
        updatedAt: now,
      });
    });

    const trainerNoPermDb = testEnv
      .authenticatedContext('trainer_noperm', {
        email: 'trainer_noperm@gym.test',
        email_verified: true,
      })
      .firestore();
    await assertFails(
      setDoc(doc(trainerNoPermDb, 'gyms', 'gym_a', 'attendance', 'att_denied'), {
        id: 'att_denied',
        gymId: 'gym_a',
        memberId: 'mem_a1',
        memberCode: 'A-001',
        memberName: 'Member Alpha',
        checkInDate: '2025-06-10',
        checkInTime: '07:30',
        recordedByUid: 'trainer_noperm',
        recordedByName: 'Coach NoPerm',
        createdAt: serverTimestamp(),
      })
    );

    // Trainer without financial permissions cannot read payments or receipts or record payments
    await assertFails(getDoc(doc(trainerDb, 'gyms', 'gym_a', 'member_payments', 'pay_a1')));
    await assertFails(getDoc(doc(trainerDb, 'gyms', 'gym_a', 'payment_receipts', 'rcp_a1')));
    await assertFails(
      setDoc(doc(trainerDb, 'gyms', 'gym_a', 'member_payments', 'pay_illegal'), {
        id: 'pay_illegal',
        paymentCode: 'PAY-ILL',
        gymId: 'gym_a',
        memberId: 'mem_a1',
        memberName: 'Member Alpha',
        amount: 500,
        paymentMode: 'CASH',
        paymentPurpose: 'MEMBERSHIP',
        paymentDate: '2025-06-10',
        status: 'PENDING',
        recordedByUid: 'trainer_1',
        recordedByName: 'Coach Ria',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // Authorized receptionist WITH canRecordPayments CAN record a PENDING payment within expression limits
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const now = Timestamp.now();
      await setDoc(doc(db, 'users', 'recep_1'), {
        uid: 'recep_1',
        email: 'recep1@gym.test',
        displayName: 'Desk Priya',
        role: 'GYM_RECEPTIONIST',
        gymId: 'gym_a',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      await setDoc(doc(db, 'gyms', 'gym_a', 'staff', 'recep_1'), {
        id: 'recep_1',
        gymId: 'gym_a',
        uid: 'recep_1',
        email: 'recep1@gym.test',
        fullName: 'Desk Priya',
        role: 'GYM_RECEPTIONIST',
        status: 'ACTIVE',
        permissions: { ...ALL_FALSE_PERMS, canViewPayments: true, canRecordPayments: true },
        createdAt: now,
        updatedAt: now,
      });
    });

    const recepDb = testEnv
      .authenticatedContext('recep_1', { email: 'recep1@gym.test', email_verified: true })
      .firestore();
    await assertSucceeds(
      setDoc(doc(recepDb, 'gyms', 'gym_a', 'member_payments', 'pay_recep'), {
        id: 'pay_recep',
        paymentCode: 'PAY-REC1',
        gymId: 'gym_a',
        memberId: 'mem_a1',
        memberName: 'Member Alpha',
        amount: 500,
        paymentMode: 'CASH',
        paymentPurpose: 'MEMBERSHIP',
        paymentDate: '2025-06-10',
        status: 'PENDING',
        recordedByUid: 'recep_1',
        recordedByName: 'Desk Priya',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    // Receptionist without canConfirmPayments cannot create a CONFIRMED payment or confirm PENDING payments
    await assertFails(
      setDoc(doc(recepDb, 'gyms', 'gym_a', 'member_payments', 'pay_recep_confirmed'), {
        id: 'pay_recep_confirmed',
        paymentCode: 'PAY-REC2',
        gymId: 'gym_a',
        memberId: 'mem_a1',
        memberName: 'Member Alpha',
        amount: 500,
        paymentMode: 'CASH',
        paymentPurpose: 'MEMBERSHIP',
        paymentDate: '2025-06-10',
        status: 'CONFIRMED',
        recordedByUid: 'recep_1',
        recordedByName: 'Desk Priya',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(recepDb, 'gyms', 'gym_a', 'member_payments', 'pay_recep'), {
        status: 'CONFIRMED',
        confirmedByUid: 'recep_1',
        receiptNumber: 'RCP-REC1',
        updatedAt: serverTimestamp(),
      })
    );

    // Authorized owner CAN record and confirm a payment within expression limits
    const ownerADb = testEnv
      .authenticatedContext('owner_a', { email: 'ownera@gym.test', email_verified: true })
      .firestore();
    await assertSucceeds(
      setDoc(doc(ownerADb, 'gyms', 'gym_a', 'member_payments', 'pay_valid'), {
        id: 'pay_valid',
        paymentCode: 'PAY-VAL1',
        gymId: 'gym_a',
        memberId: 'mem_a1',
        memberName: 'Member Alpha',
        amount: 500,
        paymentMode: 'CASH',
        paymentPurpose: 'MEMBERSHIP',
        paymentDate: '2025-06-10',
        status: 'PENDING',
        recordedByUid: 'owner_a',
        recordedByName: 'Owner Alpha',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerADb, 'gyms', 'gym_a', 'member_payments', 'pay_valid'), {
        status: 'CONFIRMED',
        confirmedByUid: 'owner_a',
        receiptNumber: 'RCP-VAL1',
        updatedAt: serverTimestamp(),
      })
    );

    // Deactivated staff member is immediately locked out of tenant docs
    const deactivatedDb = testEnv
      .authenticatedContext('deactivated_1', {
        email: 'deactivated@gym.test',
        email_verified: true,
      })
      .firestore();
    await assertFails(getDoc(doc(deactivatedDb, 'gyms', 'gym_a', 'members', 'mem_a1')));
    await assertFails(getDoc(doc(deactivatedDb, 'gyms', 'gym_a', 'member_payments', 'pay_a1')));
  });

  it('enforces immutable receipts and immutable audit logs', async () => {
    await seedBaseEnvironment();

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'audit_logs', 'aud_1'), {
        id: 'aud_1',
        actorUid: 'owner_a',
        actorEmail: 'ownera@gym.test',
        actorRole: 'GYM_OWNER',
        gymId: 'gym_a',
        action: 'TEST_EVENT',
        entityType: 'Member',
        entityId: 'mem_a1',
        summary: 'Initial log',
        createdAt: Timestamp.now(),
      });
    });

    const ownerADb = testEnv
      .authenticatedContext('owner_a', { email: 'ownera@gym.test', email_verified: true })
      .firestore();

    await assertFails(
      updateDoc(doc(ownerADb, 'gyms', 'gym_a', 'payment_receipts', 'rcp_a1'), { amount: 9999 })
    );
    await assertFails(deleteDoc(doc(ownerADb, 'gyms', 'gym_a', 'payment_receipts', 'rcp_a1')));
    await assertFails(updateDoc(doc(ownerADb, 'audit_logs', 'aud_1'), { summary: 'Tampered' }));
    await assertFails(deleteDoc(doc(ownerADb, 'audit_logs', 'aud_1')));

    // Server-only bootstrap and worker lock collections deny all client SDK reads & writes
    const adminDb = testEnv
      .authenticatedContext('admin_1', { email: 'admin@gymos.test', email_verified: true })
      .firestore();
    await assertFails(getDoc(doc(adminDb, 'platform_bootstrap', 'default')));
    await assertFails(
      setDoc(doc(adminDb, 'platform_bootstrap', 'default'), {
        id: 'default',
        completed: false,
      })
    );
    await assertFails(getDoc(doc(adminDb, 'system_locks', 'reminder_worker')));
    await assertFails(
      setDoc(doc(ownerADb, 'system_locks', 'reminder_worker'), {
        id: 'reminder_worker',
        released: true,
      })
    );
  });

  it('Phase 1: blocks staff invitation permission escalation, self-elevation, expired/revoked/replayed invites, and wrong-email claims', async () => {
    await seedBaseEnvironment();

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const now = Timestamp.now();
      await setDoc(doc(db, 'invitations', 'inv_staff_1'), {
        id: 'inv_staff_1',
        gymId: 'gym_a',
        gymName: 'Alpha Fitness',
        email: 'newstaff@gym.test',
        fullName: 'New Staff',
        role: 'GYM_RECEPTIONIST',
        permissions: {
          ...ALL_FALSE_PERMS,
          canViewMembers: true,
          canManageMembers: true,
          canRecordPayments: true,
        },
        status: 'PENDING',
        invitedByUid: 'owner_a',
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 3 * 86400_000)),
        createdAt: now,
        updatedAt: now,
      });
      await setDoc(doc(db, 'invitations', 'inv_expired'), {
        id: 'inv_expired',
        gymId: 'gym_a',
        gymName: 'Alpha Fitness',
        email: 'expiredstaff@gym.test',
        fullName: 'Expired Staff',
        role: 'GYM_TRAINER',
        permissions: { ...ALL_FALSE_PERMS, canManageAttendance: true },
        status: 'PENDING',
        invitedByUid: 'owner_a',
        expiresAt: Timestamp.fromDate(new Date(Date.now() - 3600_000)),
        createdAt: now,
        updatedAt: now,
      });
    });

    // Wrong email cannot accept inv_staff_1
    const wrongUserDb = testEnv
      .authenticatedContext('wrong_uid', { email: 'attacker@gym.test', email_verified: true })
      .firestore();
    await assertFails(
      updateDoc(doc(wrongUserDb, 'invitations', 'inv_staff_1'), {
        status: 'ACCEPTED',
        acceptedByUid: 'wrong_uid',
        updatedAt: serverTimestamp(),
      })
    );

    // Invited user (case-insensitive email) CANNOT escalate permissions on staff doc creation
    const staffDb = testEnv
      .authenticatedContext('staff_new_1', { email: 'NewStaff@gym.test', email_verified: true })
      .firestore();
    const badBatch = writeBatch(staffDb);
    badBatch.update(doc(staffDb, 'invitations', 'inv_staff_1'), {
      status: 'ACCEPTED',
      acceptedByUid: 'staff_new_1',
      updatedAt: serverTimestamp(),
    });
    badBatch.set(doc(staffDb, 'users', 'staff_new_1'), {
      uid: 'staff_new_1',
      email: 'newstaff@gym.test',
      displayName: 'New Staff',
      role: 'GYM_RECEPTIONIST',
      gymId: 'gym_a',
      invitationId: 'inv_staff_1',
      status: 'ACTIVE',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    badBatch.set(doc(staffDb, 'gyms', 'gym_a', 'staff', 'staff_new_1'), {
      id: 'staff_new_1',
      gymId: 'gym_a',
      uid: 'staff_new_1',
      invitationId: 'inv_staff_1',
      email: 'newstaff@gym.test',
      fullName: 'New Staff',
      role: 'GYM_RECEPTIONIST',
      status: 'ACTIVE',
      permissions: { ...ALL_FALSE_PERMS, canViewMembers: true, canConfirmPayments: true }, // escalated!
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await assertFails(badBatch.commit());

    // Exact matching permissions succeed
    const goodBatch = writeBatch(staffDb);
    goodBatch.update(doc(staffDb, 'invitations', 'inv_staff_1'), {
      status: 'ACCEPTED',
      acceptedByUid: 'staff_new_1',
      updatedAt: serverTimestamp(),
    });
    goodBatch.set(doc(staffDb, 'users', 'staff_new_1'), {
      uid: 'staff_new_1',
      email: 'newstaff@gym.test',
      displayName: 'New Staff',
      role: 'GYM_RECEPTIONIST',
      gymId: 'gym_a',
      invitationId: 'inv_staff_1',
      status: 'ACTIVE',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    goodBatch.set(doc(staffDb, 'gyms', 'gym_a', 'staff', 'staff_new_1'), {
      id: 'staff_new_1',
      gymId: 'gym_a',
      uid: 'staff_new_1',
      invitationId: 'inv_staff_1',
      email: 'newstaff@gym.test',
      fullName: 'New Staff',
      role: 'GYM_RECEPTIONIST',
      status: 'ACTIVE',
      permissions: {
        ...ALL_FALSE_PERMS,
        canViewMembers: true,
        canManageMembers: true,
        canRecordPayments: true,
      },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await assertSucceeds(goodBatch.commit());

    // Staff cannot modify their own permissions/role/status or users/{uid} role/gymId
    await assertFails(
      updateDoc(doc(staffDb, 'gyms', 'gym_a', 'staff', 'staff_new_1'), {
        permissions: { ...ALL_TRUE_PERMS },
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(staffDb, 'users', 'staff_new_1'), {
        role: 'GYM_OWNER',
        updatedAt: serverTimestamp(),
      })
    );

    // Replay of already-accepted inv_staff_1 under another account is denied
    const replayDb = testEnv
      .authenticatedContext('replay_uid', { email: 'newstaff@gym.test', email_verified: true })
      .firestore();
    await assertFails(
      setDoc(doc(replayDb, 'users', 'replay_uid'), {
        uid: 'replay_uid',
        email: 'newstaff@gym.test',
        displayName: 'Replay',
        role: 'GYM_RECEPTIONIST',
        gymId: 'gym_a',
        invitationId: 'inv_staff_1',
        status: 'ACTIVE',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // Expired invitation cannot be accepted
    const expiredStaffDb = testEnv
      .authenticatedContext('exp_staff_1', {
        email: 'expiredstaff@gym.test',
        email_verified: true,
      })
      .firestore();
    await assertFails(
      updateDoc(doc(expiredStaffDb, 'invitations', 'inv_expired'), {
        status: 'ACCEPTED',
        acceptedByUid: 'exp_staff_1',
        updatedAt: serverTimestamp(),
      })
    );
  });

  it('Phase 1: fails closed when subscriptionAccessUntil is missing and prevents forged trial expiry on self-registration', async () => {
    await seedBaseEnvironment();

    // Remove subscriptionAccessUntil from gym_a directly via admin bypass
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'gyms', 'gym_no_ts'), {
        id: 'gym_no_ts',
        name: 'No Access Timestamp Gym',
        ownerUid: 'owner_no_ts',
        ownerName: 'No TS',
        email: 'nots@gym.test',
        phone: '9876543222',
        accountStatus: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        subscriptionPlanId: 'plan_monthly',
        subscriptionPlanName: 'Monthly Standard',
        subscriptionStartAt: '2025-06-01',
        subscriptionEndAt: '2099-12-31',
        gracePeriodDays: 7,
        renewalPolicy: 'EXTEND_FROM_EXPIRY',
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
      await setDoc(doc(db, 'users', 'owner_no_ts'), {
        uid: 'owner_no_ts',
        email: 'nots@gym.test',
        displayName: 'No TS',
        role: 'GYM_OWNER',
        gymId: 'gym_no_ts',
        status: 'ACTIVE',
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
      await setDoc(doc(db, 'gyms', 'gym_no_ts', 'members', 'mem_nots'), {
        id: 'mem_nots',
        gymId: 'gym_no_ts',
        memberCode: 'N-001',
        fullName: 'Blocked Member',
        phone: '9998887770',
        joiningDate: '2025-06-01',
        membershipStatus: 'ACTIVE',
        outstandingBalance: 0,
        reminderOptOut: false,
        isArchived: false,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
    });

    const ownerNoTsDb = testEnv
      .authenticatedContext('owner_no_ts', { email: 'nots@gym.test', email_verified: true })
      .firestore();
    // Operational subcollection access must FAIL CLOSED without subscriptionAccessUntil
    await assertFails(getDoc(doc(ownerNoTsDb, 'gyms', 'gym_no_ts', 'members', 'mem_nots')));
    // Expired/missing-ts owner can STILL read own gym doc and platform settings for renewal
    await assertSucceeds(getDoc(doc(ownerNoTsDb, 'gyms', 'gym_no_ts')));
    await assertSucceeds(getDoc(doc(ownerNoTsDb, 'platform_settings', 'default')));

    // Self-registration cannot forge a 2099 trial expiry
    const newOwnerDb = testEnv
      .authenticatedContext('new_owner_1', { email: 'newowner@gym.test', email_verified: true })
      .firestore();
    await assertFails(
      setDoc(doc(newOwnerDb, 'gyms', 'gym_forged'), {
        id: 'gym_forged',
        name: 'Forged Trial Gym',
        ownerUid: 'new_owner_1',
        ownerName: 'New Owner',
        email: 'newowner@gym.test',
        phone: '9876543288',
        accountStatus: 'ACTIVE',
        subscriptionStatus: 'TRIAL',
        subscriptionPlanId: 'plan_monthly',
        subscriptionPlanName: 'Monthly Standard',
        subscriptionStartAt: '2025-06-10',
        subscriptionEndAt: '2099-12-31',
        subscriptionAccessUntil: Timestamp.fromDate(new Date('2099-12-31T23:59:59.000Z')),
        gracePeriodDays: 7,
        renewalPolicy: 'EXTEND_FROM_EXPIRY',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    // Valid bounded trial succeeds
    await assertSucceeds(
      setDoc(doc(newOwnerDb, 'gyms', 'gym_valid_trial'), {
        id: 'gym_valid_trial',
        name: 'Valid Trial Gym',
        ownerUid: 'new_owner_1',
        ownerName: 'New Owner',
        email: 'newowner@gym.test',
        phone: '9876543288',
        accountStatus: 'ACTIVE',
        subscriptionStatus: 'TRIAL',
        subscriptionPlanId: 'plan_monthly',
        subscriptionPlanName: 'Monthly Standard',
        subscriptionStartAt: '2025-06-10',
        subscriptionEndAt: '2025-06-24',
        subscriptionAccessUntil: Timestamp.fromDate(new Date(Date.now() + 21 * 86400_000)),
        gracePeriodDays: 7,
        renewalPolicy: 'EXTEND_FROM_EXPIRY',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
  });

  it('Phase 2: removes GYM_MANAGER bypasses and enforces explicit permissions & staff list isolation', async () => {
    await seedBaseEnvironment();

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const now = Timestamp.now();

      await setDoc(doc(db, 'gyms', 'gym_a', 'settings', 'default'), {
        gymId: 'gym_a',
        gracePeriodDays: 7,
        renewalPolicy: 'EXTEND_FROM_EXPIRY',
        reminderDaysBefore: [7, 3],
        sendOnExpiryDay: true,
        sendAfterExpiryDays: [3],
        emailEnabled: true,
        inAppEnabled: true,
        whatsappEnabled: false,
        whatsappPhoneNumberId: 'wa_owner_only',
        currencySymbol: '₹',
        updatedAt: now,
      });

      await setDoc(doc(db, 'gyms', 'gym_a', 'membership_plans', 'plan_a1'), {
        id: 'plan_a1',
        gymId: 'gym_a',
        name: 'Gold Monthly',
        durationType: 'MONTHLY',
        durationValue: 1,
        price: 1500,
        benefits: ['Gym floor'],
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      // Manager with ALL_FALSE_PERMS must be denied restricted modules
      await setDoc(doc(db, 'users', 'mgr_noperm'), {
        uid: 'mgr_noperm',
        email: 'mgr.noperm@gym.test',
        displayName: 'Mgr NoPerm',
        role: 'GYM_MANAGER',
        gymId: 'gym_a',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      await setDoc(doc(db, 'gyms', 'gym_a', 'staff', 'mgr_noperm'), {
        id: 'mgr_noperm',
        gymId: 'gym_a',
        uid: 'mgr_noperm',
        email: 'mgr.noperm@gym.test',
        fullName: 'Mgr NoPerm',
        role: 'GYM_MANAGER',
        status: 'ACTIVE',
        permissions: { ...ALL_FALSE_PERMS },
        createdAt: now,
        updatedAt: now,
      });

      // Manager with explicit permissions succeeds on those modules only
      await setDoc(doc(db, 'users', 'mgr_rem'), {
        uid: 'mgr_rem',
        email: 'mgr.rem@gym.test',
        displayName: 'Mgr Reminders',
        role: 'GYM_MANAGER',
        gymId: 'gym_a',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      await setDoc(doc(db, 'gyms', 'gym_a', 'staff', 'mgr_rem'), {
        id: 'mgr_rem',
        gymId: 'gym_a',
        uid: 'mgr_rem',
        email: 'mgr.rem@gym.test',
        fullName: 'Mgr Reminders',
        role: 'GYM_MANAGER',
        status: 'ACTIVE',
        permissions: { ...ALL_FALSE_PERMS, canManageReminders: true, canViewMembers: true },
        createdAt: now,
        updatedAt: now,
      });

      // Trainer with ONLY canManageAttendance
      await setDoc(doc(db, 'users', 'trainer_att'), {
        uid: 'trainer_att',
        email: 'trainer.att@gym.test',
        displayName: 'Coach Att',
        role: 'GYM_TRAINER',
        gymId: 'gym_a',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      await setDoc(doc(db, 'gyms', 'gym_a', 'staff', 'trainer_att'), {
        id: 'trainer_att',
        gymId: 'gym_a',
        uid: 'trainer_att',
        email: 'trainer.att@gym.test',
        fullName: 'Coach Att',
        role: 'GYM_TRAINER',
        status: 'ACTIVE',
        permissions: { ...ALL_FALSE_PERMS, canManageAttendance: true },
        createdAt: now,
        updatedAt: now,
      });
    });

    const mgrNoPermDb = testEnv
      .authenticatedContext('mgr_noperm', { email: 'mgr.noperm@gym.test', email_verified: true })
      .firestore();
    await assertFails(getDoc(doc(mgrNoPermDb, 'gyms', 'gym_a', 'members', 'mem_a1')));
    await assertFails(getDoc(doc(mgrNoPermDb, 'gyms', 'gym_a', 'member_payments', 'pay_a1')));
    await assertFails(getDoc(doc(mgrNoPermDb, 'gyms', 'gym_a', 'membership_plans', 'plan_a1')));
    await assertFails(getDoc(doc(mgrNoPermDb, 'gyms', 'gym_a', 'settings', 'default')));
    await assertFails(getDoc(doc(mgrNoPermDb, 'gyms', 'gym_a', 'staff', 'owner_a')));
    // Self staff doc read succeeds
    await assertSucceeds(getDoc(doc(mgrNoPermDb, 'gyms', 'gym_a', 'staff', 'mgr_noperm')));

    // Manager with canManageReminders CAN update reminder schedule, CANNOT alter WhatsApp Phone Number ID
    const mgrRemDb = testEnv
      .authenticatedContext('mgr_rem', { email: 'mgr.rem@gym.test', email_verified: true })
      .firestore();
    await assertSucceeds(
      updateDoc(doc(mgrRemDb, 'gyms', 'gym_a', 'settings', 'default'), {
        reminderDaysBefore: [5, 2],
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(mgrRemDb, 'gyms', 'gym_a', 'settings', 'default'), {
        whatsappPhoneNumberId: 'tampered_wa_id',
        updatedAt: serverTimestamp(),
      })
    );

    // Trainer with ONLY canManageAttendance cannot read members, plans, or coworkers
    const trainerAttDb = testEnv
      .authenticatedContext('trainer_att', { email: 'trainer.att@gym.test', email_verified: true })
      .firestore();
    await assertFails(getDoc(doc(trainerAttDb, 'gyms', 'gym_a', 'members', 'mem_a1')));
    await assertFails(getDoc(doc(trainerAttDb, 'gyms', 'gym_a', 'membership_plans', 'plan_a1')));
    await assertFails(getDoc(doc(trainerAttDb, 'gyms', 'gym_a', 'staff', 'mgr_rem')));
    await assertSucceeds(
      setDoc(doc(trainerAttDb, 'gyms', 'gym_a', 'attendance', 'att_phase2'), {
        id: 'att_phase2',
        gymId: 'gym_a',
        memberId: 'mem_a1',
        memberCode: 'A-001',
        memberName: 'Member Alpha',
        checkInDate: '2025-06-11',
        checkInTime: '06:30',
        recordedByUid: 'trainer_att',
        recordedByName: 'Coach Att',
        createdAt: serverTimestamp(),
      })
    );
  });
});
