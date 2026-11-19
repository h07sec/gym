-- GymOS Multi-Tenant SaaS Platform — Initial PostgreSQL / Supabase Schema
-- Migration: 001_initial_schema.sql
-- Compatible with PostgreSQL 15+ and Supabase.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. Platform Governance & SaaS Subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_admins (
  uid UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  support_email TEXT NOT NULL,
  support_phone TEXT NOT NULL,
  upi_id TEXT NOT NULL DEFAULT '',
  upi_payee_name TEXT NOT NULL DEFAULT '',
  payment_instructions TEXT NOT NULL DEFAULT '',
  default_grace_period_days INTEGER NOT NULL DEFAULT 7 CHECK (default_grace_period_days BETWEEN 0 AND 90),
  allow_public_registration BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  billing_duration_months INTEGER NOT NULL CHECK (billing_duration_months BETWEEN 1 AND 60),
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  max_staff INTEGER NOT NULL CHECK (max_staff >= 1),
  max_members INTEGER NOT NULL CHECK (max_members >= 1),
  trial_days INTEGER NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 90),
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 2. Tenant Gyms & Auth Role Mapping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gyms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_uid UUID NOT NULL,
  owner_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT,
  account_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE', 'SUSPENDED')),
  subscription_status TEXT NOT NULL DEFAULT 'TRIAL' CHECK (subscription_status IN ('TRIAL', 'ACTIVE', 'EXPIRED', 'PENDING', 'CANCELLED')),
  subscription_plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
  subscription_plan_name TEXT NOT NULL,
  subscription_start_at DATE NOT NULL,
  subscription_end_at DATE NOT NULL,
  grace_period_days INTEGER NOT NULL DEFAULT 7 CHECK (grace_period_days BETWEEN 0 AND 90),
  renewal_policy TEXT NOT NULL DEFAULT 'EXTEND_FROM_EXPIRY' CHECK (renewal_policy IN ('EXTEND_FROM_EXPIRY', 'START_TODAY_IF_EXPIRED')),
  suspension_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  uid UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'GYM_OWNER', 'GYM_MANAGER', 'GYM_RECEPTIONIST')),
  gym_id UUID REFERENCES gyms(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEACTIVATED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE RESTRICT,
  gym_name TEXT NOT NULL,
  owner_uid UUID NOT NULL,
  plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
  plan_name TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('CASH', 'UPI')),
  transaction_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  payment_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RECORDED', 'VERIFIED', 'REJECTED')),
  notes TEXT,
  recorded_by_uid UUID NOT NULL,
  verified_by_uid UUID,
  extension_applied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 3. Gym Settings, Staff & Invitations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gym_settings (
  gym_id UUID PRIMARY KEY REFERENCES gyms(id) ON DELETE CASCADE,
  grace_period_days INTEGER NOT NULL DEFAULT 7 CHECK (grace_period_days BETWEEN 0 AND 90),
  renewal_policy TEXT NOT NULL DEFAULT 'EXTEND_FROM_EXPIRY' CHECK (renewal_policy IN ('EXTEND_FROM_EXPIRY', 'START_TODAY_IF_EXPIRED')),
  reminder_days_before INTEGER[] NOT NULL DEFAULT ARRAY[7, 3, 1],
  send_on_expiry_day BOOLEAN NOT NULL DEFAULT TRUE,
  send_after_expiry_days INTEGER[] NOT NULL DEFAULT ARRAY[3, 7],
  email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_from_name TEXT,
  in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  whatsapp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_phone_number_id TEXT,
  whatsapp_approved_template TEXT,
  currency_symbol TEXT NOT NULL DEFAULT '₹',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  gym_name TEXT NOT NULL,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('GYM_MANAGER', 'GYM_RECEPTIONIST')),
  permissions JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED')),
  invited_by_uid UUID NOT NULL,
  accepted_by_uid UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gym_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  invitation_id UUID REFERENCES staff_invitations(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('GYM_OWNER', 'GYM_MANAGER', 'GYM_RECEPTIONIST')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEACTIVATED')),
  permissions JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (gym_id, email)
);

-- ---------------------------------------------------------------------------
-- 4. Gym Operational Entities (Strict gym_id Tenant Scope)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS membership_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  duration_type TEXT NOT NULL CHECK (duration_type IN ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'CUSTOM_DAYS')),
  duration_value INTEGER NOT NULL CHECK (duration_value >= 1),
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  description TEXT,
  benefits JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_code TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  gender TEXT,
  date_of_birth DATE,
  address TEXT,
  joining_date DATE NOT NULL,
  emergency_contact TEXT,
  current_plan_id UUID REFERENCES membership_plans(id) ON DELETE SET NULL,
  current_plan_name TEXT,
  membership_start_date DATE,
  membership_expiry_date DATE,
  membership_status TEXT NOT NULL DEFAULT 'NONE' CHECK (membership_status IN ('ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'NONE')),
  outstanding_balance NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (outstanding_balance >= 0),
  reminder_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (gym_id, member_code)
);

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL,
  plan_id UUID NOT NULL REFERENCES membership_plans(id) ON DELETE RESTRICT,
  plan_name TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('INITIAL', 'RENEWAL', 'UPGRADE', 'DOWNGRADE', 'MANUAL_EXTENSION')),
  start_date DATE NOT NULL,
  expiry_date DATE NOT NULL,
  plan_price NUMERIC(12, 2) NOT NULL CHECK (plan_price >= 0),
  amount_paid NUMERIC(12, 2) NOT NULL CHECK (amount_paid >= 0),
  balance_due NUMERIC(12, 2) NOT NULL CHECK (balance_due >= 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'EXPIRED', 'SUPERSEDED', 'CANCELLED')),
  recorded_by_uid UUID NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS member_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_code TEXT NOT NULL,
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  member_name TEXT NOT NULL,
  membership_id UUID REFERENCES memberships(id) ON DELETE SET NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('CASH', 'UPI')),
  payment_purpose TEXT NOT NULL CHECK (payment_purpose IN ('MEMBERSHIP', 'RENEWAL', 'BALANCE_SETTLEMENT', 'ADVANCE')),
  transaction_reference TEXT,
  attachment_name TEXT,
  payment_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'REFUNDED')),
  recorded_by_uid UUID NOT NULL,
  recorded_by_name TEXT NOT NULL,
  confirmed_by_uid UUID,
  receipt_number TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (gym_id, payment_code)
);

CREATE TABLE IF NOT EXISTS payment_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number TEXT NOT NULL,
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  gym_name TEXT NOT NULL,
  payment_id UUID NOT NULL UNIQUE REFERENCES member_payments(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  member_name TEXT NOT NULL,
  member_code TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('CASH', 'UPI')),
  transaction_reference TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_by_uid UUID NOT NULL,
  UNIQUE (gym_id, receipt_number)
);

-- ---------------------------------------------------------------------------
-- 5. Notifications, Delivery Logs & Immutable Audit Logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gym_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  gym_id UUID REFERENCES gyms(id) ON DELETE SET NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL,
  recipient TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'IN_APP', 'WHATSAPP_CLOUD')),
  template TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  scheduled_date DATE NOT NULL,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('SENT', 'FAILED', 'RETRY_SCHEDULED', 'SKIPPED_OPT_OUT')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error_details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (gym_id, dedup_key)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_uid UUID NOT NULL,
  actor_email TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  gym_id UUID REFERENCES gyms(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
