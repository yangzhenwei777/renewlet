import { defineConfig } from "@lingui/conf";
import { FALLBACK_LOCALE, SOURCE_LOCALE, SUPPORTED_LOCALES } from "@renewlet/shared/i18n-config";

// catalog domain 是人工维护的 i18n 边界；检查器和生成脚本依赖同一组 domain 来防止 descriptor、PO、类型化生成物漂移。
const catalogDomains = [
  "common",
  "legal",
  "custom-config",
  "subscription",
  "auth",
  "settings",
  "settings-access-security",
  "public-status",
  "notification",
  "labels",
  "admin",
  "error",
] as const;

export default defineConfig({
  locales: [...SUPPORTED_LOCALES],
  sourceLocale: SOURCE_LOCALE,
  fallbackLocales: { default: FALLBACK_LOCALE },
  catalogs: catalogDomains.map((domain) => ({
    path: `src/i18n/catalogs/{locale}/${domain}`,
    include: [`src/i18n/descriptors/${domain}.ts`],
  })),
});
