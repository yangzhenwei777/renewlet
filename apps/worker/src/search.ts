/**
 * Worker 媒体候选搜索是 shared resolver 的运行面适配层。
 *
 * 排序、来源预算和候选上限都以 shared config 为事实源；Worker 只增加认证、用户来源设置和轻量限流。
 */
import {
  clampMediaCandidateLimit,
  resolveMediaCandidateItem,
} from "@renewlet/shared/media-resolver";
import { mediaResolverConfig } from "@renewlet/shared/media-resolver-config";
import {
  mediaCandidateResolvePayloadSchema,
  mediaCandidateResolveRequestSchema,
} from "@renewlet/shared/schemas/media";
import { getSettings } from "./db";
import { errorResponse, privateShortCache, readJson, requestLocale, successJson } from "./http";
import { serverText } from "./server-i18n";
import { requireAuth } from "./auth";
import { appendAppStoreCandidates } from "./app-store-icons";
import { getActiveBuiltInMediaResolver } from "./media-icon-index";
import type { Env } from "./types";

const mediaRateLimitData = new Map<string, { count: number; resetAt: number }>();

/** Logo/Icon 候选搜索入口；鉴权、限流和来源设置在 Worker 边界处理，排序规则在 shared resolver。 */
export async function mediaCandidates(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const locale = requestLocale(request);
  const retryAfter = checkMediaCandidateRateLimit(auth.user.id, request);
  if (retryAfter > 0) {
    const response = errorResponse(429, serverText(locale, "rateLimit.tooManyRequests"), "RATE_LIMITED");
    response.headers.set("retry-after", String(retryAfter));
    return response;
  }
  const body = await readJson(request, mediaCandidateResolveRequestSchema, locale);
  const settings = await getSettings(env, auth.user.id);
  const limit = clampMediaCandidateLimit(mediaResolverConfig, body.limit);
  const builtInResolver = await getActiveBuiltInMediaResolver(env);
  const allowAppStore = body.items.length === 1;
  const builtInItems = body.items.map((item) => resolveMediaCandidateItem(
    builtInResolver,
    body.kind,
    body.mode,
    item,
    limit,
    { sources: settings.builtInIconSources },
  ));
  if (!allowAppStore) {
    // Apple Search API 有共享出口限流；App Store 来源只服务单条手动 Logo 搜索，批量请求保持离线候选。
    return privateShortCache(successJson(mediaCandidateResolvePayloadSchema.parse({ items: builtInItems })));
  }
  const items = await Promise.all(builtInItems.map((item, index) => {
    const sourceItem = body.items[index];
    if (!sourceItem) return item;
    return appendAppStoreCandidates(
      item,
      body.kind,
      body.mode,
      sourceItem,
      limit,
      settings.onlineIconSources,
    );
  }));
  // Worker 只做运行面边界；候选生成和来源过滤规则在 shared resolver/App Store provider 中，响应再经 Zod 校验防止两端契约漂移。
  return privateShortCache(successJson(mediaCandidateResolvePayloadSchema.parse({ items })));
}

function checkMediaCandidateRateLimit(userId: string, request: Request): number {
  const key = `${userId}:${clientIP(request)}`;
  const now = Date.now();
  const bucket = mediaRateLimitData.get(key);
  if (!bucket || now > bucket.resetAt) {
    mediaRateLimitData.set(key, {
      count: 1,
      resetAt: now + mediaResolverConfig.rateLimit.defaultWindowMs,
    });
    return 0;
  }
  if (bucket.count >= mediaResolverConfig.rateLimit.defaultMaxRequests) {
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }
  bucket.count += 1;
  mediaRateLimitData.set(key, bucket);
  return 0;
}

function clientIP(request: Request): string {
  return request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
}
