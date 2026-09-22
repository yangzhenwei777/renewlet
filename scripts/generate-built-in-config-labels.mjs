/**
 * 内置分类/支付方式服务端标签生成器。
 *
 * 触发时机：维护内置配置标签后手动运行，或 `pnpm check:built-in-config-labels` 在 CI 中比对。
 * 输入：`packages/shared/data/built-in-config-labels.json` 与 server-i18n active catalog；输出 Go/Worker 共享的 key 映射。
 *
 * 注意：shared JSON 是事实源；Go/Worker 只消费生成结果，不能在运行面里复制一套内置标签文案。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const i18nConfigPath = path.join(rootDir, "packages/shared/data/i18n-config.json");
const sourcePath = path.join(rootDir, "packages/shared/data/built-in-config-labels.json");
const serverI18nDir = path.join(rootDir, "packages/shared/data/server-i18n");
const workerOutPath = path.join(rootDir, "apps/worker/src/calendar-feed-built-in-labels.ts");
const goOutPath = path.join(rootDir, "apps/docker-server/cmd/renewlet/calendar_feed_builtin_labels_gen.go");
const checkMode = process.argv.includes("--check");
const requiredLocales = JSON.parse(fs.readFileSync(i18nConfigPath, "utf8")).supportedLocales;
const serverI18nInsertAfter = {
  categories: "calendarFeed.revokeFailed",
  paymentMethods: "notification.testFailed",
};

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateEntries(groupName, items, failures) {
  if (!Array.isArray(items)) {
    failures.push(`${groupName} must be an array.`);
    return [];
  }

  const values = new Set();
  const keys = new Set();
  const entries = [];
  for (const [index, item] of items.entries()) {
    if (!isRecord(item)) {
      failures.push(`${groupName}[${index}] must be an object.`);
      continue;
    }
    const value = item.value;
    const key = item.key;
    const labels = item.labels;
    if (typeof value !== "string" || value.trim() === "") {
      failures.push(`${groupName}[${index}].value must be a non-empty string.`);
      continue;
    }
    if (typeof key !== "string" || key.trim() === "") {
      failures.push(`${groupName}[${index}].key must be a non-empty string.`);
      continue;
    }
    if (values.has(value)) failures.push(`${groupName} has duplicate value ${value}.`);
    if (keys.has(key)) failures.push(`${groupName} has duplicate key ${key}.`);
    values.add(value);
    keys.add(key);

    if (!isRecord(labels)) {
      failures.push(`${groupName}.${value} labels must be an object.`);
      continue;
    }
    for (const locale of requiredLocales) {
      if (typeof labels[locale] !== "string" || labels[locale].trim() === "") {
        failures.push(`${groupName}.${value} is missing ${locale} label.`);
      }
    }
    entries.push({ value, key, labels });
  }
  return entries;
}

function readSource() {
  const failures = [];
  const source = readJson(sourcePath);
  if (!isRecord(source)) {
    throw new Error("built-in config labels source must be an object.");
  }
  const categories = validateEntries("categories", source.categories, failures);
  const paymentMethods = validateEntries("paymentMethods", source.paymentMethods, failures);
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  return { categories, paymentMethods };
}

function discoverServerLocales() {
  return fs.readdirSync(serverI18nDir)
    .map((name) => /^active\.(.+)\.json$/.exec(name)?.[1])
    .filter(Boolean)
    .sort();
}

function stringifyCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function applyServerI18nEntries(catalog, entriesByGroup, locale, failures) {
  let nextCatalog = { ...catalog };
  for (const [groupName, entries] of Object.entries(entriesByGroup)) {
    const groupMessages = {};
    for (const entry of entries) {
      const label = entry.labels[locale];
      if (typeof label !== "string" || label.trim() === "") {
        failures.push(`${entry.key} is missing ${locale} label in ${path.relative(rootDir, sourcePath)}.`);
        continue;
      }
      groupMessages[entry.key] = label;
    }
    nextCatalog = insertOrUpdateCatalogGroup(nextCatalog, groupMessages, serverI18nInsertAfter[groupName]);
  }
  return nextCatalog;
}

function insertOrUpdateCatalogGroup(catalog, messages, insertAfterKey) {
  const messageKeys = new Set(Object.keys(messages));
  const output = {};
  let inserted = false;
  for (const [key, value] of Object.entries(catalog)) {
    if (messageKeys.has(key)) continue;
    output[key] = value;
    if (!inserted && key === insertAfterKey) {
      Object.assign(output, messages);
      inserted = true;
    }
  }
  return inserted ? output : { ...output, ...messages };
}

function syncServerI18n(entriesByGroup, failures) {
  const outputs = [];
  const locales = discoverServerLocales();
  for (const locale of requiredLocales) {
    if (!locales.includes(locale)) failures.push(`server i18n catalog active.${locale}.json is missing.`);
  }

  for (const locale of locales) {
    const filePath = path.join(serverI18nDir, `active.${locale}.json`);
    const catalog = readJson(filePath);
    const nextCatalog = applyServerI18nEntries(catalog, entriesByGroup, locale, failures);
    outputs.push({ path: filePath, source: stringifyCatalog(nextCatalog) });
  }
  return outputs;
}

function tsObject(entries) {
  const lines = entries.map((entry) => `  ${JSON.stringify(entry.value)}: ${JSON.stringify(entry.key)},`);
  return `{\n${lines.join("\n")}\n}`;
}

function generateWorkerSource(entriesByGroup) {
  return [
    "import type { ServerI18nKey } from \"./server-i18n-catalog\";",
    "",
    "// Code generated by scripts/generate-built-in-config-labels.mjs; DO NOT EDIT.",
    "// 日历 Feed 公开路由不能访问前端 Lingui catalog；这里保存生成期对齐的服务端 i18n key。",
    "",
    `const CALENDAR_FEED_BUILT_IN_CATEGORY_LABEL_KEYS = ${tsObject(entriesByGroup.categories)} as const satisfies Record<string, ServerI18nKey>;`,
    "",
    `const CALENDAR_FEED_BUILT_IN_PAYMENT_METHOD_LABEL_KEYS = ${tsObject(entriesByGroup.paymentMethods)} as const satisfies Record<string, ServerI18nKey>;`,
    "",
    "function hasOwnKey<T extends object>(source: T, key: string): key is Extract<keyof T, string> {",
    "  return Object.prototype.hasOwnProperty.call(source, key);",
    "}",
    "",
    "export function calendarFeedBuiltInCategoryLabelKey(value: string): ServerI18nKey | undefined {",
    "  return hasOwnKey(CALENDAR_FEED_BUILT_IN_CATEGORY_LABEL_KEYS, value)",
    "    ? CALENDAR_FEED_BUILT_IN_CATEGORY_LABEL_KEYS[value]",
    "    : undefined;",
    "}",
    "",
    "export function calendarFeedBuiltInPaymentMethodLabelKey(value: string): ServerI18nKey | undefined {",
    "  return hasOwnKey(CALENDAR_FEED_BUILT_IN_PAYMENT_METHOD_LABEL_KEYS, value)",
    "    ? CALENDAR_FEED_BUILT_IN_PAYMENT_METHOD_LABEL_KEYS[value]",
    "    : undefined;",
    "}",
    "",
  ].join("\n");
}

function goMap(name, entries) {
  const lines = entries.map((entry) => `\t${JSON.stringify(entry.value)}: ${JSON.stringify(entry.key)},`);
  return `var ${name} = map[string]string{\n${lines.join("\n")}\n}`;
}

function generateGoSource(entriesByGroup) {
  return [
    "// Code generated by scripts/generate-built-in-config-labels.mjs; DO NOT EDIT.",
    "package main",
    "",
    "// 日历公开导出只读服务端 i18n key，不能在请求时依赖前端 catalog 或用户 settings。",
    "",
    goMap("calendarFeedBuiltInCategoryLabelKeys", entriesByGroup.categories),
    "",
    goMap("calendarFeedBuiltInPaymentMethodLabelKeys", entriesByGroup.paymentMethods),
    "",
  ].join("\n");
}

function formatGoSource(source) {
  const result = spawnSync("gofmt", [], { encoding: "utf8", input: source });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || "gofmt failed");
  }
  return result.stdout;
}

const entriesByGroup = readSource();
const failures = [];
const outputs = [
  ...syncServerI18n(entriesByGroup, failures),
  { path: workerOutPath, source: generateWorkerSource(entriesByGroup) },
  { path: goOutPath, source: formatGoSource(generateGoSource(entriesByGroup)) },
];

for (const output of outputs) {
  if (!fs.existsSync(output.path)) {
    if (checkMode) failures.push(`${path.relative(rootDir, output.path)} is missing. Run \`pnpm generate:built-in-config-labels\`.`);
    continue;
  }
  if (checkMode && fs.readFileSync(output.path, "utf8") !== output.source) {
    failures.push(`${path.relative(rootDir, output.path)} is out of sync. Run \`pnpm generate:built-in-config-labels\`.`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

if (checkMode) {
  console.log("built-in config label maps OK.");
} else {
  for (const output of outputs) {
    fs.mkdirSync(path.dirname(output.path), { recursive: true });
    fs.writeFileSync(output.path, output.source);
  }
  console.log("generated built-in config label maps.");
}
