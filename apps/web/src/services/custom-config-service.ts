import { apiFetch } from "@/lib/api-client";
import { customConfigResponseSchema } from "@/lib/api/schemas/custom-config";
import { getCurrentUserId } from "@/lib/pocketbase";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import { normalizeCustomConfig } from "@/modules/custom-config/domain/normalize-custom-config";

/** 用户自定义配置统一走产品 API；不要恢复 Docker 下的 PocketBase collection 双路径。 */
export const customConfigService = {
  async get(signal: AbortSignal): Promise<CustomConfig | null> {
    const userId = getCurrentUserId();
    if (!userId) return null;
    const data = await apiFetch("/api/app/custom-config", customConfigResponseSchema, { signal });
    return normalizeCustomConfig(data.config);
  },

  async save(nextConfig: CustomConfig): Promise<CustomConfig> {
    const userId = getCurrentUserId();
    if (!userId) return nextConfig;
    const normalized = normalizeCustomConfig(nextConfig ?? DEFAULT_CUSTOM_CONFIG);
    // 保存前先归一化，避免 UI 临时字段写成 Docker/Cloudflare 共享的持久契约。
    const data = await apiFetch("/api/app/custom-config", customConfigResponseSchema, {
      method: "PUT",
      body: JSON.stringify({ config: normalized }),
    });
    return normalizeCustomConfig(data.config);
  },
};
