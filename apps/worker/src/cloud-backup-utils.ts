// Worker 云备份工具只处理导出 ZIP 内部形状和 fetch body 兼容，不接触 provider credential。
// 历史函数名保留为 Logo，但私有资产代理路径同时服务订阅 Logo 和支付方式 Icon。
export function privateAssetIdFromLogo(value: string | null): string {
  const prefix = "/api/app/assets/";
  return value?.startsWith(prefix) ? value.slice(prefix.length).trim() : "";
}

export function extensionFromMime(mimeType: string, filename: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("svg")) return ".svg";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("jpeg")) return ".jpg";
  if (lower.includes("png")) return ".png";
  if (lower.includes("icon")) return ".ico";
  const ext = filename.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
  return ext;
}

export function parseJsonObject<T extends object>(value: string): T {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : {} as T;
  } catch {
    return {} as T;
  }
}

export function bytesForFetchBody(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data);
}
