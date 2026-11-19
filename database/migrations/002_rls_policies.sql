-- GymOS Multi-Tenant SaaS Platform — PostgreSQL Row Level Security (RLS)
-- Migration: 002_rls_policies.sql
-- Enforces strict tenant isolation, role-based access control, and account suspension locks.

-- Helper functions evaluate session auth.uid() (Supabase) or custom app.current_uid GUC (generic Postgres).
CREATE OR REPLACE FUNCTION app_current_uid() RETURNS UUID
LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', TRUE), '')::UUID,
    NULLIF(current_setting('app.current_uid', TRUE), '')::UUID
  );
$$;

CREATE OR REPLACE FUNCTION app_is_super_admin() RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_admins WHERE uid = app_current_uid()
  );
$$;

CREATE OR REPLACE FUNCTION app_user_gym_id() RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT gym_id FROM users WHERE uid = app_current_uid() AND status = 'ACTIVE';
$$;

CREATE OR REPLACE FUNCTION app_user_role() RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT role FROM users WHERE uid = app_current_uid() AND status = 'ACTIVE';
$$;

CREATE OR REPLACE FUNCTION app_is_gym_active(target_gym_id UUID) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM gyms WHERE id = target_gym_id AND account_status = 'ACTIVE'
  );
$$;

-- Enable RLS across all tables
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE gyms ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Platform governance
CREATE POLICY platform_admins_read ON platform_admins
  FOR SELECT USING (app_is_super_admin() OR uid = app_current_uid());

CREATE POLICY platform_settings_read ON platform_settings
  FOR SELECT USING (app_current_uid() IS NOT NULL);
CREATE POLICY platform_settings_write ON platform_settings
  FOR ALL USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());

CREATE POLICY subscription_plans_read ON subscription_plans
  FOR SELECT USING (app_current_uid() IS NOT NULL);
CREATE POLICY subscription_plans_write ON subscription_plans
  FOR ALL USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());

-- Gyms root (suspended owners can read their gym record to see suspension lock screen)
CREATE POLICY gyms_select ON gyms
  FOR SELECT USING (
    app_is_super_admin() OR owner_uid = app_current_uid() OR id = app_user_gym_id()
  );
CREATE POLICY gyms_insert ON gyms
  FOR INSERT WITH CHECK (
    app_is_super_admin() OR (owner_uid = app_current_uid() AND account_status = 'ACTIVE')
  );
CREATE POLICY gyms_update ON gyms
  FOR UPDATE USING (
    app_is_super_admin() OR (id = app_user_gym_id() AND app_user_role() = 'GYM_OWNER' AND app_is_gym_active(id))
  );

-- Users (prevents self-promotion to SUPER_ADMIN)
CREATE POLICY users_select ON users
  FOR SELECT USING (
    app_is_super_admin() OR uid = app_current_uid() OR (gym_id = app_user_gym_id() AND app_user_role() = 'GYM_OWNER')
  );
CREATE POLICY users_insert ON users
  FOR INSERT WITH CHECK (
    app_is_super_admin() OR (uid = app_current_uid() AND role IN ('GYM_OWNER', 'GYM_MANAGER', 'GYM_RECEPTIONIST'))
  );
CREATE POLICY users_update ON users
  FOR UPDATE USING (
    app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_user_role() = 'GYM_OWNER' AND role <> 'SUPER_ADMIN')
  );

-- Subscription payments
CREATE POLICY sub_payments_select ON subscription_payments
  FOR SELECT USING (app_is_super_admin() OR owner_uid = app_current_uid());
CREATE POLICY sub_payments_admin_write ON subscription_payments
  FOR ALL USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());

-- Tenant operational tables (require matching gym_id AND active account_status)
CREATE POLICY gym_settings_tenant ON gym_settings
  FOR ALL
  USING (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)))
  WITH CHECK (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_user_role() = 'GYM_OWNER' AND app_is_gym_active(gym_id)));

CREATE POLICY staff_invitations_tenant ON staff_invitations
  FOR ALL
  USING (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)) OR lower(email) = lower(current_setting('request.jwt.claim.email', TRUE)))
  WITH CHECK (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_user_role() = 'GYM_OWNER' AND app_is_gym_active(gym_id)));

CREATE POLICY gym_staff_tenant ON gym_staff
  FOR ALL
  USING (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)))
  WITH CHECK (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_user_role() = 'GYM_OWNER' AND app_is_gym_active(gym_id)));

CREATE POLICY membership_plans_tenant ON membership_plans
  FOR ALL
  USING (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)))
  WITH CHECK (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_user_role() IN ('GYM_OWNER', 'GYM_MANAGER') AND app_is_gym_active(gym_id)));

CREATE POLICY members_tenant ON members
  FOR ALL
  USING (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)))
  WITH CHECK (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)));

CREATE POLICY memberships_tenant ON memberships
  FOR ALL
  USING (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)))
  WITH CHECK (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)));

CREATE POLICY member_payments_tenant ON member_payments
  FOR ALL
  USING (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)))
  WITH CHECK (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)));

CREATE POLICY payment_receipts_read ON payment_receipts
  FOR SELECT USING (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)));
CREATE POLICY payment_receipts_insert ON payment_receipts
  FOR INSERT WITH CHECK (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)));

CREATE POLICY gym_notifications_tenant ON gym_notifications
  FOR ALL
  USING (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)))
  WITH CHECK (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)));

CREATE POLICY platform_notifications_admin ON platform_notifications
  FOR ALL USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());

CREATE POLICY notification_logs_tenant ON notification_logs
  FOR ALL
  USING (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)))
  WITH CHECK (app_is_super_admin() OR (gym_id = app_user_gym_id() AND app_is_gym_active(gym_id)));

-- Immutable Audit Logs (append-only)
CREATE POLICY audit_logs_read ON audit_logs
  FOR SELECT USING (
    app_is_super_admin() OR actor_uid = app_current_uid() OR (gym_id = app_user_gym_id() AND app_user_role() = 'GYM_OWNER')
  );
CREATE POLICY audit_logs_insert ON audit_logs
  FOR INSERT WITH CHECK (actor_uid = app_current_uid());
