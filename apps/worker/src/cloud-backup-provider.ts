import type { CloudBackupProvider } from "@renewlet/shared/schemas/cloud-backup";
import { HttpError, type AppLocale } from "./http";
import { serverText } from "./server-i18n";

// provider 解析是 Worker API 的第一道隔离边界；缺失和非法参数必须在访问远端前失败。
export type CloudBackupProviderQuery =
  | { hasProvider: true; provider: CloudBackupProvider }
  | { hasProvider: false; provider?: undefined };

export function cloudBackupProviderFromRequest(request: Request, locale: AppLocale): CloudBackupProviderQuery {
  const params = new URL(request.url).searchParams;
  if (!params.has("provider")) return { hasProvider: false };
  const provider = params.get("provider")?.trim();
  if (provider !== "webdav" && provider !== "s3") {
    throw cloudBackupProviderParameterError(locale, "CLOUD_BACKUP_PROVIDER_INVALID", "provider_invalid", "Use provider=webdav or provider=s3.");
  }
  return { hasProvider: true, provider };
}

export function cloudBackupProviderParameterError(locale: AppLocale, code: string, _reason: string, message: string): HttpError {
  return new HttpError(400, serverText(locale, "cloudBackup.providerInvalid"), code, {
    rawResponseText: message,
  });
}
