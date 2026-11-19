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
  canViewReports: false,
  canViewPayments: false,
  canRecordPayments: false,
  canManagePlans: false,
  canConfirmPayments: false,
  canDeleteMembers: false,
  canManageReminders: false,
  canManageAttendance: false,
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
      permissions: {
        canViewReports: true,
        canViewPayments: true,
        canRecordPayments: true,
        canManagePlans: true,
        canConfirmPayments: true,
        canDeleteMembers: true,
        canManageReminders: true,
        canManageAttendance: true,
      },
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
        permissions: { ...ALL_FALSE_PERMS, canViewReports: true, canConfirmPayments: true },
        status: 'PENDING',
        invitedByUid: 'admin_1',
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
});
