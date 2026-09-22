/**
 * Lingui catalog、生成物与前端可见文案守卫。
 *
 * 触发时机：`pnpm --filter @renewlet/client i18n:check` 和 CI 前端门禁。
 * 前置依赖：Lingui config、descriptor、`.po` catalog、TypeScript AST 和前后端 i18n 生成物都必须存在。
 *
 * 注意：脚本只检查不同步，不主动重写文件；翻译缺失或 key 漂移必须回到 extract/generate 流程修复。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatter } from "@lingui/format-po";
import { findFrontendI18nViolations } from "./frontend-i18n-guard.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const i18nConfig = JSON.parse(fs.readFileSync(path.join(rootDir, "packages/shared/data/i18n-config.json"), "utf8"));
const clientDir = path.join(rootDir, "apps/web");
const clientRequire = createRequire(path.join(clientDir, "package.json"));
const { getConfig } = await import(clientRequire.resolve("@lingui/conf"));
const { getCatalogs } = await import(clientRequire.resolve("@lingui/cli/api"));

const catalogDir = path.join(clientDir, "src/i18n/catalogs");
const descriptorDir = path.join(clientDir, "src/i18n/descriptors");
const distAssetsDir = path.join(clientDir, "dist/assets");
const serverI18nSourceDir = path.join(rootDir, "packages/shared/data/server-i18n");
const goServerDir = path.join(rootDir, "apps/docker-server/cmd/renewlet");
const cloudflareSrcDir = path.join(rootDir, "apps/worker/src");
const serverI18nGenerator = path.join(rootDir, "scripts/generate-server-i18n.mjs");
const clientI18nGenerator = path.join(rootDir, "scripts/generate-i18n-artifacts.mjs");
const sourceRoot = path.join(clientDir, "src");
const locales = i18nConfig.supportedLocales;
const sourceLocale = i18nConfig.sourceLocale;
const serverSourceLocale = i18nConfig.sourceLocale;
const domains = [
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
];
const poFormatter = formatter({ origins: false });
const forbiddenProductionRawMessages = [
  "共 {count} 个订阅",
  "实时汇率换算 ({currency})",
  "默认值从设置中获取（提前 {days} 天）",
  "{year}年{month}月{day}日",
];

function readCatalogFile(locale, domain) {
  const filePath = path.join(catalogDir, locale, `${domain}.po`);
  const source = fs.readFileSync(filePath, "utf8");
  const parsed = poFormatter.parse(source, {
    locale,
    sourceLocale,
    filename: filePath,
  });
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([, entry]) => !entry.obsolete)
      .map(([key, entry]) => [key, entry.translation ?? entry.message ?? ""]),
  );
}

function readCatalog(locale) {
  return Object.assign({}, ...domains.map((domain) => readCatalogFile(locale, domain)));
}

function placeholders(message) {
  const names = new Set();
  for (const match of message.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)(?:[,\}])/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function serverPlaceholders(message) {
  const names = new Set();
  for (const match of message.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function walkFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walkFiles(fullPath, files);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function walkAllFiles(dir, files = [], options = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (options.skipDirs?.has(entry.name)) continue;
      walkAllFiles(fullPath, files, options);
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function lineNumberForOffset(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function literalText(literal) {
  return literal
    .slice(1, -1)
    .replace(/\$\{[^}]*\}/g, "")
    .trim();
}

function hasDisplayText(literal) {
  return /[\p{L}\p{N}]/u.test(literalText(literal));
}

function relativePath(filePath) {
  return path.relative(rootDir, filePath);
}

function compareMessageMap(failures, label, expected, actual) {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  const expectedKeySet = new Set(expectedKeys);
  const actualKeySet = new Set(actualKeys);
  for (const key of expectedKeys) {
    if (!actualKeySet.has(key)) failures.push(`${label} is missing key ${key}`);
  }
  for (const key of actualKeys) {
    if (!expectedKeySet.has(key)) failures.push(`${label} has extra key ${key}`);
  }
  for (const key of expectedKeys) {
    if (!(key in actual)) continue;
    if (expected[key] !== actual[key]) {
      failures.push(`${label} source message mismatch for ${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`);
    }
  }
}

async function extractDescriptorCatalogs() {
  const config = getConfig({ cwd: clientDir, configPath: path.join(clientDir, "lingui.config.ts") });
  const catalogs = await getCatalogs(config);
  const extracted = {};
  for (const catalog of catalogs) {
    const messages = await catalog.collect();
    if (!messages) {
      throw new Error(`Lingui failed to extract descriptor catalog ${catalog.name ?? catalog.path}`);
    }
    extracted[catalog.name ?? path.basename(catalog.path)] = Object.fromEntries(
      Object.entries(messages).map(([key, entry]) => [key, entry.message ?? key]),
    );
  }
  return extracted;
}

function readServerI18nCatalog(locale) {
  return JSON.parse(fs.readFileSync(path.join(serverI18nSourceDir, `active.${locale}.json`), "utf8"));
}

function discoverServerLocales() {
  const serverLocales = fs.readdirSync(serverI18nSourceDir)
    .map((name) => /^active\.(.+)\.json$/.exec(name)?.[1])
    .filter(Boolean)
    .sort();
  if (!serverLocales.includes(serverSourceLocale)) {
    throw new Error(`missing source server i18n catalog active.${serverSourceLocale}.json`);
  }
  return [serverSourceLocale, ...serverLocales.filter((locale) => locale !== serverSourceLocale)];
}

function checkServerI18nCatalogs(failures) {
  const serverLocales = discoverServerLocales();
  const catalogs = Object.fromEntries(serverLocales.map((locale) => [locale, readServerI18nCatalog(locale)]));
  const baseServer = catalogs[serverSourceLocale];
  const baseKeys = Object.keys(baseServer).sort();
  const baseKeySet = new Set(baseKeys);
  for (const locale of serverLocales) {
    const current = catalogs[locale];
    const currentKeys = Object.keys(current).sort();
    const currentKeySet = new Set(currentKeys);
    for (const key of baseKeys) {
      if (!currentKeySet.has(key)) failures.push(`server i18n ${locale} is missing key ${key}`);
    }
    for (const key of currentKeys) {
      if (!baseKeySet.has(key)) failures.push(`server i18n ${locale} has extra key ${key}`);
      if (typeof current[key] !== "string" || current[key].trim() === "") {
        failures.push(`server i18n ${locale} has empty message for ${key}`);
      }
      if (/%(\d+\$)?[+#0\- ]*(\*|\d+)?(?:\.(\*|\d+))?[bcdeEfgGopqstTvxXU]/.test(current[key] ?? "")) {
        failures.push(`server i18n ${locale} uses legacy printf placeholder in ${key}; use named placeholders like {label}.`);
      }
    }
  }
  for (const key of baseKeys) {
    const expected = serverPlaceholders(baseServer[key]).join(",");
    for (const locale of serverLocales.filter((locale) => locale !== serverSourceLocale)) {
      const actual = serverPlaceholders(catalogs[locale][key] ?? "").join(",");
      if (expected !== actual) {
        failures.push(`server i18n ${locale} placeholder mismatch for ${key}: expected [${expected}], got [${actual}]`);
      }
    }
  }
}

function checkServerI18nGeneratedOutputs(failures) {
  const output = spawnSync(process.execPath, [serverI18nGenerator, "--check"], { cwd: rootDir, encoding: "utf8" });
  if (output.status !== 0) {
    failures.push((output.stderr || output.stdout || "server i18n generated outputs are out of sync").trim());
  }
}

function checkClientI18nGeneratedOutputs(failures) {
  const output = spawnSync(process.execPath, [clientI18nGenerator, "--check"], { cwd: rootDir, encoding: "utf8" });
  if (output.status !== 0) {
    failures.push((output.stderr || output.stdout || "client i18n generated outputs are out of sync").trim());
  }
}

const failures = [];
const indexHtml = fs.readFileSync(path.join(clientDir, "index.html"), "utf8");
const staticHtmlLocale = /<html\s+[^>]*lang=["']([^"']+)["']/i.exec(indexHtml)?.[1];
if (staticHtmlLocale !== i18nConfig.fallbackLocale) {
  failures.push(`apps/web/index.html lang must match fallbackLocale ${i18nConfig.fallbackLocale}, got ${staticHtmlLocale ?? "missing"}.`);
}
const catalogs = Object.fromEntries(locales.map((locale) => [locale, readCatalog(locale)]));
const base = catalogs[sourceLocale];
const baseKeys = Object.keys(base).sort();
const extractedCatalogs = await extractDescriptorCatalogs();
const extracted = Object.assign({}, ...domains.map((domain) => extractedCatalogs[domain] ?? {}));

// descriptor 是人工维护入口，zh-CN PO 必须由 Lingui extract 同步出来，不能手动漂移。
compareMessageMap(failures, "descriptor source", extracted, base);

for (const domain of domains) {
  if (!extractedCatalogs[domain]) {
    failures.push(`missing descriptor catalog for domain ${domain}`);
  }
}
for (const domain of Object.keys(extractedCatalogs)) {
  if (!domains.includes(domain)) {
    failures.push(`unexpected descriptor catalog domain ${domain}`);
  }
}

for (const locale of locales.filter((locale) => locale !== sourceLocale)) {
  const current = catalogs[locale];
  const currentKeys = new Set(Object.keys(current));
  const baseKeySet = new Set(baseKeys);
  for (const key of baseKeys) {
    if (!currentKeys.has(key)) failures.push(`${locale} is missing key ${key}`);
  }
  for (const key of currentKeys) {
    if (!baseKeySet.has(key)) failures.push(`${locale} has extra key ${key}`);
  }
  for (const key of baseKeys) {
    if (!(key in current)) continue;
    const expected = placeholders(base[key]).join(",");
    const actual = placeholders(current[key]).join(",");
    if (expected !== actual) {
      failures.push(`${locale} placeholder mismatch for ${key}: expected [${expected}], got [${actual}]`);
    }
    if (!current[key]) {
      failures.push(`${locale} has empty translation for ${key}`);
    }
  }
}

checkClientI18nGeneratedOutputs(failures);
checkServerI18nCatalogs(failures);
checkServerI18nGeneratedOutputs(failures);

const sourceFiles = walkFiles(sourceRoot);
const staticLabelPattern = /\blabels\(\s*(["'])([^"']*)\1\s*,\s*(["'])([^"']*)\3\s*\)/g;
const localeBranchPattern = /\b(?:locale|localeState\.locale|getApiLocale\(\))\s*={2,3}\s*["'](?:zh-CN|en-US)["']\s*\?\s*(`(?:[^`\\]|\\[\s\S])*`|"[^"\n]*"|'[^'\n]*')\s*:\s*(`(?:[^`\\]|\\[\s\S])*`|"[^"\n]*"|'[^'\n]*')/g;
const linguiMacroImportPattern = /from\s+["']@lingui\/(?:core|react)\/macro["']/;
for (const filePath of sourceFiles) {
  const source = fs.readFileSync(filePath, "utf8");
  const isDescriptor = filePath.startsWith(`${descriptorDir}${path.sep}`);
  if (linguiMacroImportPattern.test(source) && !isDescriptor) {
    failures.push(`${relativePath(filePath)} imports a Lingui macro outside src/i18n/descriptors. Keep product-owned source messages in domain descriptors.`);
  }
  for (const match of source.matchAll(staticLabelPattern)) {
    const zhCN = match[2] ?? "";
    const enUS = match[4] ?? "";
    if (!zhCN && !enUS) continue;
    failures.push(`${relativePath(filePath)}:${lineNumberForOffset(source, match.index ?? 0)} uses static labels("${zhCN}", "${enUS}"). Product-owned labels must come from the Lingui catalog.`);
  }
  if (/\.(?:test|spec)(?:[.-][^.]+)*\.(?:ts|tsx)$/.test(filePath)) continue;
  if (!isDescriptor) {
    for (const violation of findFrontendI18nViolations(source, filePath)) {
      failures.push(`${relativePath(filePath)}:${violation.line} has static ${violation.kind} ${JSON.stringify(violation.text)}. Move product-owned text to the Lingui catalog.`);
    }
  }
  for (const match of source.matchAll(localeBranchPattern)) {
    const first = match[1] ?? "";
    const second = match[2] ?? "";
    if (!hasDisplayText(first) && !hasDisplayText(second)) continue;
    failures.push(`${relativePath(filePath)}:${lineNumberForOffset(source, match.index ?? 0)} uses a locale branch with inline display text. Move product-owned text to the Lingui catalog.`);
  }
}

const serverSourceFiles = [
  ...walkAllFiles(goServerDir, [], { skipDirs: new Set(["i18n", "templates"]) }).filter((filePath) => /\.(go)$/.test(filePath)),
  ...walkAllFiles(cloudflareSrcDir).filter((filePath) => /\.ts$/.test(filePath) && !filePath.endsWith("server-i18n-catalog.ts")),
];
const legacyDualTextPattern = /\btr\s*\(/;
const serverLocaleBranchPattern = /\b(?:locale|settings\.localePreference|requestLocale\([^)]*\))\s*!?={2,3}\s*["'](?:zh-CN|en-US)["']\s*\?\s*(`(?:[^`\\]|\\[\s\S])*`|"[^"\n]*"|'[^'\n]*')\s*:\s*(`(?:[^`\\]|\\[\s\S])*`|"[^"\n]*"|'[^'\n]*')/g;
const acceptLanguageIncludesPattern = /accept-language[\s\S]{0,160}\.includes\(\s*["'](?:en|zh)/i;
for (const filePath of serverSourceFiles) {
  const source = fs.readFileSync(filePath, "utf8");
  if (legacyDualTextPattern.test(source)) {
    failures.push(`${relativePath(filePath)} uses tr(). Server-visible text must come from packages/shared/data/server-i18n.`);
  }
  if (acceptLanguageIncludesPattern.test(source)) {
    failures.push(`${relativePath(filePath)} matches Accept-Language with includes(). Use the server locale matcher instead.`);
  }
  if (/\.(test|spec)\.(go|ts)$/.test(filePath)) continue;
  for (const match of source.matchAll(serverLocaleBranchPattern)) {
    const first = match[1] ?? "";
    const second = match[2] ?? "";
    if (!hasDisplayText(first) && !hasDisplayText(second)) continue;
    failures.push(`${relativePath(filePath)}:${lineNumberForOffset(source, match.index ?? 0)} uses a server locale branch with inline display text. Move server text to the server i18n catalog.`);
  }
}

for (const filePath of walkAllFiles(catalogDir)) {
  if (/\.ts$/.test(filePath)) {
    failures.push(`${relativePath(filePath)} is a raw TS catalog. Use src/i18n/descriptors/*.ts plus Lingui PO catalogs instead.`);
  }
}

if (fs.existsSync(distAssetsDir)) {
  for (const filePath of walkAllFiles(distAssetsDir).filter((filePath) => filePath.endsWith(".js"))) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const rawMessage of forbiddenProductionRawMessages) {
      if (source.includes(rawMessage)) {
        failures.push(`${relativePath(filePath)} still contains uncompiled ICU message "${rawMessage}"`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`i18n catalogs OK (${baseKeys.length} keys, ${locales.length} locales, ${domains.length} descriptor domains).`);
