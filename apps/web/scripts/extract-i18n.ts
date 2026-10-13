import { globSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transformAsync } from "@babel/core";
import extractMessages, { type ExtractedMessage } from "@lingui/babel-plugin-extract-messages";
import linguiMacro from "@lingui/babel-plugin-lingui-macro";
import type { CatalogType, ExtractedCatalogType, LinguiConfigNormalized, MessageOrigin } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
import { catalogFilename, getI18nConfig } from "../vite/lingui-catalogs.ts";

function mergeMessage(messages: ExtractedCatalogType, next: ExtractedMessage, rootDir: string) {
  const previous = messages[next.id];
  if (previous?.message && next.message && previous.message !== next.message) {
    throw new Error(`Conflicting source messages for ${next.id}: ${previous.message} / ${next.message}`);
  }
  const origin: MessageOrigin[] = next.origin ? [[path.relative(rootDir, next.origin[0]).split(path.sep).join("/"), next.origin[1]]] : [];
  const placeholders = { ...previous?.placeholders };
  for (const [key, value] of Object.entries(next.placeholders ?? {})) {
    placeholders[key] = [...new Set([...(placeholders[key] ?? []), value])].sort();
  }
  const message = previous?.message ?? next.message;
  const context = previous?.context ?? next.context;
  messages[next.id] = {
    ...(message === undefined ? {} : { message }),
    ...(context === undefined ? {} : { context }),
    origin: [...(previous?.origin ?? []), ...origin].sort((a, b) => a[0].localeCompare(b[0]) || (a[1] ?? 0) - (b[1] ?? 0)),
    comments: [...(previous?.comments ?? []), ...(next.comment ? [next.comment] : [])].sort(),
    placeholders,
  };
}

export async function collectDescriptorCatalogs(config = getI18nConfig()): Promise<Record<string, ExtractedCatalogType>> {
  const catalogs: Record<string, ExtractedCatalogType> = {};
  for (const catalog of config.catalogs) {
    const messages: ExtractedCatalogType = Object.create(null) as ExtractedCatalogType;
    const files = globSync(catalog.include, { cwd: config.rootDir, exclude: catalog.exclude ?? [] }).sort();
    if (!files.length) throw new Error(`No descriptor files matched ${catalog.path}`);
    for (const relative of files) {
      const filename = path.resolve(config.rootDir, relative);
      // descriptor 只按语法树提取，不执行模块；与旧 CLI 使用相同版本的官方 Babel macro/extract 插件。
      await transformAsync(await readFile(filename, "utf8"), {
        filename, code: false, babelrc: false, configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [
          [linguiMacro, { descriptorFields: "all", linguiConfig: config }],
          [extractMessages, { linguiConfig: config, onMessageExtracted: (message: ExtractedMessage) => mergeMessage(messages, message, config.rootDir) }],
        ],
      });
    }
    catalogs[catalog.name ?? path.basename(catalog.path)] = messages;
  }
  return catalogs;
}

export function mergeCatalogTranslations(extracted: ExtractedCatalogType, previous: CatalogType, sourceLocale: boolean): CatalogType {
  // 保留非源语言人工翻译及 PO 元数据；源语言跟随 descriptor，删除已移除的 key，等价于原来的 --clean --overwrite。
  return Object.fromEntries(Object.entries(extracted).map(([id, message]) => [id, {
    ...message,
    ...(previous[id]?.extra === undefined ? {} : { extra: previous[id].extra }),
    translation: sourceLocale ? message.message || id : previous[id]?.translation ?? "",
  }] as const));
}

export async function extractCatalogs(config: LinguiConfigNormalized = getI18nConfig()): Promise<void> {
  const extracted = await collectDescriptorCatalogs(config);
  const po = formatter();
  const collator = new Intl.Collator("en-US");
  const writes: { filename: string; content: string }[] = [];
  for (const catalog of config.catalogs) {
    const messages = extracted[catalog.name ?? path.basename(catalog.path)]!;
    for (const locale of config.locales) {
      const filename = catalogFilename(config, catalog, locale);
      const existing = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const context = { filename, locale, sourceLocale: config.sourceLocale, existing };
      const previous = existing === undefined ? {} : await po.parse(existing, context);
      const merged = mergeCatalogTranslations(messages, previous, locale === config.sourceLocale);
      const sorted = Object.fromEntries(Object.entries(merged).sort(([, a], [, b]) =>
        collator.compare(a.message ?? "", b.message ?? "") || collator.compare(a.context ?? "", b.context ?? "")));
      const content = await po.serialize(sorted, context);
      if (content !== existing) writes.push({ filename, content });
    }
  }
  // 全部提取与解析成功后才写 PO，语法错误不能让三语言 catalog 只更新一半。
  for (const { filename, content } of writes) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await extractCatalogs();
}
