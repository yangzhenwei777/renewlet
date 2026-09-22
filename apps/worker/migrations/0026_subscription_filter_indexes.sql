CREATE INDEX IF NOT EXISTS idx_subscriptions_user_category_order
  ON subscriptions (user_id, category, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_billing_cycle_order
  ON subscriptions (user_id, billing_cycle, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_currency_order
  ON subscriptions (user_id, currency, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_payment_method_order
  ON subscriptions (user_id, payment_method, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_pinned_order
  ON subscriptions (user_id, pinned, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_public_hidden_order
  ON subscriptions (user_id, public_hidden, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_reminder_mode_order
  ON subscriptions (user_id, reminder_days, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_repeat_reminder_order
  ON subscriptions (user_id, repeat_reminder_enabled, created_at DESC, id DESC);
