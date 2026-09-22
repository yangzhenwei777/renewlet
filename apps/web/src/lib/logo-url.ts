export const LOGO_URL_INPUT_MAX_LENGTH = 2048;

const privateAssetPathPattern = /^\/api\/app\/assets\/[A-Za-z0-9_-]+$/;
const ipv4Pattern = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const ipv6Pattern = /^[0-9a-f:.]+$/i;

export type LogoUrlValidationCode =
  | "empty"
  | "tooLong"
  | "invalid"
  | "scheme"
  | "host"
  | "userinfo";

export type LogoUrlValidationResult =
  | { ok: true; value: string }
  | { ok: false; code: LogoUrlValidationCode };

function currentPageProtocol(): string {
  if (typeof window === "undefined") return "https:";
  return window.location.protocol;
}

export function isPrivateAssetLogoReference(value: string): boolean {
  return privateAssetPathPattern.test(value.trim());
}

/**
 * 校验用户手填 Logo URL。
 *
 * 持久化契约只允许无 userinfo 的 http(s) 外链；私有资产路径由上传流程产生，不走这个输入框。
 */
export function validateCustomLogoUrlInput(value: string): LogoUrlValidationResult {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, code: "empty" };
  if (trimmed.length > LOGO_URL_INPUT_MAX_LENGTH) return { ok: false, code: "tooLong" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, code: "invalid" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, code: "scheme" };
  if (!parsed.hostname) return { ok: false, code: "host" };
  if (parsed.username || parsed.password) return { ok: false, code: "userinfo" };
  return { ok: true, value: trimmed };
}

export function isIpHostname(hostname: string): boolean {
  const normalized = hostname.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!normalized) return false;
  if (ipv4Pattern.test(normalized)) {
    return normalized.split(".").every((part) => {
      const value = Number(part);
      return Number.isInteger(value) && value >= 0 && value <= 255;
    });
  }
  return normalized.includes(":") && ipv6Pattern.test(normalized);
}

export function resolveDisplayLogoSrc(
  value: string,
  pageProtocol: string = currentPageProtocol(),
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("data:") || trimmed.startsWith("blob:") || isPrivateAssetLogoReference(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (pageProtocol === "https:" && parsed.protocol === "http:") {
    // HTTPS 页面上临时升级普通域名图片，避免 mixed content；IP host 不猜测 HTTPS 能力，直接 fallback。
    if (isIpHostname(parsed.hostname)) return undefined;
    parsed.protocol = "https:";
    return parsed.toString();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return trimmed;
}

export function isExternalHttpImageSrc(value: string): boolean {
  try {
    const url = new URL(value, typeof window === "undefined" ? "https://renewlet.local" : window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (typeof window === "undefined") return true;
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}
