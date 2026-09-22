/**
 * 图片上传约束（前后端共享）。
 *
 * 说明：
 * - 浏览器端先做快速失败，避免大文件进入 FileReader 占用内存。
 * - 服务端仍必须再次校验，客户端校验只能改善体验，不能作为安全边界。
 */

/** 单张上传图片大小上限；与上传 API 的 413 响应保持一致。 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const IMAGE_UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.svg,.ico";

export type AllowedImageExtension = "png" | "jpg" | "webp" | "svg" | "ico";

const MIME_TO_EXTENSION = new Map<string, AllowedImageExtension>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
  ["image/x-icon", "ico"],
  ["image/vnd.microsoft.icon", "ico"],
]);

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** 存储扩展名只信任白名单 MIME，不信任客户端文件名后缀。 */
export function imageExtensionForMime(mimeType: string): AllowedImageExtension | null {
  return MIME_TO_EXTENSION.get(normalizeMimeType(mimeType)) ?? null;
}

export function isAllowedImageMime(mimeType: string): boolean {
  return imageExtensionForMime(mimeType) !== null;
}

export function isSvgImageMime(mimeType: string): boolean {
  return imageExtensionForMime(mimeType) === "svg";
}

export function isIcoImageMime(mimeType: string): boolean {
  return imageExtensionForMime(mimeType) === "ico";
}

export function uploadMimeTypeForFile(file: File): string {
  const mimeType = normalizeMimeType(file.type);
  if (mimeType) return mimeType;
  // Safari/某些桌面环境可能不给 SVG/ICO 填 type；扩展名兜底仅用于前端体验，服务端仍按内容验真。
  if (/\.svg$/i.test(file.name)) return "image/svg+xml";
  if (/\.ico$/i.test(file.name)) return "image/x-icon";
  return "";
}
