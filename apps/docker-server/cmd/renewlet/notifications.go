package main

// notifications.go 是订阅提醒模块的顶层导航文件。
//
// 架构位置：通知模块横跨 settings/subscriptions 读取、调度决策、渠道发送和
// notification_jobs 历史记录，具体实现按职责拆到 notification_*.go 文件，
// 让每个维护入口都保持在 500 行以内。
//
// 调度流转：
//   scheduler tick -> TryLock -> settings/subscriptions -> 本地调度决策
//     -> create/mark job(sending) -> 发送渠道 -> finalize(sent/failed/skipped) -> history API
//
// 注意： notification_jobs 的唯一索引是并发保护的一部分；修改 scheduledLocalDate/time/timeZone
// 语义会影响幂等性、重试和前端历史 schema。
