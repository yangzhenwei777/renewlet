import { z } from "zod";
import { RENEWLET_EXPORT_SCHEMA_VERSION } from "./import-export";
import {
  UPSTREAM_RAW_RESPONSE_TEXT_MAX_CHARS,
  upstreamErrorDetailsSchema,
} from "./upstream";
import { apiSuccessResponseSchema } from "./api";
import { okPayloadSchema, okResponseSchema } from "./common";

export const CLOUD_BACKUP_DEFAULT_RETENTION = 7;
export const CLOUD_BACKUP_MAX_RETENTION = 30;
export const CLOUD_BACKUP_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const CLOUD_BACKUP_RAW_RESPONSE_TEXT_MAX_CHARS = UPSTREAM_RAW_RESPONSE_TEXT_MAX_CHARS;
export const CLOUD_BACKUP_DEFAULT_SCHEDULE_TIME = "03:00";
export const CLOUD_BACKUP_DEFAULT_SCHEDULE_WEEKDAY = "monday";

const cloudBackupDefaultPolicy = {
  scheduleEnabled: false,
  scheduleFrequency: "daily" as const,
  scheduleTime: CLOUD_BACKUP_DEFAULT_SCHEDULE_TIME,
  scheduleWeekday: CLOUD_BACKUP_DEFAULT_SCHEDULE_WEEKDAY,
  retention: CLOUD_BACKUP_DEFAULT_RETENTION,
} as const;

const cloudBackupDefaultTargetStatus = {
  lastBackupAt: null,
  lastStatus: "idle" as const,
  lastError: null,
  updatedAt: null,
} as const;
const cloudBackupDefaultRemotePrefix = "renewlet";

export const cloudBackupProviderSchema = z.enum(["webdav", "s3"]);
export type CloudBackupProvider = z.infer<typeof cloudBackupProviderSchema>;

export const cloudBackupScheduleFrequencySchema = z.enum(["daily", "weekly"]);
export type CloudBackupScheduleFrequency = z.infer<typeof cloudBackupScheduleFrequencySchema>;

export const cloudBackupScheduleWeekdaySchema = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
export type CloudBackupScheduleWeekday = z.infer<typeof cloudBackupScheduleWeekdaySchema>;

export const cloudBackupScheduleTimeSchema = z.string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export type CloudBackupScheduleTime = z.infer<typeof cloudBackupScheduleTimeSchema>;

const pathPrefixSchema = z.string()
  .trim()
  .max(512)
  .refine((value) => !value.includes(".."), "Path must not contain parent directory segments")
  // Docker Go 和 Worker 都把空远端目录落回默认前缀；否则两个运行面对根目录 MKCOL/PROPFIND 的 SDK 行为会漂移。
  .transform((value) => value.replace(/^\/+|\/+$/g, "") || cloudBackupDefaultRemotePrefix);

export const cloudBackupWebDavConfigSchema = z.object({
  url: z.string().trim().url().refine((value) => value.startsWith("https://"), "WebDAV URL must use HTTPS"),
  username: z.string().trim().max(256).optional().default(""),
  path: pathPrefixSchema.optional().default(cloudBackupDefaultRemotePrefix),
}).strict();
export type CloudBackupWebDavConfig = z.infer<typeof cloudBackupWebDavConfigSchema>;

const cloudBackupS3ConfigObjectSchema = z.object({
  endpoint: z.string().trim().url().refine((value) => value.startsWith("https://"), "S3 endpoint must use HTTPS"),
  // SigV4 的 credential scope 包含 signing region；S3-compatible endpoint 没有通用 discovery 标准，不能再静默猜默认值。
  region: z.string().trim().min(1, "S3 signing region is required").max(64),
  bucket: z.string().trim().min(1).max(128),
  prefix: pathPrefixSchema.optional().default(cloudBackupDefaultRemotePrefix),
  accessKeyId: z.string().trim().max(256).optional().default(""),
}).strict();

export const cloudBackupS3ConfigSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  // 旧版本把 S3 addressingStyle 暴露给用户保存；现在寻址由后端按 endpoint 自动判断，边界处剥离可让旧配置在下一次保存后自然清理。
  const { addressingStyle: _addressingStyle, ...clean } = value as Record<string, unknown>;
  return clean;
}, cloudBackupS3ConfigObjectSchema);
export type CloudBackupS3Config = z.infer<typeof cloudBackupS3ConfigSchema>;

export const cloudBackupPolicySchema = z.object({
  scheduleEnabled: z.boolean().default(false),
  scheduleFrequency: cloudBackupScheduleFrequencySchema.default("daily"),
  scheduleTime: cloudBackupScheduleTimeSchema.default(CLOUD_BACKUP_DEFAULT_SCHEDULE_TIME),
  scheduleWeekday: cloudBackupScheduleWeekdaySchema.default(CLOUD_BACKUP_DEFAULT_SCHEDULE_WEEKDAY),
  retention: z.number().int().min(1).max(CLOUD_BACKUP_MAX_RETENTION).default(CLOUD_BACKUP_DEFAULT_RETENTION),
}).strict();
export type CloudBackupPolicy = z.infer<typeof cloudBackupPolicySchema>;

export const cloudBackupProviderPolicyMapSchema = z.object({
  webdav: cloudBackupPolicySchema.default(cloudBackupDefaultPolicy),
  s3: cloudBackupPolicySchema.default(cloudBackupDefaultPolicy),
}).strict().default({ webdav: cloudBackupDefaultPolicy, s3: cloudBackupDefaultPolicy });
export type CloudBackupProviderPolicyMap = z.infer<typeof cloudBackupProviderPolicyMapSchema>;

// WebDAV/S3 策略和状态是 user+provider 维度；shared schema 是 Docker、Worker 和前端防串目标的共同契约。
export const cloudBackupTargetStatusSchema = z.object({
  lastBackupAt: z.string().nullable().default(null),
  lastStatus: z.enum(["idle", "success", "failed"]).default("idle"),
  lastError: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
}).strict();
export type CloudBackupTargetStatus = z.infer<typeof cloudBackupTargetStatusSchema>;

export const cloudBackupProviderStatusMapSchema = z.object({
  webdav: cloudBackupTargetStatusSchema.default(cloudBackupDefaultTargetStatus),
  s3: cloudBackupTargetStatusSchema.default(cloudBackupDefaultTargetStatus),
}).strict().default({ webdav: cloudBackupDefaultTargetStatus, s3: cloudBackupDefaultTargetStatus });
export type CloudBackupProviderStatusMap = z.infer<typeof cloudBackupProviderStatusMapSchema>;

export const cloudBackupConfigSchema = z.object({
  provider: cloudBackupProviderSchema,
  webdav: cloudBackupWebDavConfigSchema.optional(),
  s3: cloudBackupS3ConfigSchema.optional(),
  // 云存储 secret 是 write-only；响应只能暴露 credentialSet，不能把 WebDAV/S3 密钥回传到浏览器。
  credentialSet: z.boolean().default(false),
  credentialSetByProvider: z.object({
    webdav: z.boolean().default(false),
    s3: z.boolean().default(false),
  }).strict().default({ webdav: false, s3: false }),
  policyByProvider: cloudBackupProviderPolicyMapSchema,
  statusByProvider: cloudBackupProviderStatusMapSchema,
  updatedAt: z.string().nullable().default(null),
}).strict();
export type CloudBackupConfig = z.infer<typeof cloudBackupConfigSchema>;

export const cloudBackupCredentialUpdateSchema = z.object({
  webdavPassword: z.string().max(4096).optional(),
  s3SecretAccessKey: z.string().max(4096).optional(),
}).strict();
export type CloudBackupCredentialUpdate = z.infer<typeof cloudBackupCredentialUpdateSchema>;

export const cloudBackupConfigUpdateSchema = z.object({
  provider: cloudBackupProviderSchema,
  webdav: cloudBackupWebDavConfigSchema.optional(),
  s3: cloudBackupS3ConfigSchema.optional(),
  credentials: cloudBackupCredentialUpdateSchema.optional(),
  policy: cloudBackupPolicySchema,
}).strict().superRefine((value, ctx) => {
  if (value.provider === "webdav" && !value.webdav) {
    ctx.addIssue({
      code: "custom",
      path: ["webdav"],
      message: "WebDAV config is required",
    });
  }
  if (value.provider === "s3" && !value.s3) {
    ctx.addIssue({
      code: "custom",
      path: ["s3"],
      message: "S3 config is required",
    });
  }
});
export type CloudBackupConfigUpdate = z.infer<typeof cloudBackupConfigUpdateSchema>;

export const cloudBackupConfigPayloadSchema = z.object({
  config: cloudBackupConfigSchema,
}).strict();
export const cloudBackupConfigResponseSchema = apiSuccessResponseSchema(cloudBackupConfigPayloadSchema);
export type CloudBackupConfigResponse = z.infer<typeof cloudBackupConfigPayloadSchema>;

export const cloudBackupTestRequestSchema = cloudBackupConfigUpdateSchema;
export type CloudBackupTestRequest = z.infer<typeof cloudBackupTestRequestSchema>;

export const cloudBackupTestPayloadSchema = z.object({
  checkedAt: z.string(),
  message: z.string().optional(),
}).strict();
export const cloudBackupTestResponseSchema = apiSuccessResponseSchema(cloudBackupTestPayloadSchema);
export type CloudBackupTestResponse = z.infer<typeof cloudBackupTestPayloadSchema>;

export const cloudBackupSnapshotManifestSchema = z.object({
  kind: z.literal("renewlet-cloud-backup-snapshot"),
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  filename: z.string().min(1),
  createdAt: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  exportKind: z.literal("renewlet-export"),
  exportSchemaVersion: z.literal(RENEWLET_EXPORT_SCHEMA_VERSION),
}).strict();
export type CloudBackupSnapshotManifest = z.infer<typeof cloudBackupSnapshotManifestSchema>;

export const cloudBackupSnapshotSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  provider: cloudBackupProviderSchema,
  createdAt: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CloudBackupSnapshot = z.infer<typeof cloudBackupSnapshotSchema>;

export const cloudBackupSnapshotsPayloadSchema = z.object({
  snapshots: z.array(cloudBackupSnapshotSchema),
}).strict();
export const cloudBackupSnapshotsResponseSchema = apiSuccessResponseSchema(cloudBackupSnapshotsPayloadSchema);
export type CloudBackupSnapshotsResponse = z.infer<typeof cloudBackupSnapshotsPayloadSchema>;

export const cloudBackupCreateSnapshotRequestSchema = z.object({
  provider: cloudBackupProviderSchema,
}).strict();
export type CloudBackupCreateSnapshotRequest = z.infer<typeof cloudBackupCreateSnapshotRequestSchema>;

export const cloudBackupCreateSnapshotPayloadSchema = z.object({
  snapshots: z.array(cloudBackupSnapshotSchema).min(1),
}).strict();
export const cloudBackupCreateSnapshotResponseSchema = apiSuccessResponseSchema(cloudBackupCreateSnapshotPayloadSchema);
export type CloudBackupCreateSnapshotResponse = z.infer<typeof cloudBackupCreateSnapshotPayloadSchema>;

export const cloudBackupDeleteSnapshotResponseSchema = okResponseSchema;
export type CloudBackupDeleteSnapshotResponse = z.infer<typeof okPayloadSchema>;

export const cloudBackupErrorDetailsSchema = upstreamErrorDetailsSchema;
export type CloudBackupErrorDetails = z.infer<typeof cloudBackupErrorDetailsSchema>;
