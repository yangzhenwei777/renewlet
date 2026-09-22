#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";

const IANA_ZONE1970_URL = "https://data.iana.org/time-zones/tzdb/zone1970.tab";
const CLDR_CURRENCY_DATA_URLS = [
  "https://cdn.jsdelivr.net/gh/unicode-org/cldr-json@main/cldr-json/cldr-core/supplemental/currencyData.json",
  "https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-core/supplemental/currencyData.json",
  "https://cdn.jsdelivr.net/gh/unicode-cldr/cldr-core@master/supplemental/currencyData.json",
];

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(rootDir, "packages/shared/data/currency-region-hints.json");
const currencyDataPath = path.join(rootDir, "apps/web/src/lib/currency-data.ts");
const checkMode = process.argv.includes("--check");
const execFileAsync = promisify(execFile);

async function fetchText(urlOrUrls) {
  const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
  const errors = [];
  for (const url of urls) {
    try {
      const { stdout } = await execFileAsync("curl", ["-fsSL", "--max-time", "30", url], { maxBuffer: 4 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      errors.push(error);
    }

    try {
      const response = await fetch(url, {
        headers: { "user-agent": "renewlet-currency-region-hints-generator" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
      }
      return response.text();
    } catch (error) {
      errors.push(error);
    }
  }
  throw new AggregateError(errors, `Failed to fetch ${urls.join(", ")}`);
}

function readSupportedCurrencies(source) {
  const match = source.match(/SUPPORTED_EXCHANGE_RATE_CURRENCIES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!match) {
    throw new Error("Could not find SUPPORTED_EXCHANGE_RATE_CURRENCIES in currency-data.ts");
  }
  return new Set(Array.from(match[1].matchAll(/"([A-Z]{3})"/g), (item) => item[1]));
}

function parseIanaZone1970(text) {
  const version = text.match(/^#\s*version\s+(.+)$/m)?.[1]?.trim();
  const headerDate = text.match(/^#\s*From\s+.+\((\d{4}-\d{2}-\d{2})\):$/m)?.[1]?.trim();
  const sourceVersion = version ?? (headerDate ? `IANA ${headerDate}` : "IANA latest");
  const timeZoneTerritories = {};

  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [countries, , timeZone] = line.split("\t");
    if (!countries || !timeZone) continue;
    timeZoneTerritories[timeZone] = countries.split(",").filter((country) => /^[A-Z]{2}$/.test(country));
  }

  timeZoneTerritories.UTC = [];
  timeZoneTerritories["Etc/UTC"] = [];
  return { version: sourceVersion, timeZoneTerritories };
}

function parseCldrTerritoryCurrencies(json, supportedCurrencies) {
  const cldrVersion = json.supplemental?.version?._cldrVersion ?? "unknown";
  const regionData = json.supplemental?.currencyData?.region;
  if (!regionData || typeof regionData !== "object") {
    throw new Error("CLDR currencyData.region is missing");
  }

  const territoryCurrencies = {};
  for (const [territory, entries] of Object.entries(regionData)) {
    if (!/^[A-Z]{2}$/.test(territory)) continue;
    const currentCurrencies = new Set();
    for (const entry of normalizeCldrCurrencyEntries(entries)) {
      if (
        entry.meta._tender !== "false"
        && entry.meta._to === undefined
        && supportedCurrencies.has(entry.currency)
      ) {
        currentCurrencies.add(entry.currency);
      }
    }
    if (currentCurrencies.size === 1) {
      territoryCurrencies[territory] = Array.from(currentCurrencies)[0];
    }
  }

  return { cldrVersion, territoryCurrencies };
}

function normalizeCldrCurrencyEntries(entries) {
  const normalized = [];
  const sourceEntries = Array.isArray(entries) ? entries : [entries];
  for (const entry of sourceEntries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry._iso4217 === "string") {
      normalized.push({ currency: entry._iso4217, meta: entry });
      continue;
    }
    for (const [currency, meta] of Object.entries(entry)) {
      if (/^[A-Z]{3}$/.test(currency) && meta && typeof meta === "object") {
        normalized.push({ currency, meta });
      }
    }
  }
  return normalized;
}

function sortRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

async function currentGeneratedAt() {
  if (!checkMode) return new Date().toISOString().slice(0, 10);
  const current = JSON.parse(await readFile(outputPath, "utf8"));
  const generatedAt = current?.sourceVersion?.generatedAt;
  return typeof generatedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(generatedAt)
    ? generatedAt
    : new Date().toISOString().slice(0, 10);
}

async function main() {
  const [currencyDataSource, ianaText, cldrText] = await Promise.all([
    readFile(currencyDataPath, "utf8"),
    fetchText(IANA_ZONE1970_URL),
    fetchText(CLDR_CURRENCY_DATA_URLS),
  ]);
  const supportedCurrencies = readSupportedCurrencies(currencyDataSource);
  const { version: ianaVersion, timeZoneTerritories } = parseIanaZone1970(ianaText);
  const { cldrVersion, territoryCurrencies } = parseCldrTerritoryCurrencies(JSON.parse(cldrText), supportedCurrencies);
  const generatedAt = await currentGeneratedAt();
  const output = `${JSON.stringify({
    sourceVersion: {
      ianaTimeZone: `${ianaVersion} zone1970.tab`,
      unicodeCldr: `CLDR ${cldrVersion} supplemental currencyData`,
      generatedAt,
    },
    timeZoneTerritories: sortRecord(timeZoneTerritories),
    territoryCurrencies: sortRecord(territoryCurrencies),
  }, null, 2)}\n`;

  if (checkMode) {
    const current = await readFile(outputPath, "utf8");
    if (current !== output) {
      throw new Error("currency-region-hints.json is out of date. Run pnpm generate:currency-region-hints.");
    }
    return;
  }

  await writeFile(outputPath, output);
}

await main();
