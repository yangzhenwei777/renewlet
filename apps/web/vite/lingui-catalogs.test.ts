import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setupI18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import type { CatalogType, LinguiConfigNormalized } from "@lingui/conf";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "vite";
import { collectDescriptorCatalogs, extractCatalogs } from "../scripts/extract-i18n.ts";
import {
  catalogDependencies,
  catalogFilename,
  compileCatalogMessages,
  getI18nConfig,
  loadCompiledCatalog,
  linguiCatalogs,
  readCatalog,
  resolveCatalogTranslations,
} from "./lingui-catalogs.ts";

const temporaryDirs: string[] = [];
const po = formatter();

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<LinguiConfigNormalized> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "renewlet-i18n-"));
  temporaryDirs.push(rootDir);
  await mkdir(path.join(rootDir, "descriptors"));
  return {
    ...getI18nConfig(),
    rootDir,
    catalogs: [{ path: "catalogs/{locale}/common", include: ["descriptors/*.ts"], exclude: [] }],
  };
}

async function writeCatalog(config: LinguiConfigNormalized, locale: string, messages: CatalogType) {
  const filename = catalogFilename(config, config.catalogs[0]!, locale);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, await po.serialize(messages, { filename, locale, sourceLocale: config.sourceLocale, existing: undefined }));
  return filename;
}

describe("Lingui catalog tooling", () => {
  it("extracts macros without executing descriptors, preserves translations and removes obsolete keys", async () => {
    const config = await fixture();
    await writeFile(path.join(config.rootDir, "descriptors/messages.ts"), `
      import { msg } from "@lingui/core/macro";
      throw new Error("A descriptor must never execute during extraction");
      export const messages = [
        msg({ id: "hello", message: "你好 {name}", comment: "Greeting" }),
        msg({ id: "new", message: "新增" }),
      ];
    `);
    const english = await writeCatalog(config, "en-US", {
      hello: { translation: "Hello {name}", extra: { translatorComments: ["Keep this note"], flags: [] } },
      removed: { translation: "No longer used" },
    });
    await writeCatalog(config, "zh-CN", { hello: { translation: "旧中文" } });
    await writeCatalog(config, "ru-RU", { hello: { translation: "Привет {name}" } });

    const collected = await collectDescriptorCatalogs(config);
    expect(collected["common"]?.["hello"]?.message).toBe("你好 {name}");
    expect(collected["common"]?.["hello"]?.comments).toEqual(["Greeting"]);
    await extractCatalogs(config);
    const read = (locale: string) => readCatalog(config, config.catalogs[0]!, locale);
    expect((await read("en-US"))["hello"]?.translation).toBe("Hello {name}");
    expect((await read("ru-RU"))["hello"]?.translation).toBe("Привет {name}");
    expect((await read("zh-CN"))["hello"]?.translation).toBe("你好 {name}");
    expect((await read("en-US"))["new"]?.translation).toBe("");
    expect((await read("en-US"))["removed"]).toBeUndefined();
    expect(await readFile(english, "utf8")).toContain("Keep this note");
    const before = await readFile(english, "utf8");
    await extractCatalogs(config);
    expect(await readFile(english, "utf8")).toBe(before);
  });

  it("rejects duplicate IDs with conflicting source text before writing any locale", async () => {
    const config = await fixture();
    await writeFile(path.join(config.rootDir, "descriptors/a.ts"), 'import { msg } from "@lingui/core/macro"; msg({id:"same", message:"First"});');
    await writeFile(path.join(config.rootDir, "descriptors/b.ts"), 'import { msg } from "@lingui/core/macro"; msg({id:"same", message:"Second"});');
    const filename = await writeCatalog(config, "en-US", { same: { translation: "Existing translation" } });
    const before = await readFile(filename, "utf8");
    await expect(extractCatalogs(config)).rejects.toThrow("Conflicting source messages for same");
    expect(await readFile(filename, "utf8")).toBe(before);
  });

  it("fails on a missing descriptor path instead of cleaning all translations", async () => {
    const config = await fixture();
    await expect(extractCatalogs(config)).rejects.toThrow("No descriptor files matched");
  });

  it("preserves locale, English, source-language and ID fallback order", () => {
    const config = getI18nConfig();
    const messages = resolveCatalogTranslations(config, {
      "zh-CN": {
        translated: { translation: "中文" }, english: { translation: "中文回退" },
        source: { translation: "源语言" }, id: {},
      },
      "en-US": { translated: { translation: "English" }, english: { translation: "Fallback" } },
      "ru-RU": { translated: { translation: "Перевод" }, english: { translation: "" } },
    }, "ru-RU");
    expect(messages).toEqual({ translated: "Перевод", english: "Fallback", source: "源语言", id: "id" });
  });

  it("compiles Russian plurals and nested ICU selectors for the unchanged Lingui runtime", () => {
    const messages = compileCatalogMessages({
      count: "{count, plural, one {# элемент} few {# элемента} many {# элементов} other {# элемента}}",
      nested: "{role, select, admin {{count, plural, one {One task} other {# tasks}}} other {No access}}",
    }, "ru-RU");
    const i18n = setupI18n({ locale: "ru-RU", messages: { "ru-RU": messages } });
    expect([1, 2, 5, 21].map((count) => i18n._("count", { count }))).toEqual(["1 элемент", "2 элемента", "5 элементов", "21 элемент"]);
    expect(i18n._("nested", { role: "admin", count: 2 })).toBe("2 tasks");
    expect(() => compileCatalogMessages({ broken: "{count, plural, one {unfinished}" }, "ru-RU")).toThrow("Cannot compile ru-RU message broken");
  });

  it("tracks source and fallback PO files, recompiles changed fallback text and rejects undeclared files", async () => {
    const config = await fixture();
    await writeCatalog(config, "zh-CN", { hello: { translation: "你好" }, obsolete: { translation: "删除", obsolete: true } });
    const english = await writeCatalog(config, "en-US", { hello: { translation: "Hello" } });
    const russian = await writeCatalog(config, "ru-RU", { hello: { translation: "" } });
    const before = await loadCompiledCatalog(config, russian);
    expect(before.dependencies).toEqual(catalogDependencies(config, config.catalogs[0]!, "ru-RU"));
    expect(before.dependencies).toContain(english);
    expect(before.messages).toEqual({ hello: ["Hello"] });
    await writeCatalog(config, "en-US", { hello: { translation: "Updated" } });
    expect((await loadCompiledCatalog(config, russian)).messages).toEqual({ hello: ["Updated"] });
    await expect(loadCompiledCatalog(config, path.join(config.rootDir, "undeclared.po"))).rejects.toThrow("not declared");
  });

  it("invalidates the imported locale in a real Vite server when its English fallback changes", async () => {
    const config = await fixture();
    await writeFile(path.join(config.rootDir, "lingui.config.ts"), `export default ${JSON.stringify({
      locales: config.locales, sourceLocale: config.sourceLocale,
      fallbackLocales: config.fallbackLocales, catalogs: config.catalogs,
    })};`);
    await writeCatalog(config, "zh-CN", { hello: { translation: "你好" } });
    await writeCatalog(config, "en-US", { hello: { translation: "Before change" } });
    await writeCatalog(config, "ru-RU", { hello: { translation: "" } });
    const server = await createServer({
      root: config.rootDir, configFile: false, plugins: [linguiCatalogs(config.rootDir)],
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      expect((await server.transformRequest("/catalogs/ru-RU/common.po"))?.code).toContain("Before change");
      await writeCatalog(config, "en-US", { hello: { translation: "After change" } });
      await vi.waitFor(async () => {
        expect((await server.transformRequest("/catalogs/ru-RU/common.po"))?.code).toContain("After change");
      });
    } finally {
      await server.close();
    }
  });
});
