import type {
  MediaCandidate,
  MediaCandidateConfidence,
  MediaCandidateGroup,
  MediaCandidateKind,
  MediaCandidateMode,
  MediaCandidateResolveItem,
  MediaCandidateResolveItemResponse,
} from "./schemas/media";
import {
  DEFAULT_BUILT_IN_ICON_SOURCES,
  type BuiltInIconProvider,
  type BuiltInIconSourceSettings,
} from "./built-in-icons";
import { mediaResolverConfig, type MediaResolverConfig } from "./media-resolver-config";

/** 离线索引中的内置图标条目；生成脚本负责把上游 registry 收敛成这个窄形状。 */
export interface BuiltInIcon {
  provider: BuiltInIconProvider;
  slug: string;
  title: string;
  aliases?: string[];
  categories?: string[];
  variants: BuiltInIconVariant[];
  terms?: string[];
  compactTerms?: string[];
  exactKeys?: string[];
  tokenKeys?: string[];
  hex?: string;
  license?: string;
  url?: string;
  guidelines?: string;
}

/** provider 的实际可渲染变体；path 会与 provider CDN base 拼成候选 URL。 */
export interface BuiltInIconVariant {
  name: string;
  path: string;
}

/** 运行时热索引只保存普通搜索必需字段；冷字段留在 detail-index，避免 Docker/Worker 常驻大对象。 */
export interface BuiltInIconSearchEntry {
  p: BuiltInIconProvider;
  s: string;
  t: string;
  v: BuiltInIconVariant[];
  q: string[];
}

export interface BuiltInIconSearchIndex {
  version: 1;
  entries: BuiltInIconSearchEntry[];
  canonicalExact: Record<string, number[]>;
  tokenExact: Record<string, number[]>;
}

interface ResolverIcon {
  provider: BuiltInIconProvider;
  slug: string;
  title: string;
  variants: BuiltInIconVariant[];
  providerRank: number;
  terms: string[];
}

interface BuiltInSearchResult {
  candidates: MediaCandidate[];
  matchedQuery: string | null;
}

interface ExactBuiltInMatch {
  index: number;
  baseConfidence: "exact" | "strong";
}

interface SearchOptions {
  sources: BuiltInIconSourceSettings;
}

type FaviconProviderConfig = MediaResolverConfig["favicon"]["providers"][number];

interface FaviconCandidateDomain {
  domain: string;
  direct: boolean;
}

export interface MediaResolver {
  config: MediaResolverConfig;
  icons: ResolverIcon[];
  canonicalExact: Map<string, number[]>;
  tokenExact: Map<string, number[]>;
  providerCdnBase: ReadonlyMap<BuiltInIconProvider, string>;
  preferredVariants: ReadonlyMap<BuiltInIconProvider, readonly string[]>;
  planSuffixWords: ReadonlySet<string>;
  searchModifierSuffixWords: ReadonlySet<string>;
}

/**
 * 创建内置媒体解析器。
 *
 * 索引、provider 排序、首选变体和降词规则都来自 shared config；前端、Go embedded static
 * 和 Cloudflare Worker 必须使用同一套 resolver 规则。
 */
export function createMediaResolver(
  icons: readonly BuiltInIcon[],
  config: MediaResolverConfig = mediaResolverConfig,
  providerCdnBaseOverrides: Partial<Record<BuiltInIconProvider, string>> = {},
): MediaResolver {
  return createMediaResolverFromSearchIndex(createSearchIndexFromIcons(icons, config), config, providerCdnBaseOverrides);
}

export function createMediaResolverFromSearchIndex(
  searchIndex: BuiltInIconSearchIndex,
  config: MediaResolverConfig = mediaResolverConfig,
  providerCdnBaseOverrides: Partial<Record<BuiltInIconProvider, string>> = {},
): MediaResolver {
  if (searchIndex.version !== 1) {
    throw new Error(`Unsupported built-in icon search index version: ${searchIndex.version}`);
  }
  const providerRank = new Map(config.builtInProviders.map((provider, index) => [provider.provider, index]));
  const resolver: MediaResolver = {
    config,
    icons: [],
    canonicalExact: new Map(),
    tokenExact: new Map(),
    providerCdnBase: new Map(config.builtInProviders.map((provider) => [provider.provider, providerCdnBaseOverrides[provider.provider] ?? provider.cdnBase])),
    preferredVariants: new Map(config.builtInProviders.map((provider) => [provider.provider, provider.preferredVariants])),
    planSuffixWords: new Set(config.auto.planSuffixWords),
    searchModifierSuffixWords: new Set(config.search.modifierSuffixWords),
  };

  const sourceIndexToResolverIndex = new Map<number, number>();
  for (let sourceIndex = 0; sourceIndex < searchIndex.entries.length; sourceIndex += 1) {
    const entry = searchIndex.entries[sourceIndex];
    if (!entry) continue;
    if (!entry.v.length) continue;
    const rank = providerRank.get(entry.p);
    if (rank === undefined) continue;
    sourceIndexToResolverIndex.set(sourceIndex, resolver.icons.length);
    resolver.icons.push({
      provider: entry.p,
      slug: entry.s,
      title: entry.t,
      variants: entry.v,
      providerRank: rank,
      terms: entry.q,
    });
  }
  resolver.canonicalExact = remapRecordToNumberMap(searchIndex.canonicalExact, sourceIndexToResolverIndex);
  resolver.tokenExact = remapRecordToNumberMap(searchIndex.tokenExact, sourceIndexToResolverIndex);

  return resolver;
}

function createSearchIndexFromIcons(icons: readonly BuiltInIcon[], config: MediaResolverConfig): BuiltInIconSearchIndex {
  const canonicalExact: Record<string, number[]> = {};
  const tokenExact: Record<string, number[]> = {};
  const planSuffixWords = new Set(config.auto.planSuffixWords);
  const entries = icons.map((icon, index): BuiltInIconSearchEntry => {
    const terms = normalizedTerms(icon.terms?.length ? icon.terms : [icon.slug, icon.title, icon.url ?? "", icon.guidelines ?? "", ...(icon.aliases ?? []), ...(icon.categories ?? [])]);
    const compactKeys = compactTerms(icon.compactTerms?.length ? icon.compactTerms : [icon.slug, icon.title, ...(icon.aliases ?? [])]);
    const canonicalKeys = normalizedTerms(icon.exactKeys?.length ? icon.exactKeys : [icon.slug, icon.title, ...(icon.aliases ?? [])]);
    const tokenKeyValues = normalizedTerms(icon.tokenKeys?.length ? icon.tokenKeys : tokenKeys([icon.slug, icon.title, ...(icon.aliases ?? [])], planSuffixWords));
    for (const key of unique([...canonicalKeys, ...compactKeys])) {
      appendRecordValue(canonicalExact, key, index);
    }
    for (const key of tokenKeyValues) {
      appendRecordValue(tokenExact, key, index);
    }
    return {
      p: icon.provider,
      s: icon.slug,
      t: icon.title,
      v: [...icon.variants],
      q: terms,
    };
  });

  return {
    version: 1,
    entries,
    canonicalExact,
    tokenExact,
  };
}

/**
 * 解析单个 Logo/Icon 候选请求项。
 *
 * auto 模式只返回高置信内置候选；search 模式会保留 favicon 备用预算，避免弱候选被多 provider 变体挤出。
 */
export function resolveMediaCandidateItem(
  resolver: MediaResolver,
  kind: MediaCandidateKind,
  mode: MediaCandidateMode,
  item: MediaCandidateResolveItem,
  limit: number,
  options: Partial<SearchOptions> = {},
): MediaCandidateResolveItemResponse {
  const searchOptions: SearchOptions = {
    sources: options.sources ?? DEFAULT_BUILT_IN_ICON_SOURCES,
  };
  const candidates: MediaCandidateGroup = { best: null, builtIn: [], appStore: [], favicon: [] };
  let autoCandidate: MediaCandidate | null = null;

  if (mode === "auto") {
    const candidate = resolveBuiltInAutoCandidate(resolver, kind, item.name, searchOptions);
    if (candidate?.autoAssignable) {
      candidates.builtIn = [candidate];
      candidates.best = candidate;
      autoCandidate = candidate;
    }
    return { id: item.id, autoCandidate, candidates };
  }

  // 搜索模式为 favicon 预留预算，避免多 provider/variants 把弱备用候选挤出；自动分配仍只返回内置高置信候选。
  const builtInLimit = searchBuiltInCandidateLimit(resolver, limit);
  const builtInSearch = searchBuiltInCandidates(resolver, kind, item.name, builtInLimit, searchOptions);
  candidates.builtIn = builtInSearch.candidates;
  const remaining = limit - candidates.builtIn.length;
  if (remaining > 0) {
    // 内置 provider 的降词命中词是 resolver 对“品牌名”的最佳判断；favicon 备用沿用它，避免长套餐名生成噪声域名。
    candidates.favicon = generateFaviconCandidates(resolver, kind, builtInSearch.matchedQuery ?? item.name, item.website ?? "", remaining);
  }
  candidates.best = bestMediaCandidate(candidates);
  return { id: item.id, autoCandidate, candidates };
}

/** 将用户传入 limit 收敛到配置边界，避免候选搜索成为无界 CPU/响应体开销。 */
export function clampMediaCandidateLimit(config: MediaResolverConfig, value: number | undefined): number {
  return clamp(value ?? config.limits.defaultCandidates, 1, config.limits.maxCandidates);
}

/** 候选优先级固定为内置图标优先，再用 App Store 在线结果，最后落到 favicon 备用。 */
export function bestMediaCandidate(group: MediaCandidateGroup): MediaCandidate | null {
  return group.builtIn[0] ?? group.appStore[0] ?? group.favicon[0] ?? null;
}

function searchBuiltInCandidateLimit(resolver: MediaResolver, limit: number): number {
  const reserve = Math.min(resolver.config.candidateGroups.searchFaviconReserve, Math.max(0, limit - 1));
  return Math.max(1, limit - reserve);
}

export function resolveBuiltInAutoCandidate(
  resolver: MediaResolver,
  kind: MediaCandidateKind,
  name: string,
  options: Partial<SearchOptions> = {},
): MediaCandidate | null {
  const searchOptions: SearchOptions = {
    sources: options.sources ?? DEFAULT_BUILT_IN_ICON_SOURCES,
  };
  const queries = reducedMediaQueries(resolver, name);
  for (let index = 0; index < queries.length; index += 1) {
    const candidates = exactBuiltInCandidate(resolver, kind, queries[index] ?? "", index, "auto", searchOptions);
    if (candidates?.[0]) return candidates[0];
  }
  return null;
}

function searchBuiltInCandidates(
  resolver: MediaResolver,
  kind: MediaCandidateKind,
  query: string,
  limit: number,
  options: SearchOptions,
): BuiltInSearchResult {
  const queries = reducedMediaQueries(resolver, query);
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const normalized = queries[queryIndex] ?? "";
    const preferred = exactBuiltInCandidate(resolver, kind, normalized, queryIndex, "search", options);
    // 用户主动搜索允许降词后继续 fuzzy，但过短尾词会把 No/AI 之类泛词搜成噪声候选。
    if (queryIndex > 0 && compactMediaTerm(normalized).length < resolver.config.search.minReducedQueryLength) break;
    const candidates = searchBuiltInCandidatesForQuery(resolver, kind, normalized, limit, preferred, options);
    if (candidates.length > 0) return { candidates, matchedQuery: normalized };
  }
  return { candidates: [], matchedQuery: null };
}

function searchBuiltInCandidatesForQuery(
  resolver: MediaResolver,
  kind: MediaCandidateKind,
  normalized: string,
  limit: number,
  preferred: MediaCandidate[] | null,
  options: SearchOptions,
): MediaCandidate[] {
  if (!normalized || limit <= 0) return [];
  const candidates: MediaCandidate[] = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: MediaCandidate) => {
    if (seen.has(candidate.id) || candidates.length >= limit) return;
    seen.add(candidate.id);
    candidates.push({ ...candidate, rank: candidates.length });
  };

  for (const candidate of preferred ?? []) pushCandidate(candidate);
  for (const item of resolver.icons
    .map((entry, index) => ({ entry, index, score: scoreBuiltInIcon(resolver, entry, normalized) }))
    .filter((item) => item.score >= resolver.config.scores.mediumThreshold && providerEnabled(options.sources, item.entry.provider))
    .sort((left, right) => left.entry.providerRank - right.entry.providerRank || right.score - left.score || compareMediaTitle(left.entry.title, right.entry.title))
  ) {
    const confidence = confidenceFromScore(resolver, item.score);
    for (const candidate of toBuiltInCandidates(resolver, item.entry, kind, confidence, confidence === "exact" || confidence === "strong", normalized, candidates.length, "search", options)) {
      pushCandidate(candidate);
      if (candidates.length >= limit) break;
    }
    if (candidates.length >= limit) break;
  }
  return candidates;
}

export function generateFaviconCandidates(
  resolver: MediaResolver,
  kind: MediaCandidateKind,
  name: string,
  website: string,
  limit: number,
): MediaCandidate[] {
  // favicon 候选只生成确定性 URL，不在后端抓取页面或图片；浏览器展示阶段自行决定是否加载成功。
  if (limit <= 0) return [];
  const tlds = resolver.config.favicon.fallbackTlds[kind];
  const domains = candidateDomains(resolver, name, website, tlds).slice(0, resolver.config.limits.maxCandidateDomains);
  const candidates: MediaCandidate[] = [];
  for (const item of domains) {
    // 用户显式提供的域名可多试几个标准静态路径；推断域名保持低预算，避免弱候选挤占搜索结果。
    const providers = item.direct ? resolver.config.favicon.explicitProviders : resolver.config.favicon.providers;
    for (const candidate of faviconCandidatesForDomain(resolver, kind, item.domain, providers, candidates.length)) {
      candidates.push(candidate);
      if (candidates.length >= limit) return candidates;
    }
  }
  return candidates;
}

/** 搜索 term 归一化要同时服务拉丁字符、中文和 provider slug，不绑定 UI locale。 */
export function normalizeMediaTerm(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function compactMediaTerm(value: string): string {
  return normalizeMediaTerm(value).replace(/\s+/g, "");
}

/** 降词只删除套餐/修饰词尾部，保证“Netflix Premium”能回到品牌，但不会把短泛词当候选。 */
export function reducedMediaQueries(resolver: MediaResolver, name: string): string[] {
  const tokens = normalizeMediaTerm(name).split(/\s+/).filter(Boolean);
  const queries: string[] = [];
  const seen = new Set<string>();
  for (let length = tokens.length; length > 0; length -= 1) {
    const query = tokens.slice(0, length).join(" ");
    if (!query || isPlanOnlyQuery(resolver, query) || seen.has(query)) continue;
    seen.add(query);
    queries.push(query);
  }
  return queries;
}

function exactBuiltInCandidate(
  resolver: MediaResolver,
  kind: MediaCandidateKind,
  query: string,
  queryIndex: number,
  mode: "auto" | "search",
  options: SearchOptions,
): MediaCandidate[] | null {
  const normalized = normalizeMediaTerm(query);
  if (!normalized || isPlanOnlyQuery(resolver, normalized)) return null;
  const keys = unique([normalized, compactMediaTerm(normalized)]);
  const matches: ExactBuiltInMatch[] = [];
  for (const key of keys) {
    matches.push(...(resolver.canonicalExact.get(key) ?? []).map((index) => ({ index, baseConfidence: "exact" as const })));
  }
  for (const key of keys) {
    matches.push(...(resolver.tokenExact.get(key) ?? []).map((index) => ({ index, baseConfidence: "strong" as const })));
  }
  return candidateForExactMatches(resolver, kind, matches, normalized, queryIndex, mode, options);
}

function candidateForExactMatches(
  resolver: MediaResolver,
  kind: MediaCandidateKind,
  matches: ExactBuiltInMatch[],
  matchedQuery: string,
  queryIndex: number,
  mode: "auto" | "search",
  options: SearchOptions,
): MediaCandidate[] | null {
  const strongestByIndex = new Map<number, ExactBuiltInMatch["baseConfidence"]>();
  for (const match of matches) {
    const current = strongestByIndex.get(match.index);
    if (!current || match.baseConfidence === "exact") {
      strongestByIndex.set(match.index, match.baseConfidence);
    }
  }
  const enabled = [...strongestByIndex]
    .flatMap(([index, baseConfidence]) => {
      const entry = resolver.icons[index];
      return entry && providerEnabled(options.sources, entry.provider) ? [{ entry, baseConfidence }] : [];
    })
    .sort((left, right) => left.entry.providerRank - right.entry.providerRank || confidenceRank(left.baseConfidence) - confidenceRank(right.baseConfidence) || compareMediaTitle(left.entry.title, right.entry.title));
  if (enabled.length === 0) return null;
  const match = enabled[0];
  if (!match) return null;
  const confidence = queryIndex > 0 || match.baseConfidence === "strong" ? "strong" : "exact";
  return toBuiltInCandidates(resolver, match.entry, kind, confidence, true, matchedQuery, 0, mode, options);
}

function toBuiltInCandidates(
  resolver: MediaResolver,
  entry: ResolverIcon,
  kind: MediaCandidateKind,
  confidence: MediaCandidateConfidence,
  autoAssignable: boolean,
  matchedQuery: string,
  rank: number,
  mode: "auto" | "search",
  options: SearchOptions,
): MediaCandidate[] {
  const provider = entry.provider;
  const variants = mode === "auto" || !options.sources[provider].variantsEnabled
    ? preferredBuiltInVariants(resolver, entry).slice(0, 1)
    : preferredBuiltInVariants(resolver, entry);
  // 自动分配必须保持稳定首选图标；手动搜索才按设置展开上游变体供用户挑选。
  return variants.map((variant): MediaCandidate => ({
    id: `builtin:${provider}:${entry.slug}:${variant.name}`,
    kind,
    source: "builtIn",
    provider,
    label: entry.title,
    variant: variant.name,
    url: builtInVariantURL(resolver, provider, variant),
    confidence,
    autoAssignable,
    matchedQuery,
    rank,
  }));
}

function preferredBuiltInVariants(resolver: MediaResolver, icon: Pick<ResolverIcon, "provider" | "variants">): BuiltInIconVariant[] {
  const preferredNames = resolver.preferredVariants.get(icon.provider) ?? [];
  const byName = new Map(icon.variants.map((variant) => [variant.name, variant]));
  const preferred = preferredNames.flatMap((name) => {
    const variant = byName.get(name);
    return variant ? [variant] : [];
  });
  const rest = icon.variants.filter((variant) => !preferredNames.includes(variant.name));
  return [...preferred, ...rest];
}

function builtInVariantURL(resolver: MediaResolver, provider: BuiltInIconProvider, variant: BuiltInIconVariant): string {
  const base = resolver.providerCdnBase.get(provider);
  return `${base}${variant.path}`;
}

function providerEnabled(settings: BuiltInIconSourceSettings, provider: BuiltInIconProvider): boolean {
  return settings[provider].enabled;
}

function faviconCandidatesForDomain(
  resolver: MediaResolver,
  kind: MediaCandidateKind,
  domain: string,
  providers: readonly FaviconProviderConfig[],
  rankOffset: number,
): MediaCandidate[] {
  return providers.map((item, index): MediaCandidate => {
    const rank = rankOffset + index;
    return {
      id: `favicon:${item.provider}:${domain}:${rank}`,
      kind,
      source: "favicon",
      provider: item.provider,
      label: domain,
      variant: null,
      url: item.urlTemplate.replace(/\{domain\}/g, domain),
      confidence: "weak",
      autoAssignable: false,
      matchedQuery: domain,
      rank,
    };
  });
}

function candidateDomains(resolver: MediaResolver, query: string, website: string, tlds: readonly string[]): FaviconCandidateDomain[] {
  const domains: FaviconCandidateDomain[] = [];
  const explicit = extractDomain(query);
  if (explicit) domains.push({ domain: explicit, direct: true });
  const websiteDomain = extractDomain(website);
  if (websiteDomain) domains.push({ domain: websiteDomain, direct: true });
  const queries = faviconMediaQueries(resolver, query);
  for (const reduced of queries) {
    const keyword = compactMediaTerm(reduced);
    if (!usableReducedKeyword(resolver, keyword)) continue;
    const known = resolver.config.favicon.knownDomains[keyword];
    if (known) domains.push({ domain: known, direct: false });
  }
  for (const reduced of queries) {
    const keyword = compactMediaTerm(reduced);
    if (!usableReducedKeyword(resolver, keyword)) continue;
    for (const tld of tlds) domains.push({ domain: `${keyword}.${tld}`, direct: false });
  }
  return normalizeCandidateDomains(domains);
}

function normalizeCandidateDomains(domains: readonly FaviconCandidateDomain[]): FaviconCandidateDomain[] {
  const out: FaviconCandidateDomain[] = [];
  const seen = new Set<string>();
  const pushDomain = (domain: string, direct: boolean) => {
    const normalized = domain.toLowerCase().trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ domain: normalized, direct });
  };

  for (const item of domains) {
    const normalized = item.domain.toLowerCase().trim();
    if (!normalized) continue;
    pushDomain(normalized, item.direct);
    const parts = normalized.split(".");
    if (parts.length === 2 && !normalized.startsWith("www.")) pushDomain(`www.${normalized}`, item.direct);
  }
  return out;
}

function extractDomain(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return null;
    }
  }
  const host = trimmed.split("/")[0]?.toLowerCase() ?? "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

function scoreBuiltInIcon(resolver: MediaResolver, entry: ResolverIcon, query: string): number {
  const compactQuery = compactMediaTerm(query);
  const parts = query.split(/\s+/).filter(Boolean);
  const scores = resolver.config.scores;
  let best = 0;
  for (const value of entry.terms) {
    const compactValue = compactMediaTerm(value);
    if (value === query || compactValue === compactQuery) best = Math.max(best, scores.exact);
    else if (value.startsWith(query) || compactValue.startsWith(compactQuery)) best = Math.max(best, scores.prefix);
    else if (value.includes(query) || compactValue.includes(compactQuery)) best = Math.max(best, scores.contains);
    else if (parts.length > 1 && parts.every((part) => value.includes(part))) best = Math.max(best, scores.allParts);
    else if (compactQuery.length >= 4 && isSubsequence(compactQuery, compactValue)) best = Math.max(best, scores.subsequence);
  }
  if (best === 0) return 0;
  if (normalizeMediaTerm(entry.slug) === query || normalizeMediaTerm(entry.title) === query) return best + scores.slugExactBoost;
  if (normalizeMediaTerm(entry.slug).startsWith(query)) return best + scores.slugPrefixBoost;
  return best;
}

function confidenceFromScore(resolver: MediaResolver, score: number): MediaCandidateConfidence {
  if (score >= resolver.config.scores.exact) return "exact";
  if (score >= resolver.config.scores.strongThreshold) return "strong";
  if (score >= resolver.config.scores.mediumThreshold) return "medium";
  return "weak";
}

function normalizedTerms(values: readonly string[]): string[] {
  return unique(values.map(normalizeMediaTerm).filter(Boolean));
}

function compactTerms(values: readonly string[]): string[] {
  return unique(values.map(compactMediaTerm).filter(Boolean));
}

function tokenKeys(values: readonly string[], planSuffixWords: ReadonlySet<string>): string[] {
  return unique(normalizedTerms(values).flatMap((value) => value.split(/\s+/)).filter((token) => token.length >= 3 && !planSuffixWords.has(token)));
}

function remapRecordToNumberMap(record: Record<string, number[]>, indexMap: ReadonlyMap<number, number>): Map<string, number[]> {
  return new Map(Object.entries(record).flatMap(([key, values]) => {
    const mapped = values.flatMap((value) => {
      const index = indexMap.get(value);
      return index === undefined ? [] : [index];
    });
    return mapped.length > 0 ? [[key, mapped] as const] : [];
  }));
}

function isPlanOnlyQuery(resolver: MediaResolver, query: string): boolean {
  const tokens = normalizeMediaTerm(query).split(/\s+/).filter(Boolean);
  return tokens.length === 0 || tokens.every((token) => resolver.planSuffixWords.has(token));
}

function faviconMediaQueries(resolver: MediaResolver, query: string): string[] {
  const queries = reducedMediaQueries(resolver, query);
  const tokens = normalizeMediaTerm(query).split(/\s+/).filter(Boolean);
  if (tokens.length <= 1 || !resolver.searchModifierSuffixWords.has(tokens[tokens.length - 1] ?? "")) return queries;

  let brandLength = tokens.length;
  while (brandLength > 1 && resolver.searchModifierSuffixWords.has(tokens[brandLength - 1] ?? "")) {
    brandLength -= 1;
  }
  return unique([
    tokens.slice(0, brandLength).join(" "),
    ...queries,
  ]);
}

function usableReducedKeyword(resolver: MediaResolver, keyword: string): boolean {
  return keyword.length >= resolver.config.search.minReducedQueryLength;
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

function compareMediaTitle(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function confidenceRank(confidence: ExactBuiltInMatch["baseConfidence"]): number {
  return confidence === "exact" ? 0 : 1;
}

function appendRecordValue(record: Record<string, number[]>, key: string, value: number) {
  record[key] ??= [];
  record[key].push(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
