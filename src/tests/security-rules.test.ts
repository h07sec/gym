import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');
const rulesText = fs.readFileSync(rulesPath, 'utf8');
const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8')) as {
  firestore: Record<string, unknown>;
};

interface ParsedMatchBlock {
  fullPath: string;
  segment: string;
  bodyWithChildren: string;
  ownBody: string;
}

interface ParsedRuleOperations {
  get: string;
  list: string;
  create: string;
  update: string;
  delete: string;
}

function findMatchingBrace(source: string, openBraceIndex: number): number {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;

  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (ch === '/' && next === '/' && !inSingleQuote && !inDoubleQuote) {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "'" && !inDoubleQuote && source[i - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote && source[i - 1] !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unmatched brace starting at index ${openBraceIndex}`);
}

function stripNestedMatchBlocks(blockBody: string): string {
  let out = '';
  let i = 0;
  while (i < blockBody.length) {
    const atLineStart = i === 0 || blockBody[i - 1] === '\n';
    if (atLineStart) {
      const rest = blockBody.slice(i);
      const matchStart = /^[ \t]*match\s+\/[^\n]+?\s*\{[ \t]*(?=\r?\n|$)/.exec(rest);
      if (matchStart) {
        const openIdx = i + matchStart[0].lastIndexOf('{');
        const closeIdx = findMatchingBrace(blockBody, openIdx);
        i = closeIdx + 1;
        continue;
      }
    }
    out += blockBody[i];
    i++;
  }
  return out;
}

function parseMatchBlocks(source: string): ParsedMatchBlock[] {
  const blocks: ParsedMatchBlock[] = [];
  const rootPrefix = 'match /databases/{database}/documents';
  const rootStart = source.indexOf(rootPrefix);
  if (rootStart === -1) {
    throw new Error('Could not locate match /databases/{database}/documents block');
  }
  const rootOpen = source.indexOf('{', rootStart + rootPrefix.length);
  const rootClose = findMatchingBrace(source, rootOpen);
  const rootBody = source.slice(rootOpen + 1, rootClose);

  function walk(body: string, parentPath: string) {
    const regex = /^[ \t]*match\s+(\/[^\n]+?)\s*\{[ \t]*$/gm;
    let cursor = 0;
    while (cursor < body.length) {
      regex.lastIndex = cursor;
      const m = regex.exec(body);
      if (!m) break;
      const segment = m[1].trim();
      const openBrace = m.index + m[0].lastIndexOf('{');
      const closeBrace = findMatchingBrace(body, openBrace);
      const inner = body.slice(openBrace + 1, closeBrace);
      const fullPath = parentPath + segment;
      blocks.push({
        fullPath,
        segment,
        bodyWithChildren: inner,
        ownBody: stripNestedMatchBlocks(inner),
      });
      walk(inner, fullPath);
      cursor = closeBrace + 1;
    }
  }

  walk(rootBody, '');
  return blocks;
}

function extractFunctionBody(source: string, fnName: string): string {
  const regex = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`);
  const m = regex.exec(source);
  if (!m) {
    throw new Error(`Function ${fnName} not found in firestore.rules`);
  }
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = findMatchingBrace(source, openIdx);
  return source.slice(openIdx + 1, closeIdx);
}

function parseAllowStatements(ownBody: string): ParsedRuleOperations {
  const ops: ParsedRuleOperations = {
    get: '',
    list: '',
    create: '',
    update: '',
    delete: '',
  };
  const stmtRegex = /allow\s+([^:]+):\s*if\s+([\s\S]*?);/g;
  let m: RegExpExecArray | null;
  while ((m = stmtRegex.exec(ownBody)) !== null) {
    const verbs = m[1].split(',').map((v) => v.trim());
    const expr = m[2].trim();
    for (const verb of verbs) {
      if (verb === 'read') {
        ops.get = ops.get ? `(${ops.get}) || (${expr})` : expr;
        ops.list = ops.list ? `(${ops.list}) || (${expr})` : expr;
      } else if (verb === 'write') {
        ops.create = ops.create ? `(${ops.create}) || (${expr})` : expr;
        ops.update = ops.update ? `(${ops.update}) || (${expr})` : expr;
        ops.delete = ops.delete ? `(${ops.delete}) || (${expr})` : expr;
      } else if (verb in ops) {
        const key = verb as keyof ParsedRuleOperations;
        ops[key] = ops[key] ? `(${ops[key]}) || (${expr})` : expr;
      }
    }
  }
  return ops;
}

const parsedBlocks = parseMatchBlocks(rulesText);
const blockMap = new Map(parsedBlocks.map((b) => [b.fullPath, b]));

function getOpsFor(collectionPath: string): ParsedRuleOperations {
  const block = blockMap.get(collectionPath);
  if (!block) {
    throw new Error(`Missing match block for ${collectionPath}`);
  }
  return parseAllowStatements(block.ownBody);
}

describe('Firestore Security Rules Structural & Multi-Tenant Verification', () => {
  it('enforces global default-deny catch-all rule', () => {
    const ops = getOpsFor('/{document=**}');
    expect(ops.get).toBe('false');
    expect(ops.list).toBe('false');
    expect(ops.create).toBe('false');
    expect(ops.update).toBe('false');
    expect(ops.delete).toBe('false');
  });

  it('covers all 21 collections in firebase-blueprint.json with explicit CRUD clauses', () => {
    const blueprintPaths = Object.keys(blueprint.firestore);
    expect(blueprintPaths).toHaveLength(21);

    for (const collectionPath of blueprintPaths) {
      const block = blockMap.get(collectionPath);
      expect(block, `Missing match block for ${collectionPath}`).toBeDefined();
      const ops = parseAllowStatements(block!.ownBody);
      expect(ops.get.length, `${collectionPath} missing allow get/read`).toBeGreaterThan(0);
      expect(ops.list.length, `${collectionPath} missing allow list/read`).toBeGreaterThan(0);
      expect(ops.create.length, `${collectionPath} missing allow create/write`).toBeGreaterThan(0);
      expect(ops.update.length, `${collectionPath} missing allow update/write`).toBeGreaterThan(0);
      expect(ops.delete.length, `${collectionPath} missing allow delete/write`).toBeGreaterThan(0);
    }

    for (const serverOnlyPath of ['/platform_bootstrap/{docId}', '/system_locks/{lockId}']) {
      const ops = getOpsFor(serverOnlyPath);
      expect(ops.get).toBe('false');
      expect(ops.list).toBe('false');
      expect(ops.create).toBe('false');
      expect(ops.update).toBe('false');
      expect(ops.delete).toBe('false');
    }
  });

  it('contains zero hardcoded admin emails or deprecated bootstrap helpers', () => {
    expect(rulesText).not.toContain('isBootstrapSuperAdmin');
    expect(rulesText).not.toMatch(/['"][^'"]*@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}['"]/);

    const isSignedInBody = extractFunctionBody(rulesText, 'isSignedIn');
    expect(isSignedInBody).toContain('request.auth != null');
    expect(isSignedInBody).toContain('request.auth.token.email_verified == true');

    const isSuperAdminBody = extractFunctionBody(rulesText, 'isSuperAdmin');
    expect(isSuperAdminBody).toContain('isSignedIn()');
    expect(isSuperAdminBody).toContain(
      'exists(/databases/$(database)/documents/platform_admins/$(request.auth.uid))'
    );

    const adminOps = getOpsFor('/platform_admins/{uid}');
    expect(adminOps.create).toContain('isSuperAdmin()');
    expect(adminOps.update).toBe('false');
    expect(adminOps.delete).toContain('isSuperAdmin()');
    expect(adminOps.delete).toContain('request.auth.uid != uid');
  });

  it('enforces allowPublicRegistration at database level for self-registration while allowing invited owners', () => {
    const publicRegFn = extractFunctionBody(rulesText, 'isPublicRegistrationAllowed');
    expect(publicRegFn).toContain('platform_settings/default');
    expect(publicRegFn).toContain('.data.allowPublicRegistration == true');

    const userOps = getOpsFor('/users/{uid}');
    expect(userOps.create).toContain('isPublicRegistrationAllowed()');
    expect(userOps.create).toContain(
      "isAcceptedInviteForUser(incoming().invitationId, incoming().gymId, 'GYM_OWNER')"
    );
    expect(userOps.create).toContain(
      "incoming().role in ['GYM_MANAGER', 'GYM_RECEPTIONIST', 'GYM_TRAINER']"
    );
    // Regular users cannot create SUPER_ADMIN profiles directly
    expect(userOps.create).not.toMatch(/request\.auth\.uid == uid[\s\S]*SUPER_ADMIN/);

    const gymOps = getOpsFor('/gyms/{gymId}');
    expect(gymOps.create).toContain('isPublicRegistrationAllowed()');
    expect(gymOps.create).toContain("incoming().subscriptionStatus in ['TRIAL', 'PENDING']");
    expect(gymOps.create).not.toContain("'ACTIVE',\n");
  });

  it('prevents gym owners from tampering with subscription status, dates, grace periods, or ownerUid', () => {
    const gymOps = getOpsFor('/gyms/{gymId}');
    const ownerUpdateInvariants = [
      'incoming().ownerUid == existing().ownerUid',
      'incoming().accountStatus == existing().accountStatus',
      'incoming().subscriptionStatus == existing().subscriptionStatus',
      'incoming().subscriptionPlanId == existing().subscriptionPlanId',
      'incoming().subscriptionStartAt == existing().subscriptionStartAt',
      'incoming().subscriptionEndAt == existing().subscriptionEndAt',
      'incoming().gracePeriodDays == existing().gracePeriodDays',
      "hasOnly([\n              'name', 'phone', 'address', 'renewalPolicy', 'updatedAt'\n            ])",
    ];
    for (const clause of ownerUpdateInvariants) {
      expect(gymOps.update).toContain(clause);
    }

    // Platform settings & subscription plans remain Super Admin write-only
    const settingsOps = getOpsFor('/platform_settings/{settingId}');
    expect(settingsOps.create).toContain('isSuperAdmin()');
    expect(settingsOps.update).toContain('isSuperAdmin()');
    expect(settingsOps.delete).toBe('false');

    const plansOps = getOpsFor('/subscription_plans/{planId}');
    expect(plansOps.create).toContain('isSuperAdmin()');
    expect(plansOps.update).toContain('isSuperAdmin()');
    expect(plansOps.delete).toContain('isSuperAdmin()');
  });

  it('enforces suspension, expiry + grace access, and deactivated-staff locks across all tenant subcollections', () => {
    const isGymActiveBody = extractFunctionBody(rulesText, 'isGymActive');
    expect(isGymActiveBody).toContain("accountStatus == 'ACTIVE'");
    expect(isGymActiveBody).toContain("subscriptionStatus in ['TRIAL', 'ACTIVE']");
    expect(isGymActiveBody).toContain('subscriptionAccessUntil > request.time');

    const isGymStaffBody = extractFunctionBody(rulesText, 'isGymStaff');
    expect(isGymStaffBody).toContain('isActiveUser()');
    expect(isGymStaffBody).toContain('userData().gymId == gymId');
    expect(isGymStaffBody).toContain(
      "userData().role in ['GYM_MANAGER', 'GYM_RECEPTIONIST', 'GYM_TRAINER']"
    );
    expect(isGymStaffBody).toContain("staffDocData(gymId).status == 'ACTIVE'");

    const tenantSubcollections = [
      '/gyms/{gymId}/settings/{settingId}',
      '/gyms/{gymId}/staff/{staffId}',
      '/gyms/{gymId}/membership_plans/{planId}',
      '/gyms/{gymId}/members/{memberId}',
      '/gyms/{gymId}/memberships/{membershipId}',
      '/gyms/{gymId}/member_payments/{paymentId}',
      '/gyms/{gymId}/payment_receipts/{receiptId}',
      '/gyms/{gymId}/attendance/{attendanceId}',
      '/gyms/{gymId}/notifications/{notificationId}',
      '/gyms/{gymId}/notification_logs/{logId}',
    ];

    for (const subPath of tenantSubcollections) {
      const ops = getOpsFor(subPath);
      expect(ops.get, `${subPath} get missing isGymActive(gymId)`).toContain('isGymActive(gymId)');
      expect(ops.list, `${subPath} list missing isGymActive(gymId)`).toContain('isGymActive(gymId)');
      expect(ops.list, `${subPath} list missing tenant gymId check`).toContain('existing().gymId == gymId');
      if (ops.update !== 'false') {
        expect(ops.update, `${subPath} update missing isGymActive(gymId)`).toContain('isGymActive(gymId)');
      }
    }
  });

  it('enforces granular staff RBAC for payments, receipts, attendance, reminders, and immutable logs', () => {
    const paymentOps = getOpsFor('/gyms/{gymId}/member_payments/{paymentId}');
    expect(paymentOps.get).toContain("staffHasPerm(gymId, 'canViewPayments')");
    expect(paymentOps.create).toContain("staffHasPerm(gymId, 'canRecordPayments')");
    expect(paymentOps.create).toContain("incoming().status == 'PENDING'");
    expect(paymentOps.create).toContain("staffHasPerm(gymId, 'canConfirmPayments')");
    expect(paymentOps.update).toContain("existing().status == 'PENDING'");
    expect(paymentOps.update).toContain("incoming().status in ['CONFIRMED', 'REJECTED']");
    expect(paymentOps.update).toContain("existing().status == 'CONFIRMED'");
    expect(paymentOps.update).toContain("incoming().status == 'REFUNDED'");
    expect(paymentOps.delete).toBe('false');

    const receiptOps = getOpsFor('/gyms/{gymId}/payment_receipts/{receiptId}');
    expect(receiptOps.get).toContain("staffHasPerm(gymId, 'canViewPayments')");
    expect(receiptOps.create).toContain("staffHasPerm(gymId, 'canConfirmPayments')");
    expect(receiptOps.update).toBe('false');
    expect(receiptOps.delete).toBe('false');

    const attendanceOps = getOpsFor('/gyms/{gymId}/attendance/{attendanceId}');
    expect(attendanceOps.create).toContain("staffHasPerm(gymId, 'canManageAttendance')");
    expect(attendanceOps.update).toContain("staffHasPerm(gymId, 'canManageAttendance')");
    expect(attendanceOps.delete).toBe('false');

    const logOps = getOpsFor('/gyms/{gymId}/notification_logs/{logId}');
    expect(logOps.get).toContain("staffHasPerm(gymId, 'canManageReminders')");
    expect(logOps.create).toContain("staffHasPerm(gymId, 'canManageReminders')");
    expect(logOps.delete).toBe('false');

    const auditOps = getOpsFor('/audit_logs/{logId}');
    expect(auditOps.update).toBe('false');
    expect(auditOps.delete).toBe('false');

    const subPayOps = getOpsFor('/subscription_payments/{paymentId}');
    expect(subPayOps.create).toContain('isSuperAdmin()');
    expect(subPayOps.update).toContain("existing().status in ['PENDING', 'RECORDED']");
    expect(subPayOps.delete).toBe('false');
  });
});
