/**
 * App Store 图标候选来源只返回 Apple Search API 的窄 JSON 结果。
 *
 * Search API 响应是应用元数据和 artwork URL；Renewlet 不下载、不转存 Apple CDN 图片。
 */
import type {
  MediaCandidate,
  MediaCandidateConfidence,
  MediaCandidateKind,
  MediaCandidateMode,
  MediaCandidateResolveItem,
  MediaCandidateResolveItemResponse,
} from "@renewlet/shared/schemas/media";
import {
  APP_STORE_STOREFRONTS,
  DEFAULT_APP_STORE_STOREFRONTS,
  normalizeAppStoreStorefronts,
  type AppStoreStorefront,
  type OnlineIconSourceSettings,
} from "@renewlet/shared/online-icon-sources";
import {
  bestMediaCandidate,
  compactMediaTerm,
  normalizeMediaTerm,
} from "@renewlet/shared/media-resolver";
import { mediaResolverConfig } from "@renewlet/shared/media-resolver-config";
import { sendUpstreamRequest } from "./upstream-http";

const APP_STORE_SEARCH_URL = "https://itunes.apple.com/search";
const APP_STORE_FETCH_TIMEOUT_MS = 2_000;
const APP_STORE_COUNTRY_LIMIT = 3;
const APP_STORE_RESPONSE_LIMIT_BYTES = 256 * 1024;
const APP_STORE_FRESH_TTL_MS = 24 * 60 * 60 * 1000;
const APP_STORE_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Cache API 需要 Request key；这个 synthetic URL 只在 Worker 内部命中 caches.default，不会发到网络。
const APP_STORE_CACHE_PREFIX = "https://renewlet.local/__app-store-icons";
const APP_STORE_PROVIDER = "appStore";

interface AppStoreAPIResponse {
  resultCount?: number;
  results?: AppStoreAPIResult[];
}

interface AppStoreAPIResult {
  trackId?: number | undefined;
  trackName?: string | undefined;
  sellerName?: string | undefined;
  bundleId?: string | undefined;
  artworkUrl512?: string | undefined;
  artworkUrl100?: string | undefined;
  artworkUrl60?: string | undefined;
  trackViewUrl?: string | undefined;
}

interface CachedAppStoreResults {
  fetchedAt: number;
  results: AppStoreAPIResult[];
}

interface PendingAppStoreSearch {
  promise: Promise<AppStoreAPIResult[]>;
}

interface AppStoreCountryResult {
  country: AppStoreStorefront;
  results: AppStoreAPIResult[];
  error: unknown;
}

const pendingAppStoreSearches = new Map<string, PendingAppStoreSearch>();

export async function appendAppStoreCandidates(
  response: MediaCandidateResolveItemResponse,
  kind: MediaCandidateKind,
  mode: MediaCandidateMode,
  item: MediaCandidateResolveItem,
  limit: number,
  sources: OnlineIconSourceSettings,
): Promise<MediaCandidateResolveItemResponse> {
  if (!shouldSearchAppStoreIcons(kind, mode, sources)) return response;
  const remaining = limit - response.candidates.builtIn.length;
  if (remaining <= 0) return response;
  const query = response.candidates.builtIn[0]?.matchedQuery || item.name;
  // App Store 是增强来源；Apple 失败只能让在线分组为空，不能让整个媒体候选 route 返回错误。
  const candidates = await searchAppStoreIconCandidates(kind, query, remaining, sources.appStore.storefronts).catch(() => []);
  if (candidates.length === 0) return response;
  const faviconLimit = Math.max(0, limit - response.candidates.builtIn.length - candidates.length);
  const candidatesGroup = {
    ...response.candidates,
    appStore: candidates,
    favicon: response.candidates.favicon.slice(0, faviconLimit),
  };
  return {
    ...response,
    candidates: {
      ...candidatesGroup,
      best: bestMediaCandidate(candidatesGroup),
    },
  };
}

function shouldSearchAppStoreIcons(
  kind: MediaCandidateKind,
  mode: MediaCandidateMode,
  sources: OnlineIconSourceSettings,
): boolean {
  // App Store 会触发 Apple 上游请求且结果不是高置信 SVG，只允许用户手动 Logo 搜索显式挑选。
  return kind === "logo" && mode === "search" && sources.appStore.enabled;
}

export async function searchAppStoreIconCandidates(
  kind: MediaCandidateKind,
  query: string,
  limit: number,
  storefronts: readonly AppStoreStorefront[] = DEFAULT_APP_STORE_STOREFRONTS,
): Promise<MediaCandidate[]> {
  if (kind !== "logo" || limit <= 0) return [];
  const normalizedQuery = normalizeMediaTerm(query);
  if (!normalizedQuery) return [];
  // 默认只查 US，把 CN 作为显式勾选项，避免一次手动搜索无意中消耗两次 Apple 限流额度。
  const countries = normalizeAppStoreStorefronts(storefronts);
  const countryResults = await Promise.all(countries.map(async (country): Promise<AppStoreCountryResult> => {
    try {
      return { country, results: await lookupAppStoreResults(normalizedQuery, country), error: null };
    } catch (error) {
      return { country, results: [], error };
    }
  }));
  const candidates = appStoreResultsToCandidates(kind, normalizedQuery, countryResults, limit);
  if (candidates.length > 0) return candidates;
  const firstError = countryResults.find((item) => item.error)?.error;
  if (firstError) throw firstError;
  return [];
}

async function lookupAppStoreResults(normalizedQuery: string, country: AppStoreStorefront): Promise<AppStoreAPIResult[]> {
  // country 是唯一请求放大维度；缓存和 pending 都按 query+country 分开，避免 CN 结果污染默认 US。
  const key = appStoreCacheKey(normalizedQuery, country);
  const cached = await readCachedAppStoreResults(key);
  if (cached && Date.now() - cached.fetchedAt <= APP_STORE_FRESH_TTL_MS) return cached.results;
  const pending = pendingAppStoreSearches.get(key);
  if (pending) return await pending.promise.catch((error: unknown) => {
    if (cached && Date.now() - cached.fetchedAt <= APP_STORE_STALE_TTL_MS) return cached.results;
    throw error;
  });

  const promise = fetchAndCacheAppStoreResults(normalizedQuery, country, key, cached);
  pendingAppStoreSearches.set(key, { promise });
  try {
    return await promise;
  } finally {
    pendingAppStoreSearches.delete(key);
  }
}

async function fetchAndCacheAppStoreResults(
  normalizedQuery: string,
  country: AppStoreStorefront,
  key: string,
  stale: CachedAppStoreResults | null,
): Promise<AppStoreAPIResult[]> {
  try {
    const results = await fetchAppStoreIconResults(normalizedQuery, country);
    await writeCachedAppStoreResults(key, results);
    return results;
  } catch (error) {
    // stale 只保存已清洗窄字段；Apple 超时/限流时继续给用户可用旧候选，不记录 raw body。
    if (stale && Date.now() - stale.fetchedAt <= APP_STORE_STALE_TTL_MS) return stale.results;
    throw error;
  }
}

async function fetchAppStoreIconResults(normalizedQuery: string, country: AppStoreStorefront): Promise<AppStoreAPIResult[]> {
  // 只请求官方固定 endpoint；用户输入只能进入 searchParams，不能成为 Worker 代理的任意上游 URL。
  const endpoint = new URL(APP_STORE_SEARCH_URL);
  endpoint.searchParams.set("term", normalizedQuery);
  endpoint.searchParams.set("country", country);
  endpoint.searchParams.set("media", "software");
  endpoint.searchParams.set("entity", "software");
  endpoint.searchParams.set("limit", String(APP_STORE_COUNTRY_LIMIT));
  const response = await sendUpstreamRequest(endpoint, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  }, {
    provider: "Apple Search API",
    timeoutMs: APP_STORE_FETCH_TIMEOUT_MS,
  });
  if (!response.ok) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    throw new Error(`Apple Search API HTTP ${response.status}`);
  }
  // Worker 没有 Go 的 LimitReader；必须在流式读取时主动截断，避免异常响应占用 isolate 内存。
  const text = await readResponseTextWithLimit(response, APP_STORE_RESPONSE_LIMIT_BYTES);
  const payload = JSON.parse(text) as AppStoreAPIResponse;
  return sanitizeAppStoreAPIResults(payload.results ?? []);
}

async function readCachedAppStoreResults(key: string): Promise<CachedAppStoreResults | null> {
  const cache = appStoreCache();
  if (!cache) return null;
  const response = await cache.match(appStoreCacheRequest(key));
  if (!response?.ok) return null;
  try {
    const payload = await response.json() as CachedAppStoreResults;
    if (!Array.isArray(payload.results) || !Number.isFinite(payload.fetchedAt)) return null;
    return {
      fetchedAt: payload.fetchedAt,
      results: sanitizeAppStoreAPIResults(payload.results),
    };
  } catch {
    return null;
  }
}

async function writeCachedAppStoreResults(key: string, results: AppStoreAPIResult[]): Promise<void> {
  const cache = appStoreCache();
  if (!cache) return;
  const payload: CachedAppStoreResults = { fetchedAt: Date.now(), results };
  // Cloudflare Cache API 的内容留在当前数据中心，不会全局复制；pending 合并只覆盖同 isolate 内的并发请求。
  await cache.put(appStoreCacheRequest(key), new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${Math.floor(APP_STORE_STALE_TTL_MS / 1000)}`,
    },
  })).catch(() => undefined);
}

function appStoreCache(): Cache | null {
  const storage = typeof caches === "undefined"
    ? undefined
    : caches as CacheStorage & { default?: Cache };
  return storage?.default ?? null;
}

function appStoreCacheRequest(key: string): Request {
  return new Request(`${APP_STORE_CACHE_PREFIX}?key=${encodeURIComponent(key)}`, { method: "GET" });
}

function appStoreResultsToCandidates(
  kind: MediaCandidateKind,
  matchedQuery: string,
  countryResults: AppStoreCountryResult[],
  limit: number,
): MediaCandidate[] {
  // 双区结果按 app id/bundle/artwork 去重，再按分数与 US->CN 固定顺序排序，保持 Docker/Worker 输出一致。
  interface ScoredCandidate {
    candidate: MediaCandidate;
    score: number;
    countryRank: number;
    resultIndex: number;
  }
  const byKey = new Map<string, ScoredCandidate>();
  for (const group of [...countryResults].sort((left, right) => appStoreCountryRank(left.country) - appStoreCountryRank(right.country))) {
    const countryRank = appStoreCountryRank(group.country);
    group.results.forEach((result, resultIndex) => {
      const artworkUrl = appStoreArtworkUrl(result);
      if (!artworkUrl) return;
      const score = scoreAppStoreIconResult(result, matchedQuery);
      if (score < mediaResolverConfig.scores.mediumThreshold) return;
      const dedupeKey = appStoreDedupeKey(result, artworkUrl);
      const candidate = appStoreCandidateFromResult(kind, matchedQuery, group.country, result, artworkUrl, confidenceFromScore(score), resultIndex);
      const current = byKey.get(dedupeKey);
      if (!current || score > current.score || (score === current.score && (countryRank < current.countryRank || (countryRank === current.countryRank && resultIndex < current.resultIndex)))) {
        byKey.set(dedupeKey, { candidate, score, countryRank, resultIndex });
      }
    });
  }
  return [...byKey.values()]
    .sort((left, right) => (
      right.score - left.score
      || left.countryRank - right.countryRank
      || left.resultIndex - right.resultIndex
      || left.candidate.label.localeCompare(right.candidate.label)
    ))
    .slice(0, limit)
    .map((item, rank) => ({ ...item.candidate, rank }));
}

function appStoreCandidateFromResult(
  kind: MediaCandidateKind,
  matchedQuery: string,
  country: AppStoreStorefront,
  result: AppStoreAPIResult,
  artworkUrl: string,
  confidence: MediaCandidateConfidence,
  rank: number,
): MediaCandidate {
  return {
    id: appStoreCandidateId(country, result, artworkUrl),
    kind,
    source: "appStore",
    provider: APP_STORE_PROVIDER,
    label: nonEmptyString(result.trackName) || nonEmptyString(result.sellerName) || APP_STORE_PROVIDER,
    variant: null,
    url: artworkUrl,
    confidence,
    autoAssignable: false,
    matchedQuery: matchedQuery || APP_STORE_PROVIDER,
    rank,
  };
}

function scoreAppStoreIconResult(result: AppStoreAPIResult, query: string): number {
  const compactQuery = compactMediaTerm(query);
  const parts = query.split(/\s+/).filter(Boolean);
  let best = 0;
  for (const term of [result.trackName, result.sellerName, result.bundleId]) {
    const normalized = normalizeMediaTerm(term ?? "");
    if (!normalized) continue;
    const compact = compactMediaTerm(normalized);
    if (normalized === query || compact === compactQuery) best = Math.max(best, mediaResolverConfig.scores.exact);
    else if (normalized.startsWith(query) || compact.startsWith(compactQuery)) best = Math.max(best, mediaResolverConfig.scores.prefix);
    else if (normalized.includes(query) || compact.includes(compactQuery)) best = Math.max(best, mediaResolverConfig.scores.contains);
    else if (parts.length > 1 && parts.every((part) => normalized.includes(part))) best = Math.max(best, mediaResolverConfig.scores.allParts);
    else if (compactQuery.length >= 4 && isSubsequence(compactQuery, compact)) best = Math.max(best, mediaResolverConfig.scores.subsequence);
  }
  return best;
}

function confidenceFromScore(score: number): MediaCandidateConfidence {
  if (score >= mediaResolverConfig.scores.exact) return "exact";
  if (score >= mediaResolverConfig.scores.strongThreshold) return "strong";
  if (score >= mediaResolverConfig.scores.mediumThreshold) return "medium";
  return "weak";
}

function appStoreArtworkUrl(result: AppStoreAPIResult): string {
  // 512 字段实测存在但官方稳定字段还有 60/100；只按字段兜底选择，不改写 URL 尺寸。
  for (const value of [result.artworkUrl512, result.artworkUrl100, result.artworkUrl60]) {
    const url = nonEmptyString(value);
    if (url && isSafeAppStoreArtworkUrl(url)) return url;
  }
  return "";
}

function isSafeAppStoreArtworkUrl(value: string): boolean {
  // Apple 元数据仍按不可信输入处理；候选只允许 HTTPS Apple CDN artwork，拒绝 userinfo 和第三方 host。
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && (host === "mzstatic.com" || host.endsWith(".mzstatic.com"));
  } catch {
    return false;
  }
}

function sanitizeAppStoreAPIResults(results: AppStoreAPIResult[]): AppStoreAPIResult[] {
  // Cache API 只保存展示所需窄字段，避免把 Apple raw response 变成持久排障数据。
  const out: AppStoreAPIResult[] = [];
  for (const result of results) {
    const normalized: AppStoreAPIResult = {
      trackId: typeof result.trackId === "number" && Number.isFinite(result.trackId) ? result.trackId : undefined,
      trackName: nonEmptyString(result.trackName),
      sellerName: nonEmptyString(result.sellerName),
      bundleId: nonEmptyString(result.bundleId),
      artworkUrl512: nonEmptyString(result.artworkUrl512),
      artworkUrl100: nonEmptyString(result.artworkUrl100),
      artworkUrl60: nonEmptyString(result.artworkUrl60),
      trackViewUrl: nonEmptyString(result.trackViewUrl),
    };
    if (!normalized.trackName || !appStoreArtworkUrl(normalized)) continue;
    out.push(normalized);
    if (out.length >= APP_STORE_COUNTRY_LIMIT) break;
  }
  return out;
}

async function readResponseTextWithLimit(response: Response, limitBytes: number): Promise<string> {
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Apple Search API response too large");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limitBytes) throw new Error("Apple Search API response too large");
    return text;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Apple Search API response too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function appStoreCacheKey(normalizedQuery: string, country: AppStoreStorefront): string {
  return `${normalizedQuery}\0${country}`;
}

function appStoreDedupeKey(result: AppStoreAPIResult, artworkUrl: string): string {
  if (result.trackId && result.trackId > 0) return `track:${result.trackId}`;
  if (result.bundleId) return `bundle:${result.bundleId.toLowerCase()}`;
  return `artwork:${artworkUrl}`;
}

function appStoreCandidateId(country: AppStoreStorefront, result: AppStoreAPIResult, artworkUrl: string): string {
  if (result.trackId && result.trackId > 0) return `appstore:${country}:${result.trackId}`;
  if (result.bundleId) return `appstore:${country}:${result.bundleId.toLowerCase()}`;
  return `appstore:${country}:${compactMediaTerm(artworkUrl)}`;
}

function appStoreCountryRank(country: AppStoreStorefront): number {
  return APP_STORE_STOREFRONTS.indexOf(country);
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
