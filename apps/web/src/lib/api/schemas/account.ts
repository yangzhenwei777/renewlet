// 前端 API 边界只从 shared 暴露 Zod schema，避免 Docker/Go 与 Cloudflare Worker 运行面各自复制账号契约。
export * from "@renewlet/shared/schemas/account";
