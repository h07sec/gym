-- GymOS Multi-Tenant SaaS Platform — Performance Indexes & Anti-Fraud Constraints
-- Migration: 003_indexes_and_constraints.sql

-- Prevent duplicate non-rejected UPI references per gym
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_payments_upi_ref
  ON member_payments (gym_id, UPPER(TRIM(transaction_reference)))
  WHERE payment_mode = 'UPI' AND status <> 'REJECTED' AND transaction_reference IS NOT NULL AND TRIM(transaction_reference) <> '';

-- Prevent duplicate non-rejected SaaS subscription UPI references globally
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_payments_upi_ref
  ON subscription_payments (UPPER(TRIM(transaction_reference)))
  WHERE payment_mode = 'UPI' AND status <> 'REJECTED' AND transaction_reference IS NOT NULL AND TRIM(transaction_reference) <> '';

-- Operational lookup indexes
CREATE INDEX IF NOT EXISTS idx_gyms_account_status ON gyms (account_status, subscription_status);
CREATE INDEX IF NOT EXISTS idx_users_gym_id ON users (gym_id, role, status);
CREATE INDEX IF NOT EXISTS idx_members_gym_status ON members (gym_id, is_archived, membership_status);
CREATE INDEX IF NOT EXISTS idx_members_gym_expiry ON members (gym_id, membership_expiry_date);
CREATE INDEX IF NOT EXISTS idx_memberships_gym_member ON memberships (gym_id, member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_member_payments_gym_date ON member_payments (gym_id, payment_date DESC, status);
CREATE INDEX IF NOT EXISTS idx_notification_logs_gym_date ON notification_logs (gym_id, scheduled_date DESC, delivery_status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_gym ON audit_logs (gym_id, created_at DESC);
