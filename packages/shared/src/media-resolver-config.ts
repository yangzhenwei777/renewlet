/**
 * 媒体候选 resolver 配置由 JSON 数据驱动。
 *
 * 图标 provider、CDN、预算、降词和限流都必须在这里收敛，避免前端、Go embedded static 和 Worker 各自排序。
 */
import { z } from "zod";
import { BUILT_IN_ICON_PROVIDERS } from "./built-in-icons";
import mediaResolverConfigJson from "../data/media-resolver-config.json";

const mediaResolverConfigSchema = z.object({
  builtInProviders: z.array(z.object({
    provider: z.enum(BUILT_IN_ICON_PROVIDERS),
    cdnBase: z.string().url(),
    github: z.object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      branch: z.string().min(1),
      latestRelease: z.boolean(),
    }).strict(),
    preferredVariants: z.array(z.string().min(1)).min(1),
  }).strict()).length(BUILT_IN_ICON_PROVIDERS.length).refine((providers) => {
    const seen = new Set(providers.map((item) => item.provider));
    return BUILT_IN_ICON_PROVIDERS.every((provider) => seen.has(provider));
  }, "内置图标 provider 配置不完整"),
  auto: z.object({
    planSuffixWords: z.array(z.string().min(1)).min(1),
  }).strict(),
  search: z.object({
    minReducedQueryLength: z.number().int().positive(),
    modifierSuffixWords: z.array(z.string().min(1)).min(1),
  }).strict(),
  candidateGroups: z.object({
    searchFaviconReserve: z.number().int().positive(),
  }).strict(),
  limits: z.object({
    defaultCandidates: z.number().int().positive(),
    maxCandidates: z.number().int().positive(),
    maxItems: z.number().int().positive(),
    maxCandidateDomains: z.number().int().positive(),
  }).strict(),
  rateLimit: z.object({
    defaultMaxRequests: z.number().int().positive(),
    defaultWindowMs: z.number().int().positive(),
  }).strict(),
  scores: z.object({
    exact: z.number().positive(),
    prefix: z.number().positive(),
    contains: z.number().positive(),
    allParts: z.number().positive(),
    subsequence: z.number().positive(),
    slugExactBoost: z.number().nonnegative(),
    slugPrefixBoost: z.number().nonnegative(),
    strongThreshold: z.number().positive(),
    mediumThreshold: z.number().positive(),
  }).strict(),
  favicon: z.object({
    fallbackTlds: z.object({
      logo: z.array(z.string().min(1)).min(1),
      icon: z.array(z.string().min(1)).min(1),
    }).strict(),
    providers: z.array(z.object({
      provider: z.string().min(1),
      urlTemplate: z.string().includes("{domain}"),
    }).strict()).min(1),
    explicitProviders: z.array(z.object({
      provider: z.string().min(1),
      urlTemplate: z.string().includes("{domain}"),
    }).strict()).min(1),
    knownDomains: z.record(z.string().min(1), z.string().min(1)),
  }).strict(),
}).strict().refine((config) => config.candidateGroups.searchFaviconReserve < config.limits.maxCandidates, "favicon 预留候选数必须小于最大候选数");

// media resolver 配置是 Docker/Cloudflare/脚本共用事实源；模块加载即校验，避免某个运行面带着坏配置启动。
export const mediaResolverConfig = mediaResolverConfigSchema.parse(mediaResolverConfigJson);

export type MediaResolverConfig = typeof mediaResolverConfig;
