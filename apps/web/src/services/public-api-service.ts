import { apiFetch } from "@/lib/api-client";
import {
  apiTokenCreateRequestSchema,
  apiTokenCreateResponseSchema,
  apiTokenDeleteResponseSchema,
  apiTokensListResponseSchema,
  type ApiToken,
  type ApiTokenCreateRequest,
  type ApiTokenCreateResponse,
} from "@/lib/api/schemas/public-api";

/**
 * Public API token 管理服务。
 *
 * plainToken 只存在于 create 响应；列表服务只返回 prefix/hash 派生元信息，不能在前端尝试恢复明文。
 */
export const publicApiService = {
  async listTokens(signal?: AbortSignal): Promise<ApiToken[]> {
    const data = await apiFetch("/api/app/api-tokens", apiTokensListResponseSchema, signal ? { signal } : undefined);
    return data.tokens;
  },

  async createToken(body: ApiTokenCreateRequest): Promise<ApiTokenCreateResponse> {
    return await apiFetch("/api/app/api-tokens", apiTokenCreateResponseSchema, {
      method: "POST",
      body: JSON.stringify(apiTokenCreateRequestSchema.parse(body)),
    });
  },

  async deleteToken(id: string): Promise<void> {
    await apiFetch(`/api/app/api-tokens/${encodeURIComponent(id)}`, apiTokenDeleteResponseSchema, { method: "DELETE" });
  },
};
