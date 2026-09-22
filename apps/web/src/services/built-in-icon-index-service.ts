import { apiFetch } from "@/lib/api-client";
import {
  builtInIconIndexProviderCheckResponseSchema,
  builtInIconIndexProviderRefreshResponseSchema,
  builtInIconIndexStatusResponseSchema,
  type BuiltInIconIndexProviderCheckResponse,
  type BuiltInIconIndexProviderRefreshResponse,
  type BuiltInIconIndexStatus,
} from "@/lib/api/schemas/media";
import type { BuiltInIconProvider } from "@renewlet/shared/built-in-icons";

/** 管理员内置图标索引服务；provider 版本状态不进入用户 settings 草稿。 */
export const builtInIconIndexService = {
  async status(signal?: AbortSignal): Promise<BuiltInIconIndexStatus> {
    return await apiFetch("/api/app/admin/media/icon-index", builtInIconIndexStatusResponseSchema, signal ? { signal } : undefined);
  },

  async check(provider: BuiltInIconProvider): Promise<BuiltInIconIndexProviderCheckResponse> {
    return await apiFetch(`/api/app/admin/media/icon-index/providers/${provider}/check`, builtInIconIndexProviderCheckResponseSchema, {
      method: "POST",
      timeoutMs: 45_000,
    });
  },

  async refresh(provider: BuiltInIconProvider): Promise<BuiltInIconIndexProviderRefreshResponse> {
    return await apiFetch(`/api/app/admin/media/icon-index/providers/${provider}/refresh`, builtInIconIndexProviderRefreshResponseSchema, {
      method: "POST",
      timeoutMs: 120_000,
    });
  },
};
