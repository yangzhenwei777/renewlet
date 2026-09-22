import { describe, expect, it } from "vitest";
import { canonicalizeMoneyString, moneyStringSchema } from "./money";

describe("moneyStringSchema", () => {
  it("canonicalizes decimal strings at the shared write boundary", () => {
    expect(moneyStringSchema.parse("0012.340000")).toBe("12.34");
    expect(moneyStringSchema.parse("0.100000")).toBe("0.1");
    expect(canonicalizeMoneyString("1000000000.000000")).toBe("1000000000");
  });

  it("rejects non-canonicalizable money payloads", () => {
    expect(() => moneyStringSchema.parse(12)).toThrow();
    expect(() => moneyStringSchema.parse("1e3")).toThrow();
    expect(() => moneyStringSchema.parse(".5")).toThrow();
    expect(() => moneyStringSchema.parse("1.1234567")).toThrow();
    expect(() => moneyStringSchema.parse("1000000000.000001")).toThrow();
  });
});
