import { z } from "zod";
import { BUILT_IN_ICON_PROVIDERS } from "../built-in-icons";
import { apiSuccessResponseSchema } from "./api";
import { upstreamErrorDetailsSchema } from "./upstream";

export const uploadKindSchema = z.enum(["logo", "icon"]);

export const uploadImagePayloadSchema = z.object({
  url: z.string().min(1),
}).strict();
export const uploadImageResponseSchema = apiSuccessResponseSchema(uploadImagePayloadSchema);

export const uploadedAssetSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  kind: uploadKindSchema,
  originalName: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  created: z.string().min(1).optional(),
  updated: z.string().min(1).optional(),
}).strict();

export const uploadedAssetsPageSchema = z.object({
  items: z.array(uploadedAssetSchema),
  page: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
}).strict();
export const uploadedAssetsPageResponseSchema = apiSuccessResponseSchema(uploadedAssetsPageSchema);

export const assetInUseDetailsSchema = z.object({
  usageCount: z.number().int().positive(),
  subscriptionLogoCount: z.number().int().nonnegative(),
  paymentMethodIconCount: z.number().int().nonnegative(),
}).strict();

export const mediaCandidateKindSchema = uploadKindSchema;

export const mediaCandidateModeSchema = z.enum(["auto", "search"]);

export const mediaCandidateSourceSchema = z.enum(["builtIn", "appStore", "favicon"]);

export const mediaCandidateConfidenceSchema = z.enum(["exact", "strong", "medium", "weak"]);

/**
 * 候选解析输入只包含用户主动提供的名称/站点。
 *
 * 后端不会抓取用户 URL 或 HTML；favicon 候选只生成可由浏览器加载的确定性图片地址。
 */
export const mediaCandidateResolveItemSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  website: z.string().trim().max(500).optional(),
}).strict();

/**
 * Logo/Icon 候选的统一响应项。
 *
 * provider/variant 是内置图标来源设置和排序预算的契约，Docker 与 Cloudflare 必须同时提供。
 */
export const mediaCandidateSchema = z.object({
  id: z.string().min(1),
  kind: mediaCandidateKindSchema,
  source: mediaCandidateSourceSchema,
  provider: z.string().min(1),
  label: z.string().min(1),
  variant: z.string().min(1).nullable(),
  url: z.string().min(1),
  confidence: mediaCandidateConfidenceSchema,
  autoAssignable: z.boolean(),
  matchedQuery: z.string().min(1),
  rank: z.number().int().nonnegative(),
}).strict();

export const mediaCandidateGroupSchema = z.object({
  best: mediaCandidateSchema.nullable(),
  builtIn: z.array(mediaCandidateSchema),
  appStore: z.array(mediaCandidateSchema),
  favicon: z.array(mediaCandidateSchema),
}).strict();

export const mediaCandidateResolveRequestSchema = z.object({
  kind: mediaCandidateKindSchema,
  mode: mediaCandidateModeSchema,
  items: z.array(mediaCandidateResolveItemSchema).min(1).max(100),
  limit: z.number().int().positive().optional(),
}).strict();

export const mediaCandidateResolveItemResponseSchema = z.object({
  id: z.string().min(1),
  autoCandidate: mediaCandidateSchema.nullable(),
  candidates: mediaCandidateGroupSchema,
}).strict();

export const mediaCandidateResolvePayloadSchema = z.object({
  items: z.array(mediaCandidateResolveItemResponseSchema),
}).strict();
export const mediaCandidateResolveResponseSchema = apiSuccessResponseSchema(mediaCandidateResolvePayloadSchema);

export const builtInIconIndexSourceSchema = z.enum(["embedded", "runtime"]);

export const builtInIconIndexProviderCountsSchema = z.object({
  thesvg: z.number().int().nonnegative(),
  selfhst: z.number().int().nonnegative(),
  dashboardIcons: z.number().int().nonnegative(),
}).strict();

export const builtInIconProviderVersionSchema = z.object({
  sourceRef: z.string().min(1),
  displayVersion: z.string().min(1),
  commitSha: z.string().min(7).nullable(),
  commitShortSha: z.string().min(7).nullable(),
  commitDate: z.string().min(1).nullable(),
  releaseTag: z.string().min(1).nullable(),
  releasePublishedAt: z.string().min(1).nullable(),
}).strict();

export const builtInIconSeedMetadataSchema = z.object({
  hash: z.string().min(1),
  iconCount: z.number().int().nonnegative(),
  providerCounts: builtInIconIndexProviderCountsSchema,
  providers: z.object({
    thesvg: builtInIconProviderVersionSchema,
    selfhst: builtInIconProviderVersionSchema,
    dashboardIcons: builtInIconProviderVersionSchema,
  }).strict(),
}).strict();

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const builtInIconRefreshJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);

export const builtInIconRefreshJobSchema = z.object({
  id: z.string().min(1),
  provider: z.enum(BUILT_IN_ICON_PROVIDERS),
  status: builtInIconRefreshJobStatusSchema,
  queuedAt: z.string().min(1),
  startedAt: z.string().min(1).nullable(),
  finishedAt: z.string().min(1).nullable(),
  attempts: z.number().int().nonnegative(),
  error: z.string().min(1).nullable(),
  indexHash: sha256HexSchema.nullable(),
}).strict();

export const builtInIconIndexProviderStatusSchema = z.object({
  provider: z.enum(BUILT_IN_ICON_PROVIDERS),
  current: builtInIconProviderVersionSchema.nullable(),
  latest: builtInIconProviderVersionSchema.nullable(),
  iconCount: z.number().int().nonnegative(),
  checkedAt: z.string().min(1).nullable(),
  refreshedAt: z.string().min(1).nullable(),
  lastError: z.string().min(1).nullable(),
  refreshing: z.boolean(),
  updateAvailable: z.boolean(),
  job: builtInIconRefreshJobSchema.nullish(),
}).strict();

export const builtInIconIndexStatusSchema = z.object({
  source: builtInIconIndexSourceSchema,
  hash: z.string().min(1).nullable(),
  iconCount: z.number().int().nonnegative(),
  providerCounts: builtInIconIndexProviderCountsSchema,
  checkedAt: z.string().min(1).nullable(),
  updatedAt: z.string().min(1).nullable(),
  refreshing: z.boolean(),
  providers: z.array(builtInIconIndexProviderStatusSchema).length(BUILT_IN_ICON_PROVIDERS.length),
}).strict().refine(
  (value) => BUILT_IN_ICON_PROVIDERS.every((provider) => value.providerCounts[provider] >= 0),
  "invalid provider counts",
).refine(
  (value) => BUILT_IN_ICON_PROVIDERS.every((provider) => value.providers.some((item) => item.provider === provider)),
  "invalid provider status list",
);
export const builtInIconIndexStatusResponseSchema = apiSuccessResponseSchema(builtInIconIndexStatusSchema);

export const builtInIconIndexProviderCheckPayloadSchema = z.object({
  status: builtInIconIndexStatusSchema,
  provider: builtInIconIndexProviderStatusSchema,
  errorDetails: upstreamErrorDetailsSchema.optional(),
}).strict();
export const builtInIconIndexProviderCheckResponseSchema = apiSuccessResponseSchema(builtInIconIndexProviderCheckPayloadSchema);

export const builtInIconIndexProviderRefreshPayloadSchema = z.object({
  status: builtInIconIndexStatusSchema,
  provider: builtInIconIndexProviderStatusSchema,
  job: builtInIconRefreshJobSchema,
}).strict();
export const builtInIconIndexProviderRefreshResponseSchema = apiSuccessResponseSchema(builtInIconIndexProviderRefreshPayloadSchema);

export type UploadKind = z.infer<typeof uploadKindSchema>;
export type ApiUploadImageResponse = z.infer<typeof uploadImagePayloadSchema>;
export type UploadedAsset = z.infer<typeof uploadedAssetSchema>;
export type UploadedAssetsPage = z.infer<typeof uploadedAssetsPageSchema>;
export type AssetInUseDetails = z.infer<typeof assetInUseDetailsSchema>;
export type MediaCandidateKind = z.infer<typeof mediaCandidateKindSchema>;
export type MediaCandidateMode = z.infer<typeof mediaCandidateModeSchema>;
export type MediaCandidateSource = z.infer<typeof mediaCandidateSourceSchema>;
export type MediaCandidateConfidence = z.infer<typeof mediaCandidateConfidenceSchema>;
export type MediaCandidateResolveItem = z.infer<typeof mediaCandidateResolveItemSchema>;
export type MediaCandidate = z.infer<typeof mediaCandidateSchema>;
export type MediaCandidateGroup = z.infer<typeof mediaCandidateGroupSchema>;
export type MediaCandidateResolveRequest = z.infer<typeof mediaCandidateResolveRequestSchema>;
export type MediaCandidateResolveItemResponse = z.infer<typeof mediaCandidateResolveItemResponseSchema>;
export type MediaCandidateResolveResponse = z.infer<typeof mediaCandidateResolvePayloadSchema>;
export type BuiltInIconIndexSource = z.infer<typeof builtInIconIndexSourceSchema>;
export type BuiltInIconIndexProviderCounts = z.infer<typeof builtInIconIndexProviderCountsSchema>;
export type BuiltInIconProviderVersion = z.infer<typeof builtInIconProviderVersionSchema>;
export type BuiltInIconSeedMetadata = z.infer<typeof builtInIconSeedMetadataSchema>;
export type BuiltInIconRefreshJobStatus = z.infer<typeof builtInIconRefreshJobStatusSchema>;
export type BuiltInIconRefreshJob = z.infer<typeof builtInIconRefreshJobSchema>;
export type BuiltInIconIndexProviderStatus = z.infer<typeof builtInIconIndexProviderStatusSchema>;
export type BuiltInIconIndexStatus = z.infer<typeof builtInIconIndexStatusSchema>;
export type BuiltInIconIndexProviderCheckResponse = z.infer<typeof builtInIconIndexProviderCheckPayloadSchema>;
export type BuiltInIconIndexProviderRefreshResponse = z.infer<typeof builtInIconIndexProviderRefreshPayloadSchema>;
