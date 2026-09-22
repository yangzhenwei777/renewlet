import { z } from "zod";

/**
 * 当前用户修改密码的请求体契约。
 *
 * 72 字符上限来自 bcrypt/scrypt 类密码处理的常见安全边界；前后端都不应接受无界长密码拖垮哈希。
 */
export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: z.string().min(8).max(72),
}).strict();

/**
 * 找回密码请求契约。
 *
 * Cloudflare 运行面当前只返回不可用状态；保留 schema 是为了 Docker/PocketBase 运行面继续使用同一前端服务层。
 */
export const requestPasswordResetBodySchema = z.object({
  email: z.email().max(254),
}).strict();

/**
 * 找回密码确认契约。
 *
 * token 只作为一次性 bearer secret 进入服务端，不允许前端解析其内部结构或长期持久化。
 */
export const confirmPasswordResetBodySchema = z.object({
  token: z.string().trim().min(1).max(256),
  newPassword: z.string().min(8).max(72),
}).strict();
