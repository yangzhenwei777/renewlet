import { uploadImagePayloadSchema, uploadKindSchema, uploadedAssetsPageSchema } from "@renewlet/shared/schemas/media";
import { countAssetReferences, deleteAssetMetadata, getAsset, listAssets, newId, nowIso } from "./db";
import { HttpError, ok, requestLocale, successJson } from "./http";
import { serverText } from "./server-i18n";
import { requireAuth } from "./auth";
import type { AssetRow, Env } from "./types";

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_FORM_BYTES = MAX_ASSET_BYTES + 64 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"]);

/**
 * uploadAsset 接收当前用户上传的 Logo/Icon 私有资产。
 *
 * R2 只负责对象存储，D1 asset metadata 才是 owner、类型和可读取路径的权限事实来源。
 */
export async function uploadAsset(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  assertAssetUploadContentLength(request, locale);
  const form = await request.formData();
  const kind = uploadKindSchema.parse(form.get("kind"));
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, serverText(locale, "asset.uploadChooseImage"));
  if (file.size <= 0 || file.size > MAX_ASSET_BYTES) {
    throw new HttpError(400, serverText(locale, "asset.invalidImageSize"));
  }
  const contentType = normalizeContentType(file.type, file.name);
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new HttpError(400, serverText(locale, "asset.invalidImageType"));
  }

  // R2 key 带 userId，不靠文件名隔离；D1 元数据仍是权限判断的真相来源。
  const timestamp = nowIso();
  const id = newId("ast");
  const key = `${auth.user.id}/${kind}/${id}/${sanitizeFilename(file.name)}`;
  // R2 先落对象再写 metadata；若 D1 写入失败会留下不可枚举孤儿，但不会越权暴露给用户。
  await env.ASSETS_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType },
    customMetadata: { userId: auth.user.id, kind },
  });
  await env.DB.prepare(`
    INSERT INTO assets (id, user_id, kind, r2_key, original_name, mime_type, size_bytes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, auth.user.id, kind, key, file.name, contentType, file.size, timestamp, timestamp).run();

  return successJson(uploadImagePayloadSchema.parse({ url: `/api/app/assets/${id}` }), { status: 201 });
}

function assertAssetUploadContentLength(request: Request, locale: ReturnType<typeof requestLocale>): void {
  const raw = request.headers.get("content-length");
  if (!raw) return;
  const contentLength = Number(raw.trim());
  if (!Number.isFinite(contentLength)) return;
  // multipart envelope 允许少量表单开销；真正的文件大小仍由 File.size 校验，避免 header 缺失时误拒正常上传。
  if (contentLength > MAX_ASSET_FORM_BYTES) {
    throw new HttpError(400, serverText(locale, "asset.invalidImageSize"));
  }
}

/**
 * readAsset 通过受控 API 返回当前用户的私有资产。
 *
 * 读取顺序必须先校验 D1 owner 再访问 R2，不能把 R2 key 或公开 URL 暴露成绕过登录态的图片入口。
 */
export async function readAsset(request: Request, env: Env, id: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  // 先按 owner 查 D1，再取 R2；不能让可猜测的 R2 key 绕过私有资产语义。
  const row = await getAsset(env, auth.user.id, id);
  if (!row) throw new HttpError(404, serverText(locale, "asset.missing"));
  const object = await env.ASSETS_BUCKET.get(row.r2_key);
  if (!object) throw new HttpError(404, serverText(locale, "asset.fileMissing"));

  const contentType = row.mime_type || object.httpMetadata?.contentType || "application/octet-stream";
  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("cache-control", "private, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  if (contentType.split(";")[0]?.trim().toLowerCase() === "image/svg+xml") {
    // 用户上传 SVG 允许保留矢量展示，但必须压成无脚本沙箱，避免 Logo 变成 XSS 入口。
    headers.set("content-security-policy", "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; sandbox");
  }
  if (row.size_bytes !== null) headers.set("content-length", String(row.size_bytes));
  return new Response(object.body, { headers });
}

/**
 * listUploadedAssets 分页列出当前用户可复用的上传资产。
 *
 * Logo 选择器会频繁打开该接口，分页和 perPage 上限保护 D1 查询成本，也避免跨用户资产枚举。
 */
export async function listUploadedAssets(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") === "icon" ? "icon" : "logo";
  const page = positiveInt(url.searchParams.get("page"), 1);
  // perPage 上限保护 D1/R2 列表页，不让 Logo 选择器变成无界资产枚举接口。
  const perPage = clamp(positiveInt(url.searchParams.get("perPage"), 48), 1, 96);
  const result = await listAssets(env, auth.user.id, kind, page, perPage);
  return successJson(uploadedAssetsPageSchema.parse({
    items: result.items.map(toAssetItem),
    page,
    totalPages: Math.ceil(result.total / perPage),
  }));
}

/**
 * deleteAsset 是 R2 私有资产的删除边界。
 *
 * 先按 owner 查 D1，再做引用计数，最后删除 R2+metadata；`ASSET_IN_USE` 防止删除动作静默改写订阅或支付方式配置。
 */
export async function deleteAsset(request: Request, env: Env, id: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const row = await getAsset(env, auth.user.id, id);
  if (!row) throw new HttpError(404, serverText(locale, "asset.missing"), "NOT_FOUND");

  const usage = await countAssetReferences(env, auth.user.id, id);
  if (usage.usageCount > 0) {
    // 订阅 Logo 与支付方式图标都是私有资产持久引用；删除只阻止，不替用户改业务配置。
    throw new HttpError(409, serverText(locale, "asset.inUse"), "ASSET_IN_USE", usage);
  }

  // R2 delete 对缺失对象是幂等的；metadata 最后删除，保证失败重试仍能通过 owner 索引定位孤儿对象。
  await env.ASSETS_BUCKET.delete(row.r2_key);
  await deleteAssetMetadata(env, auth.user.id, id);
  return ok();
}

function toAssetItem(row: AssetRow) {
  return {
    id: row.id,
    url: `/api/app/assets/${row.id}`,
    kind: row.kind,
    ...(row.original_name ? { originalName: row.original_name } : {}),
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
    created: row.created_at,
    updated: row.updated_at,
  };
}

function normalizeContentType(type: string, name: string): string {
  const lower = type.toLowerCase().trim();
  if (lower) return lower === "image/vnd.microsoft.icon" ? "image/x-icon" : lower;
  // 部分浏览器/移动端相册不给 File.type；这里按扩展名只做体验兜底，安全白名单仍在上层执行。
  const filename = name.toLowerCase();
  if (filename.endsWith(".svg")) return "image/svg+xml";
  if (filename.endsWith(".ico")) return "image/x-icon";
  if (filename.endsWith(".webp")) return "image/webp";
  if (filename.endsWith(".gif")) return "image/gif";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}

function sanitizeFilename(name: string): string {
  const cleaned = name.trim().replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "upload.bin";
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
