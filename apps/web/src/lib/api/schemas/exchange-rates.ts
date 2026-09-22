// 汇率配置和缓存响应在设置页与服务层共用 shared schema，避免 provider 枚举在客户端单独扩展。
export * from "@renewlet/shared/schemas/exchange-rates";
