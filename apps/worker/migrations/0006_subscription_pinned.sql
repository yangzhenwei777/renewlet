-- pinned 是订阅列表置顶的跨运行面契约；默认 false 让既有数据保留原列表语义。
ALTER TABLE subscriptions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
