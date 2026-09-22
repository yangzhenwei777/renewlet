/**
 * AI 识别图片输入白名单。
 *
 * Worker 无法依赖浏览器传来的 File.type；先按声明类型判断，再用文件头兜底，避免伪造 MIME 进入第三方 provider。
 */
import { HttpError } from "./http";
import { serverText, type AppLocale } from "./server-i18n";

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function normalizeAIImageType(type: string, data: Uint8Array, locale: AppLocale): string {
  const normalized = type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ALLOWED_IMAGE_TYPES.has(normalized)) return normalized;
  const detected = detectAIImageType(data);
  if (detected) return detected;
  throw new HttpError(400, serverText(locale, "aiRecognition.imageTypeInvalid"), "AI_IMAGE_TYPE_INVALID");
}

function detectAIImageType(data: Uint8Array): string | null {
  // 只识别三种模型侧支持且前端允许上传的格式；SVG/GIF 等可显示图片不适合直接送入识别模型。
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (
    data.length >= 12
    && String.fromCharCode(...data.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...data.slice(8, 12)) === "WEBP"
  ) return "image/webp";
  return null;
}
