import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, type CatalogConfig, type CatalogType, type LinguiConfigNormalized } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
import { compileMessageOrThrow, type CompiledMessage } from "@lingui/message-utils/compileMessage";
import type { Plugin } from "vite";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const po = formatter();

export function getI18nConfig(rootDir = clientDir): LinguiConfigNormalized {
  // Vite 默认把模块 ID 解析到真实路径，配置根目录也须消除符号链接，避免合法 PO 被误判为未声明。
  const root = realpathSync(rootDir);
  return getConfig({ cwd: root, configPath: path.join(root, "lingui.config.ts") });
}

export function catalogFilename(config: LinguiConfigNormalized, catalog: CatalogConfig, locale: string): string {
  return path.resolve(config.rootDir, `${catalog.path.replaceAll("{locale}", locale)}.po`);
}

export function fallbackLocales(config: LinguiConfigNormalized, locale: string): string[] {
  const fallback = config.fallbackLocales;
  return [...new Set([
    ...(fallback?.[locale] ? [fallback[locale]].flat() : []),
    ...(fallback?.["default"] ? [fallback["default"]].flat() : []),
  ])].filter((value): value is string => typeof value === "string" && value !== locale);
}

export function catalogDependencies(config: LinguiConfigNormalized, catalog: CatalogConfig, locale: string): string[] {
  return [...new Set([locale, ...fallbackLocales(config, locale), config.sourceLocale])]
    .map((language) => catalogFilename(config, catalog, language));
}

export async function readCatalog(config: LinguiConfigNormalized, catalog: CatalogConfig, locale: string): Promise<CatalogType> {
  const filename = catalogFilename(config, catalog, locale);
  const contents = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (contents === undefined) return {};
  const messages = await po.parse(contents, { filename, locale, sourceLocale: config.sourceLocale });
  return Object.fromEntries(Object.entries(messages).filter(([, message]) => !message.obsolete));
}

export async function readCatalogLocales(config: LinguiConfigNormalized, catalog: CatalogConfig, locale: string): Promise<Record<string, CatalogType>> {
  const locales = [...new Set([locale, ...fallbackLocales(config, locale), config.sourceLocale])];
  return Object.fromEntries(await Promise.all(locales.map(async (language) => [language, await readCatalog(config, catalog, language)] as const)));
}

export function resolveCatalogTranslations(config: LinguiConfigNormalized, catalogs: Record<string, CatalogType>, locale: string): Record<string, string> {
  const source = catalogs[config.sourceLocale] ?? {};
  const current = catalogs[locale] ?? {};
  const fallbacks = fallbackLocales(config, locale);
  // 回退顺序属于用户可见契约：当前翻译 → 英文回退 → 源语言 → 消息 ID；空翻译继续触发回退。
  return Object.fromEntries(Object.entries({ ...source, ...current }).map(([id, entry]) => [
    id,
    current[id]?.translation
      || fallbacks.map((language) => catalogs[language]?.[id]?.translation).find(Boolean)
      || source[id]?.translation || source[id]?.message || entry.message || id,
  ] as const));
}

export function compileCatalogMessages(messages: Record<string, string>, locale: string): Record<string, CompiledMessage> {
  return Object.fromEntries(Object.keys(messages).sort().map((id) => {
    try {
      return [id, compileMessageOrThrow(messages[id] || id)] as const;
    } catch (cause) {
      throw new Error(`Cannot compile ${locale} message ${id}: ${String(cause)}`, { cause });
    }
  }));
}

export async function loadCompiledCatalog(config: LinguiConfigNormalized, filename: string) {
  const absolute = path.resolve(filename);
  for (const catalog of config.catalogs) {
    for (const locale of config.locales) {
      if (catalogFilename(config, catalog, locale) !== absolute) continue;
      const catalogs = await readCatalogLocales(config, catalog, locale);
      const messages = compileCatalogMessages(resolveCatalogTranslations(config, catalogs, locale), locale);
      return { messages, dependencies: catalogDependencies(config, catalog, locale) };
    }
  }
  throw new Error(`PO file is not declared in lingui.config.ts: ${filename}`);
}

// 提取、PO 读写和 ICU 编译直接使用官方库；此入口只负责项目路径与 Vite 生命周期，不实现另一套翻译算法。
export function linguiCatalogs(rootDir = clientDir): Plugin {
  let config: LinguiConfigNormalized;
  return {
    name: "renewlet-lingui-catalogs",
    configResolved() {
      config = getI18nConfig(rootDir);
    },
    async transform(_source, id) {
      if (!/(\.po|\?lingui)$/.test(id)) return;
      const filename = id.split("?")[0]!;
      const { messages, dependencies } = await loadCompiledCatalog(config, filename);
      // 英文/源语言 PO 变化也必须使依赖它的语言模块重新编译，避免热更新后继续显示旧回退文案。
      for (const dependency of dependencies) this.addWatchFile(dependency);
      return { code: `export const messages=JSON.parse(${JSON.stringify(JSON.stringify(messages))});`, map: null };
    },
  };
}
