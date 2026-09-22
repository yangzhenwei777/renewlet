// Package main 启动 Renewlet 的 Go/PocketBase 运行面。
//
// 该包同时拥有 schema 收敛、自定义 API route、record hook、通知 cron、静态前端嵌入和 Docker
// 页面内自更新状态机。Cloudflare Worker 运行面不复用这里的 PocketBase 实现；跨运行面契约必须通过
// packages/shared schema、前端 Zod schema 和对应 Worker DTO 同步维护。
package main
