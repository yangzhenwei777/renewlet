// 公开展示页响应必须复用 shared schema，避免登录态页面和公开页面消费两套字段。
export * from "@renewlet/shared/schemas/public-status";
