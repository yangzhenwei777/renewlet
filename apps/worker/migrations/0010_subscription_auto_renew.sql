-- auto_renew 默认关闭；缺省迁移不能把历史周期订阅解释成用户同意自动推进。
ALTER TABLE subscriptions ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0;
UPDATE subscriptions SET auto_renew = 0 WHERE billing_cycle = 'one-time';
