/**
 * 浏览器端图片上传工具。
 *
 * 架构位置：
 * - ImageCropDialog 输出 data URL，SVG 上传保留原始 File。
 * - 本模块把 data URL 或原始 File 交给当前运行时的资产服务。
 *
 * 注意： 客户端校验只是体验优化；PocketBase collection 规则仍是最终安全边界。
 */
import { MAX_IMAGE_BYTES, imageExtensionForMime, isAllowedImageMime, uploadMimeTypeForFile } from "@/lib/upload-constraints";
import type { ApiUploadImageResponse, UploadKind } from "@/lib/api/schemas/media";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { assetService } from "@/services/asset-service";

export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Invalid data URL");
  }

  const header = dataUrl.slice(0, commaIndex);
  const base64 = dataUrl.slice(commaIndex + 1);

  // 只接受标准 base64 data URL；不支持 percent-encoded data URL，避免两套解码路径造成 MIME 校验差异。
  const mimeMatch = /^data:(.+);base64$/i.exec(header);
  const mimeType = (mimeMatch?.[1] ?? "application/octet-stream").trim().toLowerCase();
  if (!isAllowedImageMime(mimeType)) {
    throw new Error(translate(getApiLocale(), "media.imageTypeInvalid"));
  }
  if (!base64) {
    throw new Error("Invalid data URL");
  }

  let binary: string;
  try {
    binary = globalThis.atob(base64);
  } catch {
    throw new Error("Invalid base64 image data");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    // 浏览器 atob 返回 Latin-1 字符串；逐字节写入 Uint8Array 才能保持图片二进制不被 UTF-16 转码破坏。
    bytes[i] = binary.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: mimeType });
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(translate(getApiLocale(), "media.imageTooLarge", { size: Math.floor(MAX_IMAGE_BYTES / 1024 / 1024) }));
  }
  return blob;
}

export function validateImageFileForUpload(file: File): string | null {
  // 这里只做交互层快速失败；真实边界仍在 PocketBase collection / Worker 上传 API。
  if (!isAllowedImageMime(uploadMimeTypeForFile(file))) return translate(getApiLocale(), "media.imageTypeInvalid");
  if (file.size > MAX_IMAGE_BYTES) {
    return translate(getApiLocale(), "media.imageTooLarge", { size: Math.floor(MAX_IMAGE_BYTES / 1024 / 1024) });
  }
  return null;
}

interface UploadImageDataUrlOptions {
  dataUrl: string;
  kind: UploadKind;
  filename?: string;
}

interface UploadImageFileOptions {
  file: File;
  kind: UploadKind;
  filename?: string;
}

function getDefaultFilename(mimeType: string): string {
  const extension = imageExtensionForMime(mimeType) ?? "png";
  return `image.${extension}`;
}

async function createAssetFromFile(file: Blob, kind: UploadKind, filename: string): Promise<ApiUploadImageResponse> {
  return await assetService.create(file, kind, filename);
}

export async function uploadImageDataUrl(
  options: UploadImageDataUrlOptions,
): Promise<ApiUploadImageResponse> {
  const blob = dataUrlToBlob(options.dataUrl);
  const filename = options.filename ?? getDefaultFilename(blob.type);

  return createAssetFromFile(blob, options.kind, filename);
}

export async function uploadImageFile(
  options: UploadImageFileOptions,
): Promise<ApiUploadImageResponse> {
  const validationError = validateImageFileForUpload(options.file);
  if (validationError) throw new Error(validationError);

  const mimeType = uploadMimeTypeForFile(options.file);
  const providedFilename = options.filename?.trim();
  const originalFilename = options.file.name.trim();
  const filename = providedFilename || originalFilename || getDefaultFilename(mimeType);

  return createAssetFromFile(options.file, options.kind, filename);
}
