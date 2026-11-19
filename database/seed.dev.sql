-- GymOS Development & Staging Seed Script (NON-PRODUCTION ONLY)
-- Do NOT execute in production environments.

INSERT INTO platform_settings (id, support_email, support_phone, upi_id, upi_payee_name, payment_instructions, default_grace_period_days, allow_public_registration)
VALUES (
  'default',
  'support@gymos.local',
  '+91-98000-00000',
  'gymos.platform@upi',
  'GymOS SaaS Technologies',
  'Transfer via UPI to the official VPA or settle cash with your GymOS representative, then share your UTR number.',
  7,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscription_plans (id, name, billing_duration_months, price, currency, max_staff, max_members, trial_days, features, is_active)
VALUES
  ('plan_monthly_starter', 'Monthly Standard', 1, 1499.00, '₹', 5, 500, 14, '["Member & membership lifecycle","Manual Cash & UPI ledger + receipts","Automated expiry reminders","Daily & monthly reports"]'::jsonb, TRUE),
  ('plan_quarterly_pro', 'Quarterly Growth', 3, 3999.00, '₹', 12, 1500, 14, '["Up to 12 staff seats with RBAC","CSV bulk import & export","Custom renewal & grace policies","Priority support"]'::jsonb, TRUE),
  ('plan_half_yearly', 'Half-Yearly Scale', 6, 7499.00, '₹', 25, 3500, 14, '["Up to 25 staff seats","WhatsApp Cloud API ready","Full audit logs & exports"]'::jsonb, TRUE),
  ('plan_yearly_enterprise', 'Yearly Studio', 12, 13999.00, '₹', 50, 10000, 14, '["Up to 50 staff accounts","Unlimited historical retention","Dedicated onboarding review"]'::jsonb, TRUE)
ON CONFLICT (id) DO NOTHING;
