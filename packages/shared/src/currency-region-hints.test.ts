import { describe, expect, it } from "vitest";
import { currencyRegionHints, currencyRegionHintsSchema } from "./currency-region-hints";

describe("currencyRegionHints", () => {
  it("loads versioned static data with a stable schema", () => {
    expect(currencyRegionHintsSchema.parse(currencyRegionHints)).toStrictEqual(currencyRegionHints);
    expect(currencyRegionHints.sourceVersion.ianaTimeZone).toContain("zone1970.tab");
    expect(currencyRegionHints.sourceVersion.unicodeCldr).toContain("CLDR");
    expect(currencyRegionHints.sourceVersion.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps key browser timezone mappings stable", () => {
    expect(currencyRegionHints.timeZoneTerritories["Asia/Shanghai"]).toEqual(["CN"]);
    expect(currencyRegionHints.territoryCurrencies["CN"]).toBe("CNY");
    expect(currencyRegionHints.timeZoneTerritories["America/New_York"]).toEqual(["US"]);
    expect(currencyRegionHints.territoryCurrencies["US"]).toBe("USD");
    expect(currencyRegionHints.timeZoneTerritories["Europe/London"]).toContain("GB");
    expect(currencyRegionHints.territoryCurrencies["GB"]).toBe("GBP");
  });
});
