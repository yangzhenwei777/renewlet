import type { BuiltInIcon, BuiltInIconSearchIndex, BuiltInIconVariant } from "./media-resolver";
import type { MediaResolverConfig } from "./media-resolver-config";
import { BUILT_IN_ICON_PROVIDERS, type BuiltInIconProvider } from "./built-in-icons.ts";
import type { BuiltInIconProviderVersion, BuiltInIconSeedMetadata } from "./schemas/media";

export type BuiltInIconRegistryFetcher = (url: string, label: string) => Promise<unknown>;

type ProviderConfig = MediaResolverConfig["builtInProviders"][number];
export interface BuiltInIconProviderIndexSourceRef {
  provider: BuiltInIconProvider;
  cdnBase: string;
}

interface BuildContext {
  providers: Readonly<Record<BuiltInIconProvider, ProviderConfig>>;
  planSuffixWords: ReadonlySet<string>;
  fetchJson: BuiltInIconRegistryFetcher;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function isSafePathPart(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

export function normalizeBuiltInIconTerm(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactTerm(value: unknown): string {
  return normalizeBuiltInIconTerm(value).replace(/\s+/g, "");
}

function uniqueTerms(values: readonly unknown[]): string[] {
  return [...new Set(values.map(normalizeBuiltInIconTerm).filter(Boolean))];
}

function exactKeysForIcon(icon: Pick<BuiltInIcon, "slug" | "title" | "aliases">): string[] {
  const canonical = uniqueTerms([icon.slug, icon.title, ...(icon.aliases ?? [])]);
  const compact = canonical.map(compactTerm).filter(Boolean);
  return [...new Set([...canonical, ...compact])];
}

function tokenKeysForIcon(
  icon: Pick<BuiltInIcon, "slug" | "title" | "aliases">,
  planSuffixWords: ReadonlySet<string>,
): string[] {
  const canonical = uniqueTerms([icon.slug, icon.title, ...(icon.aliases ?? [])]);
  return [...new Set(canonical
    .flatMap((term) => term.split(/\s+/))
    .filter((term) => term.length >= 3 && !planSuffixWords.has(term)))];
}

function iconRecord(input: Omit<BuiltInIcon, "terms" | "compactTerms" | "exactKeys" | "tokenKeys">, context: BuildContext): BuiltInIcon {
  return {
    ...input,
    terms: uniqueTerms([input.slug, input.title, ...(input.aliases ?? []), ...(input.categories ?? [])]),
    compactTerms: uniqueTerms([input.slug, input.title, ...(input.aliases ?? [])]).map(compactTerm).filter(Boolean),
    exactKeys: exactKeysForIcon(input),
    tokenKeys: tokenKeysForIcon(input, context.planSuffixWords),
  };
}

function optionalTheSvgMetadata(item: JsonRecord): Partial<Pick<BuiltInIcon, "hex" | "license" | "url" | "guidelines">> {
  const metadata: Partial<Pick<BuiltInIcon, "hex" | "license" | "url" | "guidelines">> = {};
  const hex = asString(item["hex"]);
  const license = asString(item["license"]);
  const url = asString(item["url"]);
  const guidelines = asString(item["guidelines"]);
  if (hex) metadata.hex = hex;
  if (license) metadata.license = license;
  if (url) metadata.url = url;
  if (guidelines) metadata.guidelines = guidelines;
  return metadata;
}

function parseTheSvgVariants(slug: string, value: unknown): BuiltInIconVariant[] {
  if (!isRecord(value)) return [];
  const variants: BuiltInIconVariant[] = [];
  for (const [variant, pathValue] of Object.entries(value)) {
    if (!isSafePathPart(variant)) continue;
    if (typeof pathValue !== "string") continue;
    const normalizedPath = pathValue.trim();
    if (!normalizedPath.endsWith(".svg")) continue;
    // 上游 registry 只提供路径事实，但仍必须锁在当前 slug 目录内，避免刷新入口把跨目录路径写入全局候选索引。
    if (!normalizedPath.startsWith(`/icons/${slug}/`)) continue;
    variants.push({ name: variant, path: `/public${normalizedPath}` });
  }
  return variants;
}

async function loadTheSvgIcons(context: BuildContext): Promise<BuiltInIcon[]> {
  const registry = await context.fetchJson(`${context.providers.thesvg.cdnBase}/src/data/icons.json`, "TheSVG registry");
  if (!Array.isArray(registry)) return [];
  const icons: BuiltInIcon[] = [];
  const seen = new Set<string>();
  for (const item of registry) {
    if (!isRecord(item)) continue;
    const slug = asString(item["slug"]);
    const title = asString(item["title"]);
    if (!slug || !title || !isSafePathPart(slug) || seen.has(slug)) continue;
    const variants = parseTheSvgVariants(slug, item["variants"]);
    if (variants.length === 0) continue;
    icons.push(iconRecord({
      provider: "thesvg",
      slug,
      title,
      aliases: asStringArray(item["aliases"]),
      categories: asStringArray(item["categories"]),
      variants,
      ...optionalTheSvgMetadata(item),
    }, context));
    seen.add(slug);
  }
  return icons;
}

function selfhstVariants(reference: string, item: JsonRecord): BuiltInIconVariant[] {
  const variants: BuiltInIconVariant[] = [];
  if (item["SVG"] === "Yes" || item["SVG"] === "Y") variants.push({ name: "default", path: `/svg/${reference}.svg` });
  if (item["Light"] === "Yes" || item["Light"] === "Y") variants.push({ name: "light", path: `/svg/${reference}-light.svg` });
  if (item["Dark"] === "Yes" || item["Dark"] === "Y") variants.push({ name: "dark", path: `/svg/${reference}-dark.svg` });
  return variants;
}

async function fetchJsonAny(context: BuildContext, urls: readonly string[], label: string): Promise<unknown> {
  const errors: string[] = [];
  const rawErrors: unknown[] = [];
  // jsDelivr 是首选 pinned registry，raw.githubusercontent.com 只做同 commit fallback；两者都失败才暴露聚合错误。
  for (const url of urls) {
    try {
      return await context.fetchJson(url, label);
    } catch (error) {
      rawErrors.push(error);
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new AggregateError(rawErrors, `${label} failed: ${errors.join("; ")}`);
}

function githubRawBase(context: BuildContext, provider: BuiltInIconProvider): string {
  const config = context.providers[provider];
  const atIndex = config.cdnBase.lastIndexOf("@");
  const ref = atIndex >= 0 ? config.cdnBase.slice(atIndex + 1) : config.github.branch;
  // fallback 必须跟 cdnBase 使用同一个 ref，避免 CDN 失败时意外读到默认分支的新 registry。
  return `https://raw.githubusercontent.com/${config.github.owner}/${config.github.repo}/${ref}`;
}

async function loadSelfhstIcons(context: BuildContext): Promise<BuiltInIcon[]> {
  const registry = await fetchJsonAny(context, [
    `${context.providers.selfhst.cdnBase}/index.json`,
    `${githubRawBase(context, "selfhst")}/index.json`,
  ], "selfh.st index");
  if (!Array.isArray(registry)) return [];
  const icons: BuiltInIcon[] = [];
  const seen = new Set<string>();
  for (const item of registry) {
    if (!isRecord(item)) continue;
    const slug = asString(item["Reference"]);
    const title = asString(item["Name"]);
    if (!slug || !title || !isSafePathPart(slug) || seen.has(slug)) continue;
    const variants = selfhstVariants(slug, item);
    if (variants.length === 0) continue;
    const tagTerms = asString(item["Tags"])?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
    const categories = [asString(item["Category"]), ...tagTerms].filter((value): value is string => Boolean(value));
    icons.push(iconRecord({
      provider: "selfhst",
      slug,
      title,
      aliases: [],
      categories,
      variants,
    }, context));
    seen.add(slug);
  }
  return icons;
}

function dashboardVariants(slug: string, item: JsonRecord, svgFiles: ReadonlySet<string>): BuiltInIconVariant[] {
  const variants: BuiltInIconVariant[] = [];
  if (svgFiles.has(`${slug}.svg`)) variants.push({ name: "default", path: `/svg/${slug}.svg` });
  const colors = item["colors"];
  if (isRecord(colors)) {
    for (const variantName of ["light", "dark"] as const) {
      const fileSlug = asString(colors[variantName]);
      if (!fileSlug || !isSafePathPart(fileSlug)) continue;
      if (svgFiles.has(`${fileSlug}.svg`)) variants.push({ name: variantName, path: `/svg/${fileSlug}.svg` });
    }
  }
  return variants;
}

function titleFromSlug(slug: string): string {
  return slug.split("-").filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

async function loadDashboardIcons(context: BuildContext): Promise<BuiltInIcon[]> {
  const [metadata, tree] = await Promise.all([
    fetchJsonAny(context, [
      `${context.providers.dashboardIcons.cdnBase}/metadata.json`,
      `${githubRawBase(context, "dashboardIcons")}/metadata.json`,
    ], "Dashboard Icons metadata"),
    fetchJsonAny(context, [
      `${context.providers.dashboardIcons.cdnBase}/tree.json`,
      `${githubRawBase(context, "dashboardIcons")}/tree.json`,
    ], "Dashboard Icons tree"),
  ]);
  if (!isRecord(metadata) || !isRecord(tree) || !Array.isArray(tree["svg"])) return [];
  const svgFiles = new Set(tree["svg"].filter((item): item is string => typeof item === "string"));
  const icons: BuiltInIcon[] = [];
  for (const [slug, item] of Object.entries(metadata)) {
    if (!isSafePathPart(slug) || !isRecord(item)) continue;
    const variants = dashboardVariants(slug, item, svgFiles);
    if (variants.length === 0) continue;
    icons.push(iconRecord({
      provider: "dashboardIcons",
      slug,
      title: titleFromSlug(slug),
      aliases: asStringArray(item["aliases"]),
      categories: asStringArray(item["categories"]),
      variants,
    }, context));
  }
  return icons;
}

function createBuildContext(
  config: MediaResolverConfig,
  fetchJson: BuiltInIconRegistryFetcher,
  sourceRef?: BuiltInIconProviderIndexSourceRef,
): BuildContext {
  const providers = Object.fromEntries(config.builtInProviders.map((item) => [item.provider, item])) as Record<BuiltInIconProvider, ProviderConfig>;
  if (sourceRef) {
    providers[sourceRef.provider] = {
      ...providers[sourceRef.provider],
      cdnBase: sourceRef.cdnBase,
    };
  }
  return {
    providers,
    planSuffixWords: new Set(config.auto.planSuffixWords),
    fetchJson,
  };
}

export async function buildBuiltInIconIndex(
  config: MediaResolverConfig,
  fetchJson: BuiltInIconRegistryFetcher,
): Promise<BuiltInIcon[]> {
  const providerIndexes = await Promise.all(BUILT_IN_ICON_PROVIDERS.map(async (provider) => [
    provider,
    await buildBuiltInIconProviderIndex(config, provider, fetchJson),
  ] as const));
  return mergeBuiltInIconProviderIndexes(Object.fromEntries(providerIndexes) as Partial<Record<BuiltInIconProvider, readonly BuiltInIcon[]>>);
}

export async function buildBuiltInIconProviderIndex(
  config: MediaResolverConfig,
  provider: BuiltInIconProvider,
  fetchJson: BuiltInIconRegistryFetcher,
  sourceRef?: BuiltInIconProviderIndexSourceRef,
): Promise<BuiltInIcon[]> {
  const context = createBuildContext(config, fetchJson, sourceRef);
  const icons = provider === "thesvg"
    ? await loadTheSvgIcons(context)
    : provider === "selfhst"
      ? await loadSelfhstIcons(context)
      : await loadDashboardIcons(context);
  if (icons.length === 0) {
    throw new Error(`${provider} built-in icon index generation produced no icons`);
  }
  return icons;
}

export function mergeBuiltInIconProviderIndexes(
  providerIndexes: Partial<Record<BuiltInIconProvider, readonly BuiltInIcon[]>>,
): BuiltInIcon[] {
  const icons = BUILT_IN_ICON_PROVIDERS.flatMap((provider) => providerIndexes[provider] ?? []);
  if (icons.length === 0) {
    throw new Error("built-in icon index generation produced no icons");
  }
  return icons;
}

export function replaceBuiltInIconProviderIndex(
  icons: readonly BuiltInIcon[],
  provider: BuiltInIconProvider,
  providerIcons: readonly BuiltInIcon[],
): BuiltInIcon[] {
  return mergeBuiltInIconProviderIndexes({
    ...Object.fromEntries(BUILT_IN_ICON_PROVIDERS.map((item) => [
      item,
      item === provider ? providerIcons : icons.filter((icon) => icon.provider === item),
    ])) as Record<BuiltInIconProvider, readonly BuiltInIcon[]>,
  });
}

export function canonicalBuiltInIconIndexJson(icons: readonly BuiltInIcon[]): string {
  return `${JSON.stringify(icons)}\n`;
}

export function createBuiltInIconSearchIndex(icons: readonly BuiltInIcon[]): BuiltInIconSearchIndex {
  const canonicalExact: Record<string, number[]> = {};
  const tokenExact: Record<string, number[]> = {};
  const entries = icons.map((icon, index) => {
    for (const key of new Set([...(icon.exactKeys ?? []), ...(icon.compactTerms ?? [])])) {
      canonicalExact[key] ??= [];
      canonicalExact[key].push(index);
    }
    for (const key of icon.tokenKeys ?? []) {
      tokenExact[key] ??= [];
      tokenExact[key].push(index);
    }
    return {
      p: icon.provider,
      s: icon.slug,
      t: icon.title,
      v: icon.variants,
      q: icon.terms ?? [],
    };
  });

  return {
    version: 1,
    entries,
    canonicalExact,
    tokenExact,
  };
}

export function mergeBuiltInIconSearchIndexes(
  providerIndexes: Partial<Record<BuiltInIconProvider, BuiltInIconSearchIndex>>,
  fallbackIndex: BuiltInIconSearchIndex,
): BuiltInIconSearchIndex {
  const entries: BuiltInIconSearchIndex["entries"] = [];
  const canonicalExact: Record<string, number[]> = {};
  const tokenExact: Record<string, number[]> = {};

  for (const provider of BUILT_IN_ICON_PROVIDERS) {
    const source = providerIndexes[provider] ?? fallbackIndex;
    const indexMap = new Map<number, number>();
    // Cloudflare R2 只存 provider 级 search index；组合时必须重映射 entry 下标，不能复用单 provider 原始索引。
    source.entries.forEach((entry, sourceIndex) => {
      if (entry.p !== provider) return;
      indexMap.set(sourceIndex, entries.length);
      entries.push(entry);
    });
    appendRebasedIndexValues(canonicalExact, source.canonicalExact, indexMap);
    appendRebasedIndexValues(tokenExact, source.tokenExact, indexMap);
  }

  return {
    version: 1,
    entries,
    canonicalExact,
    tokenExact,
  };
}

function appendRebasedIndexValues(
  output: Record<string, number[]>,
  source: Record<string, number[]>,
  indexMap: ReadonlyMap<number, number>,
): void {
  for (const [key, indexes] of Object.entries(source)) {
    for (const index of indexes) {
      const next = indexMap.get(index);
      if (next === undefined) continue;
      output[key] ??= [];
      output[key].push(next);
    }
  }
}

export function canonicalBuiltInIconSearchIndexJson(index: BuiltInIconSearchIndex): string {
  return `${JSON.stringify(index)}\n`;
}

export function createBuiltInIconSeedMetadata(
  icons: readonly Pick<BuiltInIcon, "provider">[],
  hash: string,
  providers: Record<BuiltInIconProvider, BuiltInIconProviderVersion>,
): BuiltInIconSeedMetadata {
  return {
    hash,
    iconCount: icons.length,
    providerCounts: countBuiltInIconProviders(icons),
    providers,
  };
}

export function canonicalBuiltInIconSeedMetadataJson(metadata: BuiltInIconSeedMetadata): string {
  return `${JSON.stringify(metadata)}\n`;
}

export function countBuiltInIconProviders(icons: readonly Pick<BuiltInIcon, "provider">[]): Record<BuiltInIconProvider, number> {
  return icons.reduce<Record<BuiltInIconProvider, number>>((counts, icon) => ({
    ...counts,
    [icon.provider]: counts[icon.provider] + 1,
  }), {
    thesvg: 0,
    selfhst: 0,
    dashboardIcons: 0,
  });
}
