import { apiFetch } from "@/lib/api-client";
import {
  authSecuritySettingsResponseSchema,
  authSecurityTurnstileTestResponseSchema,
  type AuthSecuritySettings,
  type AuthSecurityTurnstileTestBody,
  type AuthSecurityTurnstileTestResponse,
  type AuthSecuritySettingsUpdateBody,
} from "@/lib/api/schemas/admin";

/** 管理员访问安全服务；Turnstile secret 只能通过 PUT 入站，GET 响应只回 secretConfigured。 */
export const authSecurityService = {
  async read(signal?: AbortSignal): Promise<AuthSecuritySettings> {
    return await apiFetch("/api/app/admin/auth-security", authSecuritySettingsResponseSchema, signal ? { signal } : undefined);
  },

  async update(body: AuthSecuritySettingsUpdateBody): Promise<AuthSecuritySettings> {
    return await apiFetch("/api/app/admin/auth-security", authSecuritySettingsResponseSchema, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  async testTurnstile(body: AuthSecurityTurnstileTestBody): Promise<AuthSecurityTurnstileTestResponse> {
    // 测试接口只验证当前页面草稿，不保存配置；调用方不能把成功响应写进 auth-security 查询缓存。
    return await apiFetch("/api/app/admin/auth-security/turnstile/test", authSecurityTurnstileTestResponseSchema, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
};
