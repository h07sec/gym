import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');
const rulesText = fs.readFileSync(rulesPath, 'utf8');
const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8')) as {
  firestore: Record<string, unknown>;
};

describe('Firestore Security Rules & Multi-Tenant Invariants', () => {
  it('enforces global default-deny safety net', () => {
    expect(rulesText).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
  });

  it('covers every collection declared in firebase-blueprint.json', () => {
    const collectionSegments = [
      'match /platform_admins/{uid}',
      'match /platform_settings/{settingId}',
      'match /subscription_plans/{planId}',
      'match /subscription_payments/{paymentId}',
      'match /users/{uid}',
      'match /invitations/{invitationId}',
      'match /gyms/{gymId}',
      'match /settings/{settingId}',
      'match /staff/{staffId}',
      'match /membership_plans/{planId}',
      'match /members/{memberId}',
      'match /memberships/{membershipId}',
      'match /member_payments/{paymentId}',
      'match /payment_receipts/{receiptId}',
      'match /notifications/{notificationId}',
      'match /notification_logs/{logId}',
      'match /platform_notifications/{notificationId}',
      'match /audit_logs/{logId}',
    ];
    expect(Object.keys(blueprint.firestore)).toHaveLength(18);
    for (const seg of collectionSegments) {
      expect(rulesText).toContain(seg);
    }
  });

  it('requires verified email on authenticated checks and blocks SUPER_ADMIN self-escalation', () => {
    expect(rulesText).toContain('request.auth.token.email_verified == true');
    expect(rulesText).toContain("isBootstrapSuperAdmin() && incoming().role == 'SUPER_ADMIN'");
    expect(rulesText).toContain('isAcceptedInviteForUser(incoming().invitationId, incoming().gymId, incoming().role)');
    expect(rulesText).toContain("incoming().role in ['GYM_MANAGER', 'GYM_RECEPTIONIST']");
  });

  it('locks all tenant operational subcollections when gym accountStatus is SUSPENDED', () => {
    const tenantSubcollections = [
      '/settings/{settingId}',
      '/staff/{staffId}',
      '/membership_plans/{planId}',
      '/members/{memberId}',
      '/memberships/{membershipId}',
      '/member_payments/{paymentId}',
      '/payment_receipts/{receiptId}',
      '/notifications/{notificationId}',
      '/notification_logs/{logId}',
    ];

    for (const sub of tenantSubcollections) {
      const idx = rulesText.indexOf(`match ${sub}`);
      expect(idx).toBeGreaterThan(-1);
      const block = rulesText.slice(idx, idx + 900);
      expect(block).toContain('isGymActive(gymId)');
    }
  });

  it('enforces immutable audit logs, immutable payment receipts, and terminal payment locks', () => {
    const auditIdx = rulesText.indexOf('match /audit_logs/{logId}');
    expect(auditIdx).toBeGreaterThan(-1);
    const auditBlock = rulesText.slice(auditIdx);
    expect(auditBlock).toContain('allow update, delete: if false;');

    const receiptIdx = rulesText.indexOf('match /payment_receipts/{receiptId}');
    const notifIdx = rulesText.indexOf('match /notifications/{notificationId}');
    const receiptBlock = rulesText.slice(receiptIdx, notifIdx);
    expect(receiptBlock).toContain('allow update, delete: if false;');

    expect(rulesText).toContain("existing().status == 'RECORDED'");
    expect(rulesText).toContain("existing().status == 'PENDING'");
  });
});
