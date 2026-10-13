import { beforeAll, describe, expect, it } from "vitest";
import fixtures from "../../../../packages/shared/src/contract-fixtures/config-label-locales.json";
import { labelsFromCatalog } from "./label-messages";
import { localizedLabel, SUPPORTED_LOCALES } from "./locales";
import { loadLocaleCatalog } from "./messages";

beforeAll(async () => {
  await Promise.all(SUPPORTED_LOCALES.map(loadLocaleCatalog));
  labelsFromCatalog("category.developerTools");
  labelsFromCatalog("payment.bankTransfer");
});

describe("config label locale contract", () => {
  it.each(fixtures)("preserves $name across UI and server locales", ({ labels, expected, key }) => {
    const stored = JSON.stringify(labels);
    for (const locale of SUPPORTED_LOCALES) {
      expect(localizedLabel(labels, locale, key ?? undefined)).toBe(expected[locale]);
    }
    expect(JSON.stringify(labels)).toBe(stored);
  });
});
