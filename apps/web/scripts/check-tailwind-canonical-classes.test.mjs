import { describe, expect, it } from "vitest";
import { canonicalizeCandidate, loadProjectDesignSystem } from "./check-tailwind-canonical-classes.mjs";

describe("Tailwind canonical class check", () => {
  it("normalizes pixel values against the default root font size", async () => {
    const designSystem = await loadProjectDesignSystem();

    expect(canonicalizeCandidate(designSystem, "h-[220px]")).toBe("h-55");
    expect(canonicalizeCandidate(designSystem, "min-h-[126px]")).toBe("min-h-31.5");
  });

  it("keeps arbitrary values that have no canonical utility", async () => {
    const designSystem = await loadProjectDesignSystem();

    expect(canonicalizeCandidate(designSystem, "min-h-[calc(100dvh-4rem)]")).toBe(
      "min-h-[calc(100dvh-4rem)]",
    );
  });
});
