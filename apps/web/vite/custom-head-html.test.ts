import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  customHeadHTMLMaxBytes,
  parseCustomHeadHTML,
  transformCustomHeadHTML,
  trustedExtensionContentSecurityPolicy,
  updateCustomHeadHTMLStaticHeaders,
} from "./custom-head-html";

type FixtureCase = {
  name: string;
  raw?: string;
  repeat?: { prefix: string; value: string; count: number; suffix: string };
  valid: boolean;
  enabled: boolean;
};

type FixtureSet = {
  maxBytes: number;
  cases: FixtureCase[];
};

const fixtures = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "../../packages/shared/src/contract-fixtures/custom-head-html-fixtures.json"), "utf8"),
) as FixtureSet;

function fixtureValue(fixture: FixtureCase): string {
  if (!fixture.repeat) return fixture.raw ?? "";
  return fixture.repeat.prefix + fixture.repeat.value.repeat(fixture.repeat.count) + fixture.repeat.suffix;
}

describe("parseCustomHeadHTML", () => {
  it("matches the shared Go and Vite fixtures", () => {
    expect(fixtures.maxBytes).toBe(customHeadHTMLMaxBytes);
    for (const fixture of fixtures.cases) {
      const raw = fixtureValue(fixture);
      if (!fixture.valid) {
        expect(() => parseCustomHeadHTML(raw), fixture.name).toThrow();
        continue;
      }
      const parsed = parseCustomHeadHTML(raw);
      expect(Boolean(parsed), fixture.name).toBe(fixture.enabled);
      if (fixture.enabled) expect(parsed?.markup, fixture.name).toBe(raw);
    }
  });

  it("measures the limit in UTF-8 bytes", () => {
    const prefix = `<meta name="description" content="`;
    const suffix = `">`;
    const withinLimit = prefix + "续".repeat(Math.floor((customHeadHTMLMaxBytes - prefix.length - suffix.length) / 3)) + suffix;
    expect(new TextEncoder().encode(withinLimit).byteLength).toBeLessThanOrEqual(customHeadHTMLMaxBytes);
    expect(parseCustomHeadHTML(withinLimit)?.markup).toBe(withinLimit);
    expect(() => parseCustomHeadHTML(withinLimit + "续")).toThrow(/64 KiB/);
  });

  it("rejects a JavaScript string that cannot represent valid UTF-8 source text", () => {
    expect(() => parseCustomHeadHTML("\ud800")).toThrow(/UTF-8/);
  });
});

describe("transformCustomHeadHTML", () => {
  const indexHTML = "<!doctype html><html><head><title>Renewlet</title></head><body></body></html>";

  it("injects the complete Clarity loader verbatim for Vite dev and Cloudflare builds", () => {
    const fixture = fixtures.cases.find((item) => item.name === "clarity loader");
    const raw = fixtureValue(fixture!);
    const transformed = transformCustomHeadHTML(indexHTML, parseCustomHeadHTML(raw));

    expect(transformed).toContain(raw);
    expect(transformed.indexOf(raw)).toBeLessThan(transformed.indexOf("</head>"));
  });

  it("does not inject twice when Vite transforms the same document again", () => {
    const customHeadHTML = parseCustomHeadHTML(`<script>window.__loaded = true;</script>`);
    const once = transformCustomHeadHTML(indexHTML, customHeadHTML);
    const twice = transformCustomHeadHTML(once, customHeadHTML);

    expect(twice).toBe(once);
    expect(twice.match(/window\.__loaded/g)).toHaveLength(1);
  });

  it("keeps the document unchanged when custom head HTML is empty", () => {
    expect(transformCustomHeadHTML(indexHTML, parseCustomHeadHTML(""))).toBe(indexHTML);
  });

  it("rejects a Vite host document without an explicit head", () => {
    const customHeadHTML = parseCustomHeadHTML(`<script>window.__loaded = true;</script>`);
    expect(() => transformCustomHeadHTML("<html><body>Renewlet</body></html>", customHeadHTML)).toThrow(/explicit head/);
  });
});

describe("updateCustomHeadHTMLStaticHeaders", () => {
  const headers = [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'",
    "  Cache-Control: no-cache",
    "",
    "/assets/*",
    "  ! Cache-Control",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n");

  it("switches the Cloudflare build to the HTTPS trusted-extension CSP", () => {
    const customHeadHTML = parseCustomHeadHTML(`<script>window.__loaded = true;</script>`);
    const updated = updateCustomHeadHTMLStaticHeaders(headers, customHeadHTML);

    expect(updated).toContain(`Content-Security-Policy: ${trustedExtensionContentSecurityPolicy(true)}`);
    expect(updated).not.toContain("script-src");
    expect(updated).not.toContain("connect-src");
    expect(updated).toContain("/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable");
  });

  it("uses the structural policy without HTTPS upgrading in Vite dev", () => {
    expect(trustedExtensionContentSecurityPolicy(false)).toBe(
      "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
  });

  it("keeps the strict Cloudflare headers unchanged for an empty configuration", () => {
    expect(updateCustomHeadHTMLStaticHeaders(headers, undefined)).toBe(headers);
  });
});
