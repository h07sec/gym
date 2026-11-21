import { describe, expect, it } from 'vitest';
import { BootstrapController } from '../server/bootstrap-service';
import type {
  DbClient,
  DbCollection,
  DbDocRef,
  DbDocSnap,
  DbQuery,
  DbQueryDocSnap,
  DbQuerySnap,
  DbTransaction,
} from '../server/firestore-types';
import {
  authorizeAndResolveNotificationDispatch,
  HttpError,
} from '../server/notification-guard';
import { SlidingWindowRateLimiter } from '../server/rate-limiter';
import { ReminderWorker } from '../server/reminder-worker';
import {
  AccountStatus,
  DeliveryStatus,
  MembershipActionType,
  MembershipRecordStatus,
  MembershipStatus,
  ReminderCategory,
  ReminderChannel,
  RenewalPolicy,
  SubscriptionStatus,
  UserRole,
  UserStatus,
} from '../types/gymos';

type StoreMap = Map<string, Record<string, unknown>>;

class MemoryDocRef implements DbDocRef {
  readonly id: string;
  readonly path: string;
  private readonly store: StoreMap;

  constructor(path: string, store: StoreMap) {
    this.path = path;
    const parts = path.split('/');
    this.id = parts[parts.length - 1];
    this.store = store;
  }

  collection(name: string): DbCollection {
    return new MemoryQuery(`${this.path}/${name}`, this.store);
  }

  async get(): Promise<DbDocSnap> {
    const raw = this.store.get(this.path);
    const dataCopy = raw ? structuredClone(raw) : undefined;
    return {
      id: this.id,
      exists: Boolean(raw),
      ref: this,
      data: () => dataCopy,
    };
  }

  async set(
    data: Record<string, unknown>,
    options?: { merge?: boolean }
  ): Promise<void> {
    if (options?.merge && this.store.has(this.path)) {
      this.store.set(this.path, {
        ...this.store.get(this.path)!,
        ...structuredClone(data),
      });
    } else {
      this.store.set(this.path, structuredClone(data));
    }
  }

  async update(data: Record<string, unknown>): Promise<void> {
    const current = this.store.get(this.path);
    if (!current) {
      throw new Error(`Document ${this.path} not found for update.`);
    }
    this.store.set(this.path, {
      ...current,
      ...structuredClone(data),
    });
  }
}

interface QueryFilter {
  field: string;
  op: '==' | '<=' | '<' | '>' | '>=';
  value: unknown;
}

class MemoryQuery implements DbCollection {
  private readonly collectionPath: string;
  private readonly store: StoreMap;
  private readonly filters: QueryFilter[];
  private readonly orderField: string | null;
  private readonly orderDir: 'asc' | 'desc';
  private readonly maxResults: number | null;
  private readonly cursor: unknown;

  constructor(
    collectionPath: string,
    store: StoreMap,
    opts?: {
      filters?: QueryFilter[];
      orderField?: string | null;
      orderDir?: 'asc' | 'desc';
      maxResults?: number | null;
      cursor?: unknown;
    }
  ) {
    this.collectionPath = collectionPath;
    this.store = store;
    this.filters = opts?.filters ?? [];
    this.orderField = opts?.orderField ?? null;
    this.orderDir = opts?.orderDir ?? 'asc';
    this.maxResults = opts?.maxResults ?? null;
    this.cursor = opts?.cursor ?? null;
  }

  doc(id?: string): DbDocRef {
    const resolvedId = id || `auto_${Math.random().toString(36).slice(2, 10)}`;
    return new MemoryDocRef(`${this.collectionPath}/${resolvedId}`, this.store);
  }

  where(
    fieldPath: string,
    opStr: '==' | '<=' | '<' | '>' | '>=',
    value: unknown
  ): DbQuery {
    return new MemoryQuery(this.collectionPath, this.store, {
      filters: [...this.filters, { field: fieldPath, op: opStr, value }],
      orderField: this.orderField,
      orderDir: this.orderDir,
      maxResults: this.maxResults,
      cursor: this.cursor,
    });
  }

  orderBy(fieldPath: string, directionStr: 'asc' | 'desc' = 'asc'): DbQuery {
    return new MemoryQuery(this.collectionPath, this.store, {
      filters: this.filters,
      orderField: fieldPath,
      orderDir: directionStr,
      maxResults: this.maxResults,
      cursor: this.cursor,
    });
  }

  limit(n: number): DbQuery {
    return new MemoryQuery(this.collectionPath, this.store, {
      filters: this.filters,
      orderField: this.orderField,
      orderDir: this.orderDir,
      maxResults: n,
      cursor: this.cursor,
    });
  }

  startAfter(...fieldValues: unknown[]): DbQuery {
    return new MemoryQuery(this.collectionPath, this.store, {
      filters: this.filters,
      orderField: this.orderField,
      orderDir: this.orderDir,
      maxResults: this.maxResults,
      cursor: fieldValues[0],
    });
  }

  async get(): Promise<DbQuerySnap> {
    const prefix = `${this.collectionPath}/`;
    const depth = this.collectionPath.split('/').length + 1;
    let items: Array<{ docId: string; ref: MemoryDocRef; data: Record<string, unknown> }> = [];

    for (const [docPath, raw] of this.store.entries()) {
      if (!docPath.startsWith(prefix)) continue;
      if (docPath.split('/').length !== depth) continue;
      const docId = docPath.slice(prefix.length);

      let matches = true;
      for (const f of this.filters) {
        const val = raw[f.field];
        if (f.op === '==' && val !== f.value) matches = false;
        if (f.op === '<=' && !(Number(val) <= Number(f.value))) matches = false;
        if (f.op === '<' && !(Number(val) < Number(f.value))) matches = false;
        if (f.op === '>' && !(Number(val) > Number(f.value))) matches = false;
        if (f.op === '>=' && !(Number(val) >= Number(f.value))) matches = false;
      }
      if (!matches) continue;

      items.push({
        docId,
        ref: new MemoryDocRef(docPath, this.store),
        data: structuredClone(raw),
      });
    }

    const sortField = this.orderField;
    items.sort((a, b) => {
      const av = sortField ? String(a.data[sortField] ?? a.docId) : a.docId;
      const bv = sortField ? String(b.data[sortField] ?? b.docId) : b.docId;
      return this.orderDir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
    });

    if (this.cursor !== null && this.cursor !== undefined) {
      const cursorObj = this.cursor as { id?: string; data?: () => Record<string, unknown> };
      const cursorId = typeof cursorObj?.id === 'string' ? cursorObj.id : null;
      if (cursorId) {
        const idx = items.findIndex((item) => item.docId === cursorId);
        if (idx >= 0) {
          items = items.slice(idx + 1);
        }
      } else {
        const cursorStr = String(this.cursor);
        items = items.filter((item) => {
          const v = sortField ? String(item.data[sortField] ?? item.docId) : item.docId;
          return v > cursorStr;
        });
      }
    }

    if (this.maxResults !== null) {
      items = items.slice(0, this.maxResults);
    }

    const docs: DbQueryDocSnap[] = items.map((item) => ({
      id: item.docId,
      exists: true,
      ref: item.ref,
      data: () => item.data,
    }));

    return { empty: docs.length === 0, docs };
  }
}

class InMemoryFirestore implements DbClient {
  readonly store: StoreMap = new Map();
  private txQueue: Promise<unknown> = Promise.resolve();

  collection(path: string): DbCollection {
    return new MemoryQuery(path, this.store);
  }

  async runTransaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const pendingOps: Array<() => Promise<void>> = [];
      const tx: DbTransaction = {
        get: (target: DbDocRef | DbQuery) => {
          if ('collection' in target) {
            return (target as DbDocRef).get();
          }
          return (target as DbQuery).get();
        },
        set: (ref: DbDocRef, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          pendingOps.push(async () => {
            await ref.set(data, options);
          });
        },
        update: (ref: DbDocRef, data: Record<string, unknown>) => {
          pendingOps.push(async () => {
            await ref.update(data);
          });
        },
      } as DbTransaction;

      const result = await fn(tx);
      for (const op of pendingOps) {
        await op();
      }
      return result;
    };

    const next = this.txQueue.then(run, run);
    this.txQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  listAuditLogs(): Array<Record<string, unknown>> {
    const logs: Array<Record<string, unknown>> = [];
    for (const [k, v] of this.store.entries()) {
      if (k.startsWith('audit_logs/')) logs.push(v);
    }
    return logs;
  }
}

function seedMultiTenantNotificationFixtures(db: InMemoryFirestore) {
  const futureDate = '2099-12-31';
  db.store.set('gyms/gym_a', {
    id: 'gym_a',
    name: 'Alpha Athletics',
    ownerUid: 'owner_a',
    ownerName: 'Alpha Owner',
    email: 'owner.a@alpha.test',
    phone: '9876543210',
    accountStatus: AccountStatus.ACTIVE,
    subscriptionStatus: SubscriptionStatus.ACTIVE,
    subscriptionPlanId: 'plan_m',
    subscriptionPlanName: 'Monthly',
    subscriptionStartAt: '2025-01-01',
    subscriptionEndAt: futureDate,
    subscriptionAccessUntil: new Date('2099-12-31T23:59:59.000Z'),
    gracePeriodDays: 7,
    renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
  });

  db.store.set('gyms/gym_a/settings/default', {
    gymId: 'gym_a',
    emailEnabled: true,
    emailFromName: 'Alpha Desk',
    inAppEnabled: true,
    whatsappEnabled: true,
    whatsappPhoneNumberId: 'wa_phone_trusted_a',
    whatsappApprovedTemplate: 'alpha_renewal_v1',
    currencySymbol: '₹',
  });

  db.store.set('gyms/gym_b', {
    id: 'gym_b',
    name: 'Beta Barbell',
    ownerUid: 'owner_b',
    ownerName: 'Beta Owner',
    email: 'owner.b@beta.test',
    phone: '9876543211',
    accountStatus: AccountStatus.ACTIVE,
    subscriptionStatus: SubscriptionStatus.ACTIVE,
    subscriptionPlanId: 'plan_m',
    subscriptionPlanName: 'Monthly',
    subscriptionStartAt: '2025-01-01',
    subscriptionEndAt: futureDate,
    subscriptionAccessUntil: new Date('2099-12-31T23:59:59.000Z'),
    gracePeriodDays: 7,
    renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
  });

  // Users & staff
  db.store.set('users/owner_a', {
    uid: 'owner_a',
    email: 'owner.a@alpha.test',
    displayName: 'Alpha Owner',
    role: UserRole.GYM_OWNER,
    gymId: 'gym_a',
    status: UserStatus.ACTIVE,
  });
  db.store.set('users/recep_perm', {
    uid: 'recep_perm',
    email: 'recep1@alpha.test',
    displayName: 'Recep Allowed',
    role: UserRole.GYM_RECEPTIONIST,
    gymId: 'gym_a',
    status: UserStatus.ACTIVE,
  });
  db.store.set('gyms/gym_a/staff/recep_perm', {
    id: 'recep_perm',
    gymId: 'gym_a',
    uid: 'recep_perm',
    role: UserRole.GYM_RECEPTIONIST,
    status: UserStatus.ACTIVE,
    permissions: { canManageReminders: true },
  });

  db.store.set('users/trainer_noperm', {
    uid: 'trainer_noperm',
    email: 'trainer@alpha.test',
    displayName: 'Trainer NoPerm',
    role: UserRole.GYM_TRAINER,
    gymId: 'gym_a',
    status: UserStatus.ACTIVE,
  });
  db.store.set('gyms/gym_a/staff/trainer_noperm', {
    id: 'trainer_noperm',
    gymId: 'gym_a',
    uid: 'trainer_noperm',
    role: UserRole.GYM_TRAINER,
    status: UserStatus.ACTIVE,
    permissions: { canManageReminders: false, canManageAttendance: true },
  });

  db.store.set('users/deactivated_staff', {
    uid: 'deactivated_staff',
    email: 'former@alpha.test',
    displayName: 'Former Staff',
    role: UserRole.GYM_MANAGER,
    gymId: 'gym_a',
    status: UserStatus.ACTIVE,
  });
  db.store.set('gyms/gym_a/staff/deactivated_staff', {
    id: 'deactivated_staff',
    gymId: 'gym_a',
    uid: 'deactivated_staff',
    role: UserRole.GYM_MANAGER,
    status: UserStatus.DEACTIVATED,
    permissions: { canManageReminders: true },
  });

  db.store.set('users/manager_noperm', {
    uid: 'manager_noperm',
    email: 'mgr.noperm@alpha.test',
    displayName: 'Manager NoPerm',
    role: UserRole.GYM_MANAGER,
    gymId: 'gym_a',
    status: UserStatus.ACTIVE,
  });
  db.store.set('gyms/gym_a/staff/manager_noperm', {
    id: 'manager_noperm',
    gymId: 'gym_a',
    uid: 'manager_noperm',
    role: UserRole.GYM_MANAGER,
    status: UserStatus.ACTIVE,
    permissions: { canManageReminders: false },
  });

  db.store.set('users/manager_perm', {
    uid: 'manager_perm',
    email: 'mgr.perm@alpha.test',
    displayName: 'Manager Perm',
    role: UserRole.GYM_MANAGER,
    gymId: 'gym_a',
    status: UserStatus.ACTIVE,
  });
  db.store.set('gyms/gym_a/staff/manager_perm', {
    id: 'manager_perm',
    gymId: 'gym_a',
    uid: 'manager_perm',
    role: UserRole.GYM_MANAGER,
    status: UserStatus.ACTIVE,
    permissions: { canManageReminders: true },
  });

  // Members
  db.store.set('gyms/gym_a/members/mem_a1', {
    id: 'mem_a1',
    gymId: 'gym_a',
    memberCode: 'A-001',
    fullName: 'Riya Sharma',
    phone: '+919876500001',
    email: 'riya@member.test',
    reminderOptOut: false,
    isArchived: false,
  });
  db.store.set('gyms/gym_a/members/mem_optout', {
    id: 'mem_optout',
    gymId: 'gym_a',
    memberCode: 'A-002',
    fullName: 'Opted Out',
    phone: '+919876500002',
    email: 'optout@member.test',
    reminderOptOut: true,
    isArchived: false,
  });
  db.store.set('gyms/gym_b/members/mem_b1', {
    id: 'mem_b1',
    gymId: 'gym_b',
    memberCode: 'B-001',
    fullName: 'Beta Member',
    phone: '+919876500099',
    email: 'beta@member.test',
    reminderOptOut: false,
    isArchived: false,
  });
}

describe('Server Security — Notification API Authorization & Rate Limiting', () => {
  const ts = () => 'SERVER_TS';

  it('authorizes gym owner & permitted staff and resolves recipient/WhatsApp settings strictly from DB', async () => {
    const db = new InMemoryFirestore();
    seedMultiTenantNotificationFixtures(db);
    const limiter = new SlidingWindowRateLimiter();

    const ownerEmailDispatch = await authorizeAndResolveNotificationDispatch({
      db,
      rateLimiter: limiter,
      actor: { uid: 'owner_a', email: 'owner.a@alpha.test', emailVerified: true },
      body: {
        gymId: 'gym_a',
        memberId: 'mem_a1',
        channel: ReminderChannel.EMAIL,
        subject: 'Renewal Notice\r\nInjectedHeader: bad',
        message: 'Your plan expires in 3 days.',
      },
      serverTimestamp: ts,
    });
    expect(ownerEmailDispatch.recipient).toBe('riya@member.test');
    expect(ownerEmailDispatch.fromName).toBe('Alpha Desk');
    expect(ownerEmailDispatch.subject).not.toContain('\r');
    expect(ownerEmailDispatch.subject).not.toContain('\n');

    const staffWaDispatch = await authorizeAndResolveNotificationDispatch({
      db,
      rateLimiter: limiter,
      actor: { uid: 'recep_perm', email: 'recep1@alpha.test', emailVerified: true },
      body: {
        gymId: 'gym_a',
        memberId: 'mem_a1',
        channel: ReminderChannel.WHATSAPP_CLOUD,
        subject: 'WhatsApp Renewal',
        message: 'Renew today.',
      },
      serverTimestamp: ts,
    });
    expect(staffWaDispatch.recipient).toBe('+919876500001');
    expect(staffWaDispatch.whatsappPhoneNumberId).toBe('wa_phone_trusted_a');
    expect(staffWaDispatch.whatsappApprovedTemplate).toBe('alpha_renewal_v1');

    expect(
      db.listAuditLogs().filter((l) => l.action === 'SEND_NOTIFICATION')
    ).toHaveLength(2);
  });

  it('blocks unauthorized roles, deactivated staff, cross-tenant sends, and recipient/config spoofing with audit logs', async () => {
    const db = new InMemoryFirestore();
    seedMultiTenantNotificationFixtures(db);
    const limiter = new SlidingWindowRateLimiter();

    // Unprivileged trainer
    await expect(
      authorizeAndResolveNotificationDispatch({
        db,
        rateLimiter: limiter,
        actor: { uid: 'trainer_noperm', email: 'trainer@alpha.test', emailVerified: true },
        body: { gymId: 'gym_a', memberId: 'mem_a1', channel: 'EMAIL', message: 'Hi' },
        serverTimestamp: ts,
      })
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN_NOTIFICATION_ROLE' });

    // Deactivated staff
    await expect(
      authorizeAndResolveNotificationDispatch({
        db,
        rateLimiter: limiter,
        actor: { uid: 'deactivated_staff', email: 'former@alpha.test', emailVerified: true },
        body: { gymId: 'gym_a', memberId: 'mem_a1', channel: 'EMAIL', message: 'Hi' },
        serverTimestamp: ts,
      })
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN_NOTIFICATION_ROLE' });

    // Cross-tenant attempt (Gym A owner targeting Gym B)
    await expect(
      authorizeAndResolveNotificationDispatch({
        db,
        rateLimiter: limiter,
        actor: { uid: 'owner_a', email: 'owner.a@alpha.test', emailVerified: true },
        body: { gymId: 'gym_b', memberId: 'mem_b1', channel: 'EMAIL', message: 'Spam' },
        serverTimestamp: ts,
      })
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN_NOTIFICATION_ROLE' });

    // Spoofed arbitrary recipient
    await expect(
      authorizeAndResolveNotificationDispatch({
        db,
        rateLimiter: limiter,
        actor: { uid: 'owner_a', email: 'owner.a@alpha.test', emailVerified: true },
        body: {
          gymId: 'gym_a',
          memberId: 'mem_a1',
          channel: 'EMAIL',
          recipient: 'external-victim@gmail.com',
          message: 'Phishing relay attempt',
        },
        serverTimestamp: ts,
      })
    ).rejects.toMatchObject({ status: 403, code: 'RECIPIENT_MISMATCH' });

    // Spoofed WhatsApp Phone Number ID
    await expect(
      authorizeAndResolveNotificationDispatch({
        db,
        rateLimiter: limiter,
        actor: { uid: 'owner_a', email: 'owner.a@alpha.test', emailVerified: true },
        body: {
          gymId: 'gym_a',
          memberId: 'mem_a1',
          channel: 'WHATSAPP_CLOUD',
          whatsappPhoneNumberId: 'rogue_phone_id_999',
          message: 'Spoofed phone id',
        },
        serverTimestamp: ts,
      })
    ).rejects.toMatchObject({ status: 403, code: 'CONFIG_MISMATCH' });

    // Opted-out member rejected
    await expect(
      authorizeAndResolveNotificationDispatch({
        db,
        rateLimiter: limiter,
        actor: { uid: 'owner_a', email: 'owner.a@alpha.test', emailVerified: true },
        body: { gymId: 'gym_a', memberId: 'mem_optout', channel: 'EMAIL', message: 'Hi' },
        serverTimestamp: ts,
      })
    ).rejects.toMatchObject({ status: 400, code: 'MEMBER_OPTED_OUT' });

    // Manager WITHOUT canManageReminders is rejected (no blanket role bypass)
    await expect(
      authorizeAndResolveNotificationDispatch({
        db,
        rateLimiter: limiter,
        actor: { uid: 'manager_noperm', email: 'mgr.noperm@alpha.test', emailVerified: true },
        body: { gymId: 'gym_a', memberId: 'mem_a1', channel: 'EMAIL', message: 'Hi' },
        serverTimestamp: ts,
      })
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN_NOTIFICATION_ROLE' });

    // Manager WITH canManageReminders succeeds
    const mgrPermDispatch = await authorizeAndResolveNotificationDispatch({
      db,
      rateLimiter: limiter,
      actor: { uid: 'manager_perm', email: 'mgr.perm@alpha.test', emailVerified: true },
      body: { gymId: 'gym_a', memberId: 'mem_a1', channel: 'EMAIL', message: 'Friendly reminder' },
      serverTimestamp: ts,
    });
    expect(mgrPermDispatch.recipient).toBe('riya@member.test');

    // Gym missing subscriptionAccessUntil fails closed
    const gymNoAccess = { ...db.store.get('gyms/gym_a')! };
    delete gymNoAccess.subscriptionAccessUntil;
    db.store.set('gyms/gym_a', gymNoAccess);
    await expect(
      authorizeAndResolveNotificationDispatch({
        db,
        rateLimiter: limiter,
        actor: { uid: 'owner_a', email: 'owner.a@alpha.test', emailVerified: true },
        body: { gymId: 'gym_a', memberId: 'mem_a1', channel: 'EMAIL', message: 'Hi' },
        serverTimestamp: ts,
      })
    ).rejects.toMatchObject({ status: 403, code: 'GYM_INACTIVE' });

    // Suspended gym rejected
    db.store.set('gyms/gym_a', {
      ...db.store.get('gyms/gym_a')!,
      subscriptionAccessUntil: new Date('2099-12-31T23:59:59.000Z'),
      accountStatus: AccountStatus.SUSPENDED,
    });
    await expect(
      authorizeAndResolveNotificationDispatch({
        db,
        rateLimiter: limiter,
        actor: { uid: 'owner_a', email: 'owner.a@alpha.test', emailVerified: true },
        body: { gymId: 'gym_a', memberId: 'mem_a1', channel: 'EMAIL', message: 'Hi' },
        serverTimestamp: ts,
      })
    ).rejects.toMatchObject({ status: 403, code: 'GYM_INACTIVE' });

    const auditActions = db.listAuditLogs().map((a) => a.action);
    expect(auditActions).toContain('NOTIFICATION_SEND_DENIED');
    expect(auditActions).toContain('NOTIFICATION_RECIPIENT_MISMATCH');
    expect(auditActions).toContain('NOTIFICATION_CONFIG_TAMPER');
    expect(auditActions).toContain('NOTIFICATION_GYM_INACTIVE');
  });

  it('enforces per-user rate limits on /api/notifications/send and fails closed when Admin DB is unavailable', async () => {
    const db = new InMemoryFirestore();
    seedMultiTenantNotificationFixtures(db);
    const limiter = new SlidingWindowRateLimiter();
    const baseMs = Date.parse('2025-06-10T09:00:00.000Z');

    await expect(
      authorizeAndResolveNotificationDispatch({
        db: null,
        rateLimiter: limiter,
        actor: { uid: 'owner_a', email: 'owner.a@alpha.test', emailVerified: true },
        body: { gymId: 'gym_a', memberId: 'mem_a1', channel: 'EMAIL', message: 'Hi' },
        serverTimestamp: ts,
      })
    ).rejects.toBeInstanceOf(HttpError);

    for (let i = 0; i < 25; i++) {
      await authorizeAndResolveNotificationDispatch({
        db,
        rateLimiter: limiter,
        actor: { uid: 'owner_a', email: 'owner.a@alpha.test', emailVerified: true },
        body: { gymId: 'gym_a', memberId: 'mem_a1', channel: 'EMAIL', message: `Reminder ${i}` },
        serverTimestamp: ts,
        nowMs: baseMs + i * 100,
      });
    }

    await expect(
      authorizeAndResolveNotificationDispatch({
        db,
        rateLimiter: limiter,
        actor: { uid: 'owner_a', email: 'owner.a@alpha.test', emailVerified: true },
        body: { gymId: 'gym_a', memberId: 'mem_a1', channel: 'EMAIL', message: 'Over limit' },
        serverTimestamp: ts,
        nowMs: baseMs + 5000,
      })
    ).rejects.toMatchObject({ status: 429, code: 'USER_RATE_LIMITED' });
  });
});

describe('Server Security — One-Time Super Admin Bootstrap', () => {
  const ts = () => 'SERVER_TS';

  it('requires allowlisted email + token, invalidates token after one-time success, blocks concurrent/repeat requests, and rate-limits', async () => {
    const db = new InMemoryFirestore();
    const limiter = new SlidingWindowRateLimiter();
    const ctrl = new BootstrapController();

    let configuredToken = 'super-secret-bootstrap-token-123';
    let configuredEmail = 'founder@gymos.io';
    const invalidate = () => {
      configuredToken = '';
      configuredEmail = '';
    };

    // Non-allowlisted email rejected even with valid token
    await expect(
      ctrl.executeWebBootstrap({
        db,
        rateLimiter: limiter,
        clientIp: '10.0.0.1',
        actor: { uid: 'attacker', email: 'attacker@evil.test', emailVerified: true },
        bootstrapToken: configuredToken,
        configuredToken,
        configuredEmail,
        serverTimestamp: ts,
        onSuccessInvalidateSecrets: invalidate,
      })
    ).rejects.toMatchObject({ status: 403, code: 'BOOTSTRAP_UNAUTHORIZED' });

    // Wrong token rejected even for allowlisted email
    await expect(
      ctrl.executeWebBootstrap({
        db,
        rateLimiter: limiter,
        clientIp: '10.0.0.2',
        actor: { uid: 'founder_uid', email: 'founder@gymos.io', emailVerified: true },
        bootstrapToken: 'wrong-token',
        configuredToken,
        configuredEmail,
        serverTimestamp: ts,
        onSuccessInvalidateSecrets: invalidate,
      })
    ).rejects.toMatchObject({ status: 403, code: 'BOOTSTRAP_UNAUTHORIZED' });

    // Concurrent race: two simultaneous bootstrap calls -> exactly one succeeds
    const [r1, r2] = await Promise.allSettled([
      ctrl.executeWebBootstrap({
        db,
        rateLimiter: limiter,
        clientIp: '10.0.0.3',
        actor: { uid: 'founder_uid', email: 'founder@gymos.io', emailVerified: true },
        displayName: 'Founder Admin',
        bootstrapToken: configuredToken,
        configuredToken,
        configuredEmail,
        serverTimestamp: ts,
        onSuccessInvalidateSecrets: invalidate,
      }),
      ctrl.executeWebBootstrap({
        db,
        rateLimiter: limiter,
        clientIp: '10.0.0.4',
        actor: { uid: 'founder_uid', email: 'founder@gymos.io', emailVerified: true },
        displayName: 'Founder Admin',
        bootstrapToken: configuredToken,
        configuredToken,
        configuredEmail,
        serverTimestamp: ts,
        onSuccessInvalidateSecrets: invalidate,
      }),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(ctrl.isCompleted).toBe(true);
    expect(configuredToken).toBe('');
    expect(configuredEmail).toBe('');
    expect(db.store.get('platform_bootstrap/default')?.completed).toBe(true);
    expect(db.store.get('platform_admins/founder_uid')?.email).toBe('founder@gymos.io');
    expect(db.store.get('users/founder_uid')?.role).toBe('SUPER_ADMIN');

    // Fresh controller (e.g. server restart) reads persistent lock and refuses reuse even if env vars were left set
    const freshCtrl = new BootstrapController();
    await freshCtrl.syncFromDatabase(db);
    expect(freshCtrl.isCompleted).toBe(true);
    expect(freshCtrl.isWebBootstrapEnabled('leftover-token', 'founder@gymos.io')).toBe(false);

    await expect(
      freshCtrl.executeWebBootstrap({
        db,
        rateLimiter: new SlidingWindowRateLimiter(),
        clientIp: '10.0.0.5',
        actor: { uid: 'other_uid', email: 'founder@gymos.io', emailVerified: true },
        bootstrapToken: 'leftover-token',
        configuredToken: 'leftover-token',
        configuredEmail: 'founder@gymos.io',
        serverTimestamp: ts,
        onSuccessInvalidateSecrets: () => undefined,
      })
    ).rejects.toMatchObject({ status: 409, code: 'BOOTSTRAP_ALREADY_COMPLETED' });

    // Rate limiting after 5 failed attempts on a fresh IP/UID
    const rlCtrl = new BootstrapController();
    const rlLimiter = new SlidingWindowRateLimiter();
    for (let i = 0; i < 5; i++) {
      await expect(
        rlCtrl.executeWebBootstrap({
          db: new InMemoryFirestore(),
          rateLimiter: rlLimiter,
          clientIp: '192.168.1.99',
          actor: { uid: 'brute_uid', email: 'founder@gymos.io', emailVerified: true },
          bootstrapToken: `guess_${i}`,
          configuredToken: 'real-secret',
          configuredEmail: 'founder@gymos.io',
          serverTimestamp: ts,
          onSuccessInvalidateSecrets: () => undefined,
        })
      ).rejects.toMatchObject({ status: 403 });
    }
    await expect(
      rlCtrl.executeWebBootstrap({
        db: new InMemoryFirestore(),
        rateLimiter: rlLimiter,
        clientIp: '192.168.1.99',
        actor: { uid: 'brute_uid', email: 'founder@gymos.io', emailVerified: true },
        bootstrapToken: 'real-secret',
        configuredToken: 'real-secret',
        configuredEmail: 'founder@gymos.io',
        serverTimestamp: ts,
        onSuccessInvalidateSecrets: () => undefined,
      })
    ).rejects.toMatchObject({ status: 429, code: 'BOOTSTRAP_RATE_LIMITED' });
  });
});

describe('Automated Backend Reminder Worker — Generation, Retries, Backoff & Locks', () => {
  const ts = () => 'SERVER_TS';

  it('generates due reminders across paginated gyms, prevents duplicates, and handles exponential retry backoff until SENT or FAILED', async () => {
    const db = new InMemoryFirestore();

    // Seed 55 gyms (> page size 50) to verify gym pagination works end-to-end;
    // 53 suspended gyms + 1 active gym + 1 expired gym
    for (let i = 1; i <= 53; i++) {
      const gid = `gym_susp_${String(i).padStart(2, '0')}`;
      db.store.set(`gyms/${gid}`, {
        id: gid,
        name: `Suspended ${i}`,
        ownerUid: `u_${i}`,
        ownerName: `Owner ${i}`,
        email: `s${i}@gym.test`,
        phone: '9000000000',
        accountStatus: AccountStatus.SUSPENDED,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        subscriptionStartAt: '2025-01-01',
        subscriptionEndAt: '2099-12-31',
        gracePeriodDays: 7,
        renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
      });
    }

    // Active gym with expiring member, opted-out member, and overdue payment member
    db.store.set('gyms/gym_z_active', {
      id: 'gym_z_active',
      name: 'Zenith Gym',
      ownerUid: 'owner_z',
      ownerName: 'Zara',
      email: 'zara@zenith.test',
      phone: '9876543210',
      accountStatus: AccountStatus.ACTIVE,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      subscriptionStartAt: '2025-05-01',
      subscriptionEndAt: '2025-06-13', // 3 days from 2025-06-10 -> triggers OWNER_SUB_EXPIRING_IN_3_DAYS
      subscriptionAccessUntil: new Date('2025-06-20T23:59:59.000Z'),
      gracePeriodDays: 7,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
    });
    db.store.set('gyms/gym_z_active/settings/default', {
      gymId: 'gym_z_active',
      gracePeriodDays: 7,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
      reminderDaysBefore: [3],
      sendOnExpiryDay: true,
      sendAfterExpiryDays: [],
      paymentRemindersEnabled: true,
      upcomingPaymentReminderDays: 2,
      overduePaymentReminderDays: [3],
      ownerSubReminderDays: [3, 0],
      emailEnabled: true,
      emailFromName: 'Zenith Desk',
      inAppEnabled: true,
      whatsappEnabled: false,
      currencySymbol: '₹',
    });
    db.store.set('gyms/gym_z_active/members/m1', {
      id: 'm1',
      gymId: 'gym_z_active',
      memberCode: 'Z-01',
      fullName: 'Aarav',
      phone: '9988776655',
      email: 'aarav@member.test',
      joiningDate: '2025-05-01',
      membershipExpiryDate: '2025-06-13', // 3 days left
      membershipStatus: MembershipStatus.EXPIRING_SOON,
      outstandingBalance: 1000,
      reminderOptOut: false,
      isArchived: false,
    });
    db.store.set('gyms/gym_z_active/members/m2_optout', {
      id: 'm2_optout',
      gymId: 'gym_z_active',
      memberCode: 'Z-02',
      fullName: 'Opted Out User',
      phone: '9988776656',
      email: 'opt@member.test',
      joiningDate: '2025-05-01',
      membershipExpiryDate: '2025-06-10', // today
      membershipStatus: MembershipStatus.EXPIRING_SOON,
      outstandingBalance: 0,
      reminderOptOut: true,
      isArchived: false,
    });
    db.store.set('gyms/gym_z_active/memberships/ms1', {
      id: 'ms1',
      gymId: 'gym_z_active',
      memberId: 'm1',
      memberName: 'Aarav',
      planId: 'p1',
      planName: 'Monthly',
      actionType: MembershipActionType.INITIAL,
      startDate: '2025-05-13',
      expiryDate: '2025-06-13',
      planPrice: 2000,
      amountPaid: 1000,
      balanceDue: 1000,
      dueDate: '2025-06-07', // 3 days overdue
      status: MembershipRecordStatus.ACTIVE,
      recordedByUid: 'owner_z',
    });

    // Expired active gym: member reminders skipped, ONLY owner billing reminder generated
    db.store.set('gyms/gym_z_expired', {
      id: 'gym_z_expired',
      name: 'Expired Gym',
      ownerUid: 'owner_exp',
      ownerName: 'Ex Owner',
      email: 'expired@gym.test',
      phone: '9876543299',
      accountStatus: AccountStatus.ACTIVE,
      subscriptionStatus: SubscriptionStatus.EXPIRED,
      subscriptionStartAt: '2025-05-01',
      subscriptionEndAt: '2025-06-07', // -3 days from 2025-06-10
      subscriptionAccessUntil: new Date('2025-06-08T00:00:00.000Z'),
      gracePeriodDays: 1,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
    });
    db.store.set('gyms/gym_z_expired/settings/default', {
      gymId: 'gym_z_expired',
      gracePeriodDays: 1,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
      reminderDaysBefore: [3],
      sendOnExpiryDay: true,
      sendAfterExpiryDays: [],
      ownerSubReminderDays: [7, 3, 0, -3],
      emailEnabled: true,
      inAppEnabled: true,
      whatsappEnabled: false,
      currencySymbol: '₹',
    });
    db.store.set('gyms/gym_z_expired/members/m_exp', {
      id: 'm_exp',
      gymId: 'gym_z_expired',
      memberCode: 'E-01',
      fullName: 'Should Be Skipped',
      phone: '9988776600',
      email: 'skip@member.test',
      joiningDate: '2025-05-01',
      membershipExpiryDate: '2025-06-13',
      membershipStatus: MembershipStatus.EXPIRING_SOON,
      outstandingBalance: 0,
      reminderOptOut: false,
      isArchived: false,
    });

    let emailShouldFail = true;
    let emailsDispatched = 0;
    const worker = new ReminderWorker({
      db,
      sendEmail: async ({ to }) => {
        emailsDispatched += 1;
        if (emailShouldFail) {
          return { delivered: false, errorDetails: `SMTP 550 temporary failure to ${to}` };
        }
        return {
          delivered: true,
          providerMessageId: `msg_${emailsDispatched}`,
          sentAt: new Date().toISOString(),
        };
      },
      sendWhatsApp: async () => ({ delivered: false, errorDetails: 'Not used' }),
      serverTimestamp: ts,
      intervalMinutes: 30,
      orderByField: 'id',
    });

    const t0 = Date.parse('2025-06-10T08:00:00.000Z');
    const sweep1 = await worker.sweep({ nowMs: t0 });

    expect(sweep1.skipped).toBe(false);
    expect(sweep1.gymsSkipped).toBe(53);
    expect(sweep1.gymsProcessed).toBe(2);
    expect(sweep1.newRemindersCreated).toBeGreaterThanOrEqual(8);
    expect(sweep1.skippedOptOut).toBe(2); // m2_optout IN_APP + EMAIL
    expect(sweep1.failed).toBeGreaterThanOrEqual(4); // m1 expiry + overdue + owner_z + owner_exp emails failed
    expect(db.store.get('gyms/gym_z_active/settings/default')?.lastReminderRunDate).toBe(
      '2025-06-10'
    );

    // Expired gym must NOT generate any member reminder for m_exp, ONLY owner_gym_z_expired
    const expiredGymLogs = [...db.store.entries()]
      .filter(([k]) => k.startsWith('gyms/gym_z_expired/notification_logs/'))
      .map(([, v]) => v);
    expect(expiredGymLogs.some((l) => l.memberId === 'm_exp')).toBe(false);
    expect(
      expiredGymLogs.some(
        (l) =>
          l.memberId === 'owner_gym_z_expired' &&
          l.category === ReminderCategory.SUBSCRIPTION_EXPIRY
      )
    ).toBe(true);

    // 5 minutes later (before 15-minute backoff): NO new reminders created AND NO premature retries!
    const tPlus5m = t0 + 5 * 60_000;
    const sweep2 = await worker.sweep({ nowMs: tPlus5m });
    expect(sweep2.newRemindersCreated).toBe(0);
    expect(sweep2.retriesAttempted).toBe(0);

    // 16 minutes later (+15m backoff elapsed): retries execute (fail again -> retryCount=1, nextRetryAt=+60m)
    const tPlus16m = t0 + 16 * 60_000;
    const sweep3 = await worker.sweep({ nowMs: tPlus16m });
    expect(sweep3.retriesAttempted).toBe(3); // 3 active-gym failed email logs (expired gym doesn't retry)

    const activeRetryLogs = [...db.store.entries()]
      .filter(
        ([k, v]) =>
          k.startsWith('gyms/gym_z_active/notification_logs/') &&
          v.deliveryStatus === DeliveryStatus.RETRY_SCHEDULED
      )
      .map(([, v]) => v);
    expect(activeRetryLogs).toHaveLength(3);
    expect(activeRetryLogs.every((l) => l.retryCount === 1)).toBe(true);
    expect(
      activeRetryLogs.every(
        (l) => l.nextRetryAt === new Date(tPlus16m + 60 * 60_000).toISOString()
      )
    ).toBe(true);

    // 30 minutes after sweep3 (still within 60m backoff): NOT retried prematurely
    const sweep4 = await worker.sweep({ nowMs: tPlus16m + 30 * 60_000 });
    expect(sweep4.retriesAttempted).toBe(0);

    // 61 minutes after sweep3 -> retryCount=2, nextRetryAt=+240m
    const tRetry2 = tPlus16m + 61 * 60_000;
    const sweep5 = await worker.sweep({ nowMs: tRetry2 });
    expect(sweep5.retriesAttempted).toBe(3);

    // 241 minutes after sweep5 -> final retryCount=3 -> transitions to FAILED permanently!
    const tRetry3 = tRetry2 + 241 * 60_000;
    const sweep6 = await worker.sweep({ nowMs: tRetry3 });
    expect(sweep6.retriesAttempted).toBe(3);

    const terminalFailedLogs = [...db.store.entries()]
      .filter(
        ([k, v]) =>
          k.startsWith('gyms/gym_z_active/notification_logs/') &&
          v.deliveryStatus === DeliveryStatus.FAILED
      )
      .map(([, v]) => v);
    expect(terminalFailedLogs).toHaveLength(3);
    expect(terminalFailedLogs.every((l) => l.retryCount === 3)).toBe(true);

    // Distributed worker lock blocks concurrent second worker
    db.store.set('system_locks/reminder_worker', {
      id: 'reminder_worker',
      workerId: 'other_worker',
      released: false,
      expiresAtMs: tRetry3 + 120_000,
    });
    const blockedSweep = await worker.sweep({ nowMs: tRetry3 + 1000 });
    expect(blockedSweep.skipped).toBe(true);
    expect(blockedSweep.reason).toContain('reminder_worker');
  });

  it('fails closed in ReminderWorker when subscriptionAccessUntil is missing on an otherwise ACTIVE gym', async () => {
    const db = new InMemoryFirestore();
    db.store.set('gyms/gym_missing_access', {
      id: 'gym_missing_access',
      name: 'No Access Timestamp Gym',
      ownerUid: 'owner_m',
      ownerName: 'Missing Ts Owner',
      email: 'missing@gym.test',
      phone: '9876543200',
      accountStatus: AccountStatus.ACTIVE,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      subscriptionStartAt: '2025-05-01',
      subscriptionEndAt: '2099-12-31',
      gracePeriodDays: 7,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
    });
    db.store.set('gyms/gym_missing_access/settings/default', {
      gymId: 'gym_missing_access',
      gracePeriodDays: 7,
      renewalPolicy: RenewalPolicy.EXTEND_FROM_EXPIRY,
      reminderDaysBefore: [3],
      sendOnExpiryDay: true,
      sendAfterExpiryDays: [],
      emailEnabled: true,
      inAppEnabled: true,
      whatsappEnabled: false,
      currencySymbol: '₹',
    });
    db.store.set('gyms/gym_missing_access/members/m1', {
      id: 'm1',
      gymId: 'gym_missing_access',
      memberCode: 'M-01',
      fullName: 'Should Skip',
      phone: '9988776611',
      email: 'skip@member.test',
      joiningDate: '2025-05-01',
      membershipExpiryDate: '2025-06-13',
      membershipStatus: MembershipStatus.EXPIRING_SOON,
      outstandingBalance: 0,
      reminderOptOut: false,
      isArchived: false,
    });

    const worker = new ReminderWorker({
      db,
      sendEmail: async () => ({ delivered: true, providerMessageId: 'm1', sentAt: new Date().toISOString() }),
      sendWhatsApp: async () => ({ delivered: false }),
      serverTimestamp: ts,
      intervalMinutes: 30,
      orderByField: 'id',
    });

    const sweep = await worker.sweep({ nowMs: Date.parse('2025-06-10T08:00:00.000Z') });
    expect(sweep.gymsProcessed).toBe(1);
    const logs = [...db.store.entries()].filter(([k]) =>
      k.startsWith('gyms/gym_missing_access/notification_logs/')
    );
    expect(logs.some(([, v]) => v.memberId === 'm1')).toBe(false);
  });
});
