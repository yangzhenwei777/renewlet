-- 历史 custom 数量的单位固定是 day；迁移后 Worker 读写路径只接受显式单位。
UPDATE subscriptions
SET custom_cycle_unit = 'day'
WHERE billing_cycle = 'custom'
  AND custom_days > 0
  AND TRIM(COALESCE(custom_cycle_unit, '')) = '';

UPDATE subscriptions
SET custom_days = NULL,
    custom_cycle_unit = NULL
WHERE billing_cycle != 'custom';

UPDATE subscriptions
SET one_time_term_count = NULL,
    one_time_term_unit = NULL
WHERE billing_cycle != 'one-time';
