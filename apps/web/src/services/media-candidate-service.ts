import { apiFetch } from "@/lib/api-client";
import {
  mediaCandidateResolveResponseSchema,
  type MediaCandidateResolveRequest,
  type MediaCandidateResolveResponse,
} from "@/lib/api/schemas/media";

/** 媒体候选解析服务；调用方传 AbortSignal 以便弹层连续搜索时取消旧请求。 */
export const mediaCandidateService = {
  async resolve(
    request: MediaCandidateResolveRequest,
    signal?: AbortSignal,
  ): Promise<MediaCandidateResolveResponse> {
    return await apiFetch("/api/app/media/candidates", mediaCandidateResolveResponseSchema, {
      method: "POST",
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
  },
};
