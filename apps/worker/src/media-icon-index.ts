import {
  mergeBuiltInIconSearchIndexes,
} from "@renewlet/shared/built-in-icon-index-builder";
import { BUILT_IN_ICON_PROVIDERS, type BuiltInIconProvider } from "@renewlet/shared/built-in-icons";
import {
  createMediaResolverFromSearchIndex,
  type BuiltInIconSearchIndex,
  type MediaResolver,
} from "@renewlet/shared/media-resolver";
import { mediaResolverConfig } from "@renewlet/shared/media-resolver-config";
import {
  builtInIconIndexProviderCheckPayloadSchema,
  builtInIconIndexProviderRefreshPayloadSchema,
  builtInIconSeedMetadataSchema,
  builtInIconIndexStatusSchema,
  type BuiltInIconIndexProviderStatus,
  type BuiltInIconSeedMetadata,
  type BuiltInIconIndexStatus,
  type BuiltInIconProviderVersion,
} from "@renewlet/shared/schemas/media";
import { requireAdmin } from "./auth";
import { nowIso } from "./db";
import { errorResponse, HttpError, requireEmptyBody, requestLocale, successJson } from "./http";
import {
  createRefreshJob,
  hasRefreshingJob,
  isMediaIconIndexRefreshJobSchemaError,
  markRefreshJobFailed,
  readActiveRefreshJob,
  readLatestRefreshJobs,
  refreshJobFromRow,
  type ProviderRefreshJobs,
} from "./media-icon-index-refresh-jobs";
import type { Env, MediaIconIndexRow } from "./types";
import {
  createUpstreamHTTPError,
  providerMessageFromResponse,
  readUpstreamResponseTextUpToLimit,
  upstreamErrorDetailsFromError,
  upstreamProviderResponseFromFetchResponse,
} from "./upstream-response";
import { sendUpstreamRequest } from "./upstream-http";

const MEDIA_ICON_INDEX_KEY = "active";
const REGISTRY_FETCH_TIMEOUT_MS = 15_000;
const GITHUB_ATOM_FEED_LIMIT_BYTES = 512 * 1024;
const GITHUB_WEB_BASE = "https://github.com";
const SEED_METADATA_PATH = "/built-in-icons/metadata.json";
const SEED_SEARCH_INDEX_PATH = "/built-in-icons/search-index.json.gz";
const PROVIDER_STATE_WRITE_ATTEMPTS = 3;

type StoredProviderState = {
  current?: BuiltInIconProviderVersion | null;
  latest?: BuiltInIconProviderVersion | null;
  searchR2Key?: string;
  searchHash?: string;
  iconCount?: number;
  checkedAt?: string;
  refreshedAt?: string;
  lastError?: string;
  etag?: string;
};
type StoredProviderStates = Partial<Record<BuiltInIconProvider, StoredProviderState>>;

let seedMetadataCache: BuiltInIconSeedMetadata | null = null;
let resolverCache: { hash: string; resolver: MediaResolver } | null = null;

export function clearBuiltInIconResolverCache(): void {
  resolverCache = null;
}

/**
 * 读取当前 active resolver。
 *
 * Worker isolate 可复用模块级缓存，但缓存键只允许是索引 hash，不能混入 request/auth/settings，
 * 否则同一 isolate 内不同用户的来源偏好会被串用。
 */
export async function getActiveBuiltInMediaResolver(env: Env): Promise<MediaResolver> {
  const active = await readActiveBuiltInSearchState(env);
  if (resolverCache?.hash === active.cacheKey) return resolverCache.resolver;

  const resolver = createMediaResolverFromSearchIndex(
    active.searchIndex,
    mediaResolverConfig,
    providerCdnBaseOverrides(active.states, active.activeProviders),
  );
  resolverCache = { hash: active.cacheKey, resolver };
  return resolver;
}

export async function builtInIconIndexStatus(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  return successJson(builtInIconIndexStatusSchema.parse(await readBuiltInIconIndexStatus(env)));
}

export async function checkBuiltInIconIndexProvider(request: Request, env: Env, provider: string): Promise<Response> {
  const locale = requestLocale(request);
  await requireAdmin(request, env);
  await requireEmptyBody(request, locale);
  const parsedProvider = parseBuiltInIconProvider(provider);
  if (!parsedProvider) throw new HttpError(400, "Invalid built-in icon provider", "INVALID_PROVIDER");

  try {
    const checkedAt = nowIso();
    // Cloudflare check 不抢刷新锁；它只更新 latest/lastError，避免一次 GitHub 超时挡住真正的 Queue refresh。
    const { version, etag } = await checkLatestProviderVersion(env, parsedProvider);
    await saveProviderLatest(env, parsedProvider, checkedAt, version, etag);
    const status = await readBuiltInIconIndexStatus(env);
    return successJson(builtInIconIndexProviderCheckPayloadSchema.parse({ status, provider: providerStatus(status, parsedProvider) }));
  } catch (error) {
    const message = providerFailureMessage(error);
    const errorDetails = upstreamErrorDetailsFromError(error);
    await saveProviderFailure(env, parsedProvider, nowIso(), message);
    const status = await readBuiltInIconIndexStatus(env);
    // check 只是更新 provider 可见状态；GitHub 限流/断网时仍返回同形状 body，让前端展示失败 badge 而不是把弹层流程打断。
    return successJson(builtInIconIndexProviderCheckPayloadSchema.parse({
      status,
      provider: providerStatus(status, parsedProvider),
      ...(errorDetails ? { errorDetails } : {}),
    }));
  }
}

export async function refreshBuiltInIconIndexProvider(request: Request, env: Env, provider: string): Promise<Response> {
  const locale = requestLocale(request);
  await requireAdmin(request, env);
  await requireEmptyBody(request, locale);
  const parsedProvider = parseBuiltInIconProvider(provider);
  if (!parsedProvider) throw new HttpError(400, "Invalid built-in icon provider", "INVALID_PROVIDER");

  if (!env.MEDIA_ICON_INDEX_REFRESH_QUEUE) {
    return errorResponse(503, "Built-in icon index refresh queue is not configured", "MEDIA_ICON_INDEX_REFRESH_QUEUE_MISSING");
  }

  let existing;
  try {
    existing = await readActiveRefreshJob(env, parsedProvider);
  } catch (error) {
    if (isMediaIconIndexRefreshJobSchemaError(error)) {
      return errorResponse(503, "Built-in icon index refresh job schema is unavailable", "MEDIA_ICON_INDEX_REFRESH_SCHEMA_UNAVAILABLE");
    }
    throw error;
  }
  if (existing) {
    const status = await readBuiltInIconIndexStatus(env);
    return successJson(builtInIconIndexProviderRefreshPayloadSchema.parse({
      status,
      provider: providerStatus(status, parsedProvider),
      job: refreshJobFromRow(existing),
    }));
  }

  let refreshJobResult: Awaited<ReturnType<typeof createRefreshJob>>;
  try {
    refreshJobResult = await createRefreshJob(env, parsedProvider);
  } catch (error) {
    if (isMediaIconIndexRefreshJobSchemaError(error)) {
      return errorResponse(503, "Built-in icon index refresh job schema is unavailable", "MEDIA_ICON_INDEX_REFRESH_SCHEMA_UNAVAILABLE");
    }
    throw new HttpError(409, "Built-in icon index refresh is already running", "MEDIA_ICON_INDEX_REFRESHING");
  }
  const { job, created } = refreshJobResult;
  if (!created) {
    const status = await readBuiltInIconIndexStatus(env);
    return successJson(builtInIconIndexProviderRefreshPayloadSchema.parse({
      status,
      provider: providerStatus(status, parsedProvider),
      job,
    }));
  }

  try {
    // HTTP 请求只落 D1 job 并投递 Queue；10k 图标的构建/gzip/merge 不再占用请求 CPU 和内存预算。
    await env.MEDIA_ICON_INDEX_REFRESH_QUEUE.send({
      jobId: job.id,
      provider: parsedProvider,
      requestedAt: job.queuedAt,
    });
  } catch (error) {
    const message = providerFailureMessage(error);
    await recordRefreshJobFailure(env, job.id, parsedProvider, message, null);
    throw new HttpError(502, "Built-in icon index refresh queue enqueue failed", "MEDIA_ICON_INDEX_REFRESH_ENQUEUE_FAILED");
  }

  const status = await readBuiltInIconIndexStatus(env);
  return successJson(builtInIconIndexProviderRefreshPayloadSchema.parse({
    status,
    provider: providerStatus(status, parsedProvider),
    job,
  }));
}

async function readBuiltInIconIndexStatus(env: Env): Promise<BuiltInIconIndexStatus> {
  const row = await readMediaIconIndexRow(env);
  const states = parseProviderStates(row?.provider_status_json);
  const seedMetadata = await readSeedMetadata(env);
  const jobs = await readLatestRefreshJobs(env, BUILT_IN_ICON_PROVIDERS);
  // Cloudflare 的 refreshing 只看 D1 job；旧 locked_until 只属于同步模型，不能再影响设置页状态。
  const jobRefreshing = hasRefreshingJob(jobs);
  const activeProviders = activeRuntimeProviders(states);
  if (activeProviders.size === 0) {
    return {
      source: "embedded",
      hash: seedMetadata.hash,
      iconCount: seedMetadata.iconCount,
      providerCounts: seedMetadata.providerCounts,
      checkedAt: row?.checked_at ?? null,
      updatedAt: null,
      refreshing: jobRefreshing,
      providers: providerStatuses(seedMetadata.providerCounts, states, seedMetadata, jobs),
    };
  }
  const providerCounts = providerCountsFromStates(states, seedMetadata);
  const hash = row?.hash ?? await providerCompositeHash(seedMetadata, states, activeProviders);
  return {
    source: "runtime",
    hash,
    iconCount: sumProviderCounts(providerCounts),
    providerCounts,
    checkedAt: row?.checked_at ?? null,
    updatedAt: row?.index_updated_at ?? null,
    refreshing: jobRefreshing,
    providers: providerStatuses(providerCounts, states, seedMetadata, jobs),
  };
}

async function readMediaIconIndexRow(env: Env): Promise<MediaIconIndexRow | null> {
  return await env.DB.prepare("SELECT * FROM media_icon_indexes WHERE key = ? LIMIT 1")
    .bind(MEDIA_ICON_INDEX_KEY)
    .first<MediaIconIndexRow>();
}

async function readSeedMetadata(env: Env): Promise<BuiltInIconSeedMetadata> {
  if (seedMetadataCache) return seedMetadataCache;
  const response = await env.ASSETS.fetch(new Request(new URL(SEED_METADATA_PATH, "https://renewlet-static.local")));
  if (!response.ok) throw new Error(`built-in icon seed metadata asset HTTP ${response.status}`);
  seedMetadataCache = builtInIconSeedMetadataSchema.parse(await response.json());
  return seedMetadataCache;
}

async function readSeedSearchIndex(env: Env): Promise<BuiltInIconSearchIndex> {
  return JSON.parse(await gunzipToText(await staticAssetBytes(env, SEED_SEARCH_INDEX_PATH))) as BuiltInIconSearchIndex;
}

async function readActiveBuiltInSearchState(env: Env): Promise<{
  cacheKey: string;
  searchIndex: BuiltInIconSearchIndex;
  states: StoredProviderStates;
  activeProviders: ReadonlySet<BuiltInIconProvider>;
}> {
  const [row, seedMetadata, seedSearchIndex] = await Promise.all([
    readMediaIconIndexRow(env),
    readSeedMetadata(env),
    readSeedSearchIndex(env),
  ]);
  const states = parseProviderStates(row?.provider_status_json);
  const providerIndexes: Partial<Record<BuiltInIconProvider, BuiltInIconSearchIndex>> = {};
  const activeProviders = new Set<BuiltInIconProvider>();
  await Promise.all(BUILT_IN_ICON_PROVIDERS.map(async (provider) => {
    const key = states[provider]?.searchR2Key;
    if (!key) return;
    const object = await env.ASSETS_BUCKET.get(key);
    if (!object) return;
    // 已刷新 provider 读 R2；未刷新或对象缺失的 provider 保持 seed，单个 provider 坏掉不拖垮全局搜索。
    providerIndexes[provider] = JSON.parse(await gunzipToText(new Uint8Array(await object.arrayBuffer()))) as BuiltInIconSearchIndex;
    activeProviders.add(provider);
  }));
  if (activeProviders.size === 0) {
    return { cacheKey: seedMetadata.hash, searchIndex: seedSearchIndex, states, activeProviders };
  }
  const cacheKey = await providerCompositeHash(seedMetadata, states, activeProviders);
  return {
    cacheKey,
    searchIndex: mergeBuiltInIconSearchIndexes(providerIndexes, seedSearchIndex),
    states,
    activeProviders,
  };
}

async function staticAssetBytes(env: Env, path: string): Promise<Uint8Array> {
  const response = await env.ASSETS.fetch(new Request(new URL(path, "https://renewlet-static.local")));
  if (!response.ok) throw new Error(`built-in icon seed asset ${path} HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function ensureMediaIconIndexRow(env: Env): Promise<void> {
  const timestamp = nowIso();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO media_icon_indexes (key, provider_counts_json, provider_status_json, created_at, updated_at)
    VALUES (?, '{}', '{}', ?, ?)
  `).bind(MEDIA_ICON_INDEX_KEY, timestamp, timestamp).run();
}

async function readProviderStates(env: Env): Promise<StoredProviderStates> {
  return parseProviderStates((await readMediaIconIndexRow(env))?.provider_status_json);
}

export async function recordRefreshJobFailure(
  env: Env,
  jobId: string,
  provider: BuiltInIconProvider,
  message: string,
  indexHash: string | null,
): Promise<void> {
  const timestamp = nowIso();
  await markRefreshJobFailed(env, jobId, provider, message, indexHash);
  await saveProviderFailure(env, provider, timestamp, message);
}

async function saveProviderLatest(
  env: Env,
  provider: BuiltInIconProvider,
  checkedAt: string,
  version: BuiltInIconProviderVersion,
  etag: string,
): Promise<void> {
  await ensureMediaIconIndexRow(env);
  await writeProviderStates(env, (states) => {
    const current = states[provider] ?? {};
    const next: StoredProviderState = { ...current, latest: version, checkedAt, lastError: "" };
    const nextEtag = etag || current.etag;
    if (nextEtag) next.etag = nextEtag;
    states[provider] = next;
    return checkedAt;
  });
}

export async function recordProviderSearchRefreshSuccess(
  env: Env,
  input: {
    jobId: string;
    provider: BuiltInIconProvider;
    version: BuiltInIconProviderVersion;
    etag: string;
    searchR2Key: string;
    searchHash: string;
    iconCount: number;
  },
): Promise<void> {
  await ensureMediaIconIndexRow(env);
  const seedMetadata = await readSeedMetadata(env);
  const states = await readProviderStates(env);
  const timestamp = nowIso();
  const current = states[input.provider] ?? {};
  const next: StoredProviderState = {
    ...current,
    current: input.version,
    latest: input.version,
    searchR2Key: input.searchR2Key,
    searchHash: input.searchHash,
    iconCount: input.iconCount,
    checkedAt: timestamp,
    refreshedAt: timestamp,
    lastError: "",
  };
  const nextEtag = input.etag || current.etag;
  if (nextEtag) next.etag = nextEtag;
  states[input.provider] = next;
  const activeProviders = activeRuntimeProviders(states);
  const providerCounts = providerCountsFromStates(states, seedMetadata);
  const hash = await providerCompositeHash(seedMetadata, states, activeProviders);
  // R2 provider 索引已写入后才在 D1 batch 里同时切 active 指针和 job 终态；任一 D1 写失败都保持旧索引可用。
  await env.DB.batch([
    env.DB.prepare(`
    UPDATE media_icon_indexes
    SET hash = ?, search_r2_key = ?, detail_r2_key = ?, icon_count = ?, provider_counts_json = ?, provider_status_json = ?,
        checked_at = ?, index_updated_at = ?, updated_at = ?
    WHERE key = ?
  `).bind(
      hash,
      null,
      null,
      sumProviderCounts(providerCounts),
      JSON.stringify(providerCounts),
      JSON.stringify(states),
      timestamp,
      timestamp,
      timestamp,
      MEDIA_ICON_INDEX_KEY,
    ),
    env.DB.prepare(`
    UPDATE media_icon_index_refresh_jobs
    SET status = 'succeeded', error = NULL, index_hash = ?, finished_at = ?, updated_at = ?
    WHERE id = ? AND provider = ?
  `).bind(
      input.searchHash,
      timestamp,
      timestamp,
      input.jobId,
      input.provider,
    ),
  ]);
}

async function saveProviderFailure(env: Env, provider: BuiltInIconProvider, checkedAt: string, message: string): Promise<void> {
  await ensureMediaIconIndexRow(env);
  await writeProviderStates(env, (states) => {
    states[provider] = { ...(states[provider] ?? {}), checkedAt, lastError: message };
    return checkedAt;
  });
}

async function writeProviderStates(
  env: Env,
  mutate: (states: StoredProviderStates) => string,
): Promise<void> {
  for (let attempt = 0; attempt < PROVIDER_STATE_WRITE_ATTEMPTS; attempt += 1) {
    const row = await readMediaIconIndexRow(env);
    const previousJson = row?.provider_status_json || "{}";
    const states = parseProviderStates(previousJson);
    const checkedAt = mutate(states);
    const result = await env.DB.prepare(`
    UPDATE media_icon_indexes
    SET checked_at = ?, provider_status_json = ?, updated_at = ?
    WHERE key = ? AND provider_status_json = ?
  `).bind(checkedAt, JSON.stringify(states), checkedAt, MEDIA_ICON_INDEX_KEY, previousJson).run();
    if (typeof result.meta.changes === "number" && result.meta.changes > 0) return;
  }
  // provider_status_json 用乐观写保护 check/refresh 并发；多次冲突说明状态被持续改写，应让调用方显式失败。
  throw new Error("built-in icon provider state changed while updating");
}

export async function checkLatestProviderVersion(
  env: Env,
  provider: BuiltInIconProvider,
): Promise<{ version: BuiltInIconProviderVersion; etag: string }> {
  const states = await readProviderStates(env);
  const current = states[provider] ?? {};
  const result = await fetchLatestProviderVersion(env, provider, current.etag ?? "");
  if (result.notModified && current.latest) return { version: current.latest, etag: result.etag || current.etag || "" };
  if (!result.version) throw new Error("latest provider version is unavailable");
  return { version: result.version, etag: result.etag || current.etag || "" };
}

async function fetchLatestProviderVersion(
  env: Env,
  provider: BuiltInIconProvider,
  etag: string,
): Promise<{ version: BuiltInIconProviderVersion | null; etag: string; notModified: boolean }> {
  const config = mediaResolverConfig.builtInProviders.find((item) => item.provider === provider);
  if (!config) throw new Error(`unknown built-in icon provider: ${provider}`);
  const commit = await fetchGitHubAtomFeed(env, gitHubAtomFeedUrl(config.github.owner, config.github.repo, `commits/${config.github.branch}`), etag, "GitHub commit feed");
  if (commit.notModified) return { version: null, etag: commit.etag, notModified: true };
  const parsedCommit = parseGitHubCommitAtomFeed(commit.text);
  const shortSha = parsedCommit.sha.slice(0, 7);
  const version: BuiltInIconProviderVersion = {
    sourceRef: parsedCommit.sha,
    displayVersion: shortSha,
    commitSha: parsedCommit.sha,
    commitShortSha: shortSha,
    commitDate: parsedCommit.updated || null,
    releaseTag: null,
    releasePublishedAt: null,
  };
  if (config.github.latestRelease) {
    const release = await fetchLatestProviderRelease(env, config.github.owner, config.github.repo);
    if (release.tagName) {
      version.releaseTag = release.tagName;
    }
    version.releasePublishedAt = release.publishedAt;
  }
  return { version, etag: commit.etag, notModified: false };
}

async function fetchLatestProviderRelease(env: Env, owner: string, repo: string): Promise<{ tagName: string | null; publishedAt: string | null }> {
  try {
    const release = await fetchGitHubAtomFeed(env, gitHubAtomFeedUrl(owner, repo, "releases"), "", "GitHub release feed");
    return parseGitHubReleaseAtomFeed(release.text);
  } catch {
    return { tagName: null, publishedAt: null };
  }
}

async function fetchGitHubAtomFeed(
  env: Env,
  url: string,
  etag: string,
  label: string,
): Promise<{ text: string; etag: string; notModified: boolean }> {
  const headers: HeadersInit = {
    accept: "application/atom+xml",
    "user-agent": `Renewlet/${env.RENEWLET_VERSION?.trim() || "cloudflare"}`,
  };
  if (etag) headers["if-none-match"] = etag;
  const response = await sendUpstreamRequest(url, { headers }, {
    provider: label,
    timeoutMs: REGISTRY_FETCH_TIMEOUT_MS,
  });
  const nextEtag = response.headers.get("etag") ?? "";
  if (response.status === 304) return { text: "", etag: nextEtag, notModified: true };
  if (!response.ok) throw await githubAtomFeedError(response, label);
  // provider check 故意读 GitHub Atom feed 而不是 REST API；错误 raw 仍只随当前管理员操作返回，不进入持久状态。
  return {
    text: await readUpstreamResponseTextUpToLimit(response, label, GITHUB_ATOM_FEED_LIMIT_BYTES),
    etag: nextEtag,
    notModified: false,
  };
}

async function githubAtomFeedError(response: Response, label: string): Promise<Error> {
  const providerResponse = await upstreamProviderResponseFromFetchResponse(response);
  const providerMessage = providerMessageFromResponse(providerResponse);
  return createUpstreamHTTPError({
    provider: label,
    response,
    providerResponse,
    providerMessage: providerMessage || `${label} HTTP ${response.status}`,
  });
}

function parseGitHubCommitAtomFeed(text: string): { sha: string; updated: string | null } {
  const entry = firstGitHubAtomEntry(text);
  const id = atomTagText(entry, "id");
  const sha = id.match(/\/([a-f0-9]{7,40})$/i)?.[1] ?? "";
  if (!sha) throw new Error("GitHub commit feed missing sha");
  return { sha, updated: atomTagText(entry, "updated") || null };
}

function parseGitHubReleaseAtomFeed(text: string): { tagName: string | null; publishedAt: string | null } {
  const entry = firstGitHubAtomEntry(text);
  const href = entry.match(/<link\b[^>]*\bhref="([^"]+)"/i)?.[1] ?? "";
  const rawTag = href.match(/\/releases\/tag\/([^/?#"]+)/i)?.[1] ?? "";
  const tagName = rawTag ? decodePathSegment(xmlText(rawTag)).trim() : "";
  return {
    tagName: tagName || null,
    publishedAt: atomTagText(entry, "updated") || null,
  };
}

function firstGitHubAtomEntry(text: string): string {
  const entry = text.match(/<entry\b[\s\S]*?<\/entry>/i)?.[0] ?? "";
  if (!entry) throw new Error("GitHub Atom feed is empty");
  return entry;
}

function atomTagText(entry: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  return xmlText(entry.match(pattern)?.[1] ?? "").trim();
}

function xmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function gitHubAtomFeedUrl(owner: string, repo: string, feedPath: string): string {
  return `${GITHUB_WEB_BASE}/${owner}/${repo}/${feedPath.replace(/^\/+|\/+$/g, "")}.atom`;
}

function providerStatuses(
  counts: BuiltInIconIndexStatus["providerCounts"],
  states: StoredProviderStates,
  seedMetadata: BuiltInIconSeedMetadata,
  jobs: ProviderRefreshJobs,
): BuiltInIconIndexProviderStatus[] {
  return BUILT_IN_ICON_PROVIDERS.map((provider) => {
    const state = states[provider] ?? {};
    const current = state.current ?? embeddedProviderVersion(provider, seedMetadata);
    const latest = state.latest ?? null;
    const job = jobs[provider] ?? null;
    return {
      provider,
      current,
      latest,
      iconCount: counts[provider],
      checkedAt: nonEmpty(state.checkedAt),
      refreshedAt: nonEmpty(state.refreshedAt),
      lastError: nonEmpty(state.lastError),
      refreshing: job?.status === "queued" || job?.status === "running",
      updateAvailable: providerUpdateAvailable(current, latest),
      ...(job ? { job } : {}),
    };
  });
}

function embeddedProviderVersion(provider: BuiltInIconProvider, seedMetadata: BuiltInIconSeedMetadata): BuiltInIconProviderVersion | null {
  const version = seedMetadata.providers[provider];
  if (!version?.commitSha || !version.commitShortSha) return null;
  // seed metadata 是生成期记录的真实 GitHub HEAD；runtime 缺 provider current 时只能回退到它，不能编造 embedded/runtime 版本。
  return { ...version };
}

function parseProviderStates(value: string | null | undefined): StoredProviderStates {
  try {
    const parsed = JSON.parse(value || "{}") as StoredProviderStates;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function providerCdnBaseOverrides(
  states: StoredProviderStates,
  activeProviders?: ReadonlySet<BuiltInIconProvider>,
): Partial<Record<BuiltInIconProvider, string>> {
  return Object.fromEntries(BUILT_IN_ICON_PROVIDERS.flatMap((provider) => {
    if (activeProviders && !activeProviders.has(provider)) return [];
    const commitSha = states[provider]?.current?.commitSha;
    return commitSha ? [[provider, providerPinnedCdnBase(provider, commitSha)] as const] : [];
  }));
}

export function providerPinnedCdnBase(provider: BuiltInIconProvider, ref: string): string {
  const config = mediaResolverConfig.builtInProviders.find((item) => item.provider === provider);
  return config ? `https://testingcf.jsdelivr.net/gh/${config.github.owner}/${config.github.repo}@${ref}` : "";
}

function providerUpdateAvailable(current: BuiltInIconProviderVersion | null, latest: BuiltInIconProviderVersion | null): boolean {
  if (!latest) return false;
  if (!current) return true;
  if (current.commitSha && latest.commitSha) return current.commitSha !== latest.commitSha;
  return current.sourceRef !== latest.sourceRef;
}

function providerStatus(status: BuiltInIconIndexStatus, provider: BuiltInIconProvider): BuiltInIconIndexProviderStatus {
  return status.providers.find((item) => item.provider === provider) ?? {
    provider,
    current: null,
    latest: null,
    iconCount: 0,
    checkedAt: null,
    refreshedAt: null,
    lastError: null,
    refreshing: false,
    updateAvailable: false,
  };
}

export async function gunzipToText(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([copyToArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

export async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function parseBuiltInIconProvider(value: string): BuiltInIconProvider | null {
  return BUILT_IN_ICON_PROVIDERS.includes(value as BuiltInIconProvider) ? value as BuiltInIconProvider : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  return [...value].slice(0, maxLength).join("");
}

export function providerFailureMessage(error: unknown): string {
  const details = upstreamErrorDetailsFromError(error);
  let message = error instanceof Error ? error.message : String(error);
  const raw = details?.rawResponseText?.trim();
  if (raw) {
    const durableSummary = raw.split(";")[0]?.trim() || "upstream request failed";
    message = message.split(raw).join("").trim().replace(/:\s*$/, "").trim() || durableSummary;
  }
  return truncateText(message, 2000);
}

function activeRuntimeProviders(states: StoredProviderStates): Set<BuiltInIconProvider> {
  return new Set(BUILT_IN_ICON_PROVIDERS.filter((provider) => Boolean(states[provider]?.searchR2Key && states[provider]?.searchHash)));
}

function providerCountsFromStates(
  states: StoredProviderStates,
  seedMetadata: BuiltInIconSeedMetadata,
): BuiltInIconIndexStatus["providerCounts"] {
  return BUILT_IN_ICON_PROVIDERS.reduce<BuiltInIconIndexStatus["providerCounts"]>((counts, provider) => ({
    ...counts,
    [provider]: Math.max(0, Math.floor(states[provider]?.iconCount ?? seedMetadata.providerCounts[provider] ?? 0)),
  }), { thesvg: 0, selfhst: 0, dashboardIcons: 0 });
}

function sumProviderCounts(counts: BuiltInIconIndexStatus["providerCounts"]): number {
  return counts.thesvg + counts.selfhst + counts.dashboardIcons;
}

async function providerCompositeHash(
  seedMetadata: BuiltInIconSeedMetadata,
  states: StoredProviderStates,
  activeProviders: ReadonlySet<BuiltInIconProvider>,
): Promise<string> {
  // composite hash 同时包含 seed 和 runtime provider，确保 resolver cache 随任一 provider 切换而失效。
  const source = Object.fromEntries(BUILT_IN_ICON_PROVIDERS.map((provider) => {
    const state = states[provider] ?? {};
    return [provider, activeProviders.has(provider)
      ? { hash: state.searchHash ?? "", version: state.current?.commitSha ?? "", count: state.iconCount ?? 0 }
      : { hash: seedMetadata.providers[provider].commitSha ?? "", version: seedMetadata.providers[provider].commitSha ?? "", count: seedMetadata.providerCounts[provider] }];
  }));
  return await sha256HexText(JSON.stringify({ version: 1, providers: source }));
}

export async function sha256HexText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
