import { apiFetch } from "@/lib/api-client";
import {
  publicStatusPageCreateResponseSchema,
  publicStatusPageDeleteResponseSchema,
  publicStatusPageResponseSchema,
  publicStatusPageUpdateRequestSchema,
  publicStatusResponseSchema,
  type PublicStatusPageCreateResponse,
  type PublicStatusPageResponse,
  type PublicStatusPageUpdateRequest,
  type PublicStatusResponse,
} from "@/lib/api/schemas/public-status";

/**
 * 公开展示页服务。
 *
 * 管理接口只返回完整 pageUrl；公开 token 是可撤销 bearer secret，不在前端拆字段、不进设置草稿或导出。
 */
export const publicStatusService = {
  async getPage(signal?: AbortSignal): Promise<PublicStatusPageResponse["publicStatusPage"]> {
    const data = await apiFetch(
      "/api/app/public-status-page",
      publicStatusPageResponseSchema,
      signal ? { signal } : undefined,
    );
    return data.publicStatusPage;
  },

  async createPage(): Promise<PublicStatusPageCreateResponse["publicStatusPage"]> {
    const data = await apiFetch("/api/app/public-status-page", publicStatusPageCreateResponseSchema, {
      method: "POST",
      body: JSON.stringify({}),
    });
    return data.publicStatusPage;
  },

  async updatePage(body: PublicStatusPageUpdateRequest): Promise<PublicStatusPageResponse["publicStatusPage"]> {
    const data = await apiFetch("/api/app/public-status-page", publicStatusPageResponseSchema, {
      method: "PATCH",
      body: JSON.stringify(publicStatusPageUpdateRequestSchema.parse(body)),
    });
    return data.publicStatusPage;
  },

  async deletePage(): Promise<void> {
    await apiFetch("/api/app/public-status-page", publicStatusPageDeleteResponseSchema, { method: "DELETE" });
  },

  async readPublicStatus(token: string, signal?: AbortSignal): Promise<PublicStatusResponse> {
    return await apiFetch(`/api/public/status/${encodeURIComponent(token)}`, publicStatusResponseSchema, {
      authMode: "none",
      ...(signal ? { signal } : {}),
    });
  },
};
