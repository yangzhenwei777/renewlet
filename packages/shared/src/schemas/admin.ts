import { z } from "zod";
import { authenticatorMfaMethodSchema } from "./auth";
import { okResponseSchema } from "./common";
import { apiSuccessResponseSchema } from "./api";

/**
 * 管理员角色枚举。
 *
 * 这是防自锁逻辑和 Cloudflare/Go 用户管理 API 的共同权限边界；新增角色必须同步 route 守卫。
 */
export const userRoleSchema = z.enum(["user", "admin"]);

/**
 * 管理员用户列表中的安全视图。
 *
 * 响应只暴露管理所需字段，不能把 password hash、reset token 或 session 信息扩进这个契约。
 */
export const adminUserSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string(),
  role: userRoleSchema,
  banned: z.boolean(),
  // 管理员列表只暴露可用二因素方法和数量，不返回任何 credential、challenge 或恢复码 hash。
  mfaEnabled: z.boolean(),
  mfaMethods: z.array(authenticatorMfaMethodSchema),
  passkeysEnabled: z.boolean(),
  passkeyCount: z.number().int().min(0),
  banReason: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export const adminUsersPayloadSchema = z.object({
  users: z.array(adminUserSchema),
}).strict();
export const adminUsersResponseSchema = apiSuccessResponseSchema(adminUsersPayloadSchema);

export const adminUserPayloadSchema = z.object({
  user: adminUserSchema,
}).strict();
export const adminUserResponseSchema = apiSuccessResponseSchema(adminUserPayloadSchema);

export const adminPatchUserResponseSchema = okResponseSchema;
export const adminDeleteUserResponseSchema = okResponseSchema;
export const adminResetUserMfaResponseSchema = okResponseSchema;
export const adminResetUserPasskeysResponseSchema = okResponseSchema;

// 管理端访问安全契约只返回脱敏状态；secret 明文只允许通过 update body 单向写入服务端。
export const authSecurityTurnstileSettingsSchema = z.object({
  enabled: z.boolean(),
  siteKey: z.string(),
  // 管理端只知道 secret 是否已配置；密钥明文只能随本次 PUT 入站，不能被任何 API 回显。
  secretConfigured: z.boolean(),
}).strict();

export const authSecuritySettingsPayloadSchema = z.object({
  turnstile: authSecurityTurnstileSettingsSchema,
}).strict();
export const authSecuritySettingsResponseSchema = apiSuccessResponseSchema(authSecuritySettingsPayloadSchema);

// 该 wire-shape 必须与 Go DTO、Worker handler 和设置页 controller 同步：secret 省略=保留，空字符串=清空。
export const authSecurityTurnstileUpdateSchema = z.object({
  enabled: z.boolean(),
  siteKey: z.string().trim().max(256),
  // undefined 表示保留旧 secret，空字符串表示清空；服务端会在启用时重新检查完整性。
  secret: z.string().max(4096).optional(),
}).strict();

export const authSecuritySettingsUpdateBodySchema = z.object({
  turnstile: authSecurityTurnstileUpdateSchema,
}).strict();

// 配置页测试会消耗一次 Turnstile token；secret 非空=测试草稿，空/省略=后端回退已保存值，响应不能回显凭据。
export const authSecurityTurnstileTestSchema = z.object({
  siteKey: z.string().trim().max(256),
  secret: z.string().max(4096).optional(),
  // token 缺失要保留为稳定业务错误码 TURNSTILE_REQUIRED，schema 只负责拒绝未知字段和超长输入。
  turnstileToken: z.string().trim().max(2048).optional().default(""),
}).strict();

export const authSecurityTurnstileTestBodySchema = z.object({
  turnstile: authSecurityTurnstileTestSchema,
}).strict();

export const authSecurityTurnstileTestPayloadSchema = z.object({
  verified: z.literal(true),
}).strict();
export const authSecurityTurnstileTestResponseSchema = apiSuccessResponseSchema(authSecurityTurnstileTestPayloadSchema);

/**
 * 管理员创建用户请求契约。
 *
 * Renewlet 不开放自助注册；账号创建始终挂在管理员 API 下，避免首装入口和用户管理入口混用。
 */
export const adminCreateUserBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().max(254),
  password: z.string().min(8).max(72),
  role: userRoleSchema,
}).strict();

/**
 * 管理员局部更新用户请求契约。
 *
 * 空 patch 被拒绝，是为了把前端状态机误触发暴露为边界错误，而不是生成无意义审计操作。
 * newPassword 只表示管理员重置他人账号；当前用户修改自己的密码必须走 account schema。
 */
export const adminPatchUserBodySchema = z.object({
  role: userRoleSchema.optional(),
  banned: z.boolean().optional(),
  newPassword: z.string().min(8).max(72).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Empty payload");

export type UserRole = z.infer<typeof userRoleSchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
export type AdminUsersResponse = z.infer<typeof adminUsersPayloadSchema>;
export type AuthSecuritySettings = z.infer<typeof authSecuritySettingsPayloadSchema>;
export type AuthSecuritySettingsUpdateBody = z.infer<typeof authSecuritySettingsUpdateBodySchema>;
export type AuthSecurityTurnstileTestBody = z.infer<typeof authSecurityTurnstileTestBodySchema>;
export type AuthSecurityTurnstileTestResponse = z.infer<typeof authSecurityTurnstileTestPayloadSchema>;
