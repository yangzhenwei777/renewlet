// media-resolver 测试保护内置图标索引与 shared resolver 配置的匹配口径，避免自动候选排序漂移。
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  clampMediaCandidateLimit,
  createMediaResolver,
  createMediaResolverFromSearchIndex,
  resolveMediaCandidateItem,
  type BuiltInIcon,
  type BuiltInIconSearchIndex,
} from "@renewlet/shared/media-resolver";
import { DEFAULT_BUILT_IN_ICON_SOURCES } from "@renewlet/shared/built-in-icons";
import { mediaResolverConfig } from "@renewlet/shared/media-resolver-config";
import { mediaResolverFixtures } from "@renewlet/shared/media-resolver-fixtures";
import { mediaCandidateResolveResponseSchema } from "@/lib/api/schemas/media";

const builtInIconSearchIndex = JSON.parse(
  gunzipSync(readFileSync(path.resolve(process.cwd(), "public/built-in-icons/search-index.json.gz"))).toString("utf8"),
) as BuiltInIconSearchIndex;
const resolver = createMediaResolverFromSearchIndex(builtInIconSearchIndex, mediaResolverConfig);
const success = <T>(data: T) => ({ ok: true, data });

describe("shared media resolver", () => {
  it("matches fixture expectations and keeps responses inside the shared schema", () => {
    for (const fixture of mediaResolverFixtures) {
      const item = resolveMediaCandidateItem(
        resolver,
        fixture.kind,
        fixture.mode,
        {
          id: fixture.id,
          name: fixture.name,
          ...(fixture.website ? { website: fixture.website } : {}),
        },
        clampMediaCandidateLimit(mediaResolverConfig, fixture.limit),
      );

      mediaCandidateResolveResponseSchema.parse(success({ items: [item] }));
      if ("expectedAutoLabel" in fixture) {
        expect(item.autoCandidate?.label ?? null, fixture.id).toBe(fixture.expectedAutoLabel);
      }
      if (fixture.expectedFirstBuiltInLabel) {
        expect(item.candidates.builtIn[0]?.label, fixture.id).toBe(fixture.expectedFirstBuiltInLabel);
      }
      if (fixture.expectedMatchedQuery) {
        const candidate = fixture.mode === "auto" ? item.autoCandidate : item.candidates.builtIn[0];
        expect(candidate?.matchedQuery, fixture.id).toBe(fixture.expectedMatchedQuery);
      }
      if (fixture.expectedFirstFaviconProvider) {
        if (!fixture.expectedFirstBuiltInLabel) {
          expect(item.candidates.builtIn, fixture.id).toHaveLength(0);
        }
        expect(item.candidates.favicon[0]?.provider, fixture.id).toBe(fixture.expectedFirstFaviconProvider);
      }
      if (fixture.expectedFirstFaviconLabel) {
        expect(item.candidates.favicon[0]?.label, fixture.id).toBe(fixture.expectedFirstFaviconLabel);
      }
      if (fixture.expectedFaviconAutoAssignable !== undefined) {
        expect(item.candidates.favicon[0]?.autoAssignable, fixture.id).toBe(fixture.expectedFaviconAutoAssignable);
      }
    }
  });

  it("expands built-in variants for manual search while auto keeps the preferred default", () => {
    const searchItem = resolveMediaCandidateItem(
      resolver,
      "logo",
      "search",
      { id: "google-search", name: "Google" },
      8,
    );
    const googleVariants = searchItem.candidates.builtIn.filter((candidate) => candidate.label === "Google" && candidate.provider === "thesvg");

    expect(googleVariants.map((candidate) => candidate.variant)).toEqual(["default", "mono", "wordmark"]);
    expect(googleVariants.map((candidate) => candidate.id)).toEqual([
      "builtin:thesvg:google:default",
      "builtin:thesvg:google:mono",
      "builtin:thesvg:google:wordmark",
    ]);
    expect(googleVariants.map((candidate) => candidate.url)).toEqual([
      "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google/default.svg",
      "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google/mono.svg",
      "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google/wordmark.svg",
    ]);
    expect(searchItem.candidates.best).toEqual(googleVariants[0]);

    const autoItem = resolveMediaCandidateItem(
      resolver,
      "logo",
      "auto",
      { id: "google-auto", name: "Google" },
      8,
    );

    expect(autoItem.candidates.builtIn).toHaveLength(1);
    expect(autoItem.autoCandidate?.variant).toBe("default");
    expect(autoItem.autoCandidate?.id).toBe("builtin:thesvg:google:default");
  });

  it("filters built-in providers and variants by settings", () => {
    const selfhstOnly = {
      thesvg: { enabled: false, variantsEnabled: true },
      selfhst: { enabled: true, variantsEnabled: false },
      dashboardIcons: { enabled: false, variantsEnabled: true },
    };
    const item = resolveMediaCandidateItem(
      resolver,
      "logo",
      "search",
      { id: "actual-budget", name: "Actual Budget" },
      8,
      { sources: selfhstOnly },
    );

    expect(item.candidates.builtIn).not.toHaveLength(0);
    expect(item.candidates.builtIn.every((candidate) => candidate.provider === "selfhst")).toBe(true);
    expect(item.candidates.builtIn.map((candidate) => candidate.variant)).toEqual(["default"]);

    const allSources = resolveMediaCandidateItem(
      resolver,
      "logo",
      "search",
      { id: "actual-budget-all", name: "Actual Budget" },
      8,
      { sources: DEFAULT_BUILT_IN_ICON_SOURCES },
    );
    expect(allSources.candidates.builtIn.some((candidate) => candidate.provider === "selfhst" && candidate.variant === "light")).toBe(true);
  });

  it("uses the reduced built-in match as the favicon fallback query", () => {
    const syntheticResolver = createMediaResolver([
      {
        provider: "thesvg",
        slug: "acme",
        title: "Acme",
        variants: [{ name: "default", path: "/public/icons/acme/default.svg" }],
        exactKeys: ["acme"],
        tokenKeys: ["acme"],
      },
    ], mediaResolverConfig);

    const item = resolveMediaCandidateItem(
      syntheticResolver,
      "logo",
      "search",
      { id: "synthetic-long-plan", name: "Acme Alpha Beta Gamma" },
      8,
    );

    expect(item.candidates.builtIn[0]?.label).toBe("Acme");
    expect(item.candidates.builtIn[0]?.matchedQuery).toBe("acme");
    expect(item.candidates.favicon[0]?.label).toBe("acme.com");
    expect(item.candidates.favicon[0]?.autoAssignable).toBe(false);
  });

  it("reserves favicon fallback budget when built-in variants fill the search limit", () => {
    const syntheticIcons: BuiltInIcon[] = Array.from({ length: 8 }, (_, index) => ({
      provider: "thesvg",
      slug: `acme-${index}`,
      title: `Acme ${index}`,
      variants: [
        { name: "default", path: `/public/icons/acme-${index}/default.svg` },
        { name: "mono", path: `/public/icons/acme-${index}/mono.svg` },
      ],
      tokenKeys: ["acme"],
    }));
    const syntheticResolver = createMediaResolver(syntheticIcons, mediaResolverConfig);
    const limit = 8;
    const item = resolveMediaCandidateItem(
      syntheticResolver,
      "logo",
      "search",
      { id: "synthetic-many-built-in", name: "Acme" },
      limit,
    );

    expect(item.candidates.builtIn).toHaveLength(limit - mediaResolverConfig.candidateGroups.searchFaviconReserve);
    expect(item.candidates.favicon).toHaveLength(mediaResolverConfig.candidateGroups.searchFaviconReserve);
    expect(item.candidates.favicon[0]?.label).toBe("acme.com");
    expect(item.candidates.best).toEqual(item.candidates.builtIn[0]);
  });

  it("uses explicit URL domains before stored websites and expands direct favicon paths", () => {
    const syntheticResolver = createMediaResolver([], mediaResolverConfig);
    const item = resolveMediaCandidateItem(
      syntheticResolver,
      "logo",
      "search",
      {
        id: "explicit-url",
        name: "https://query.example/pricing",
        website: "https://stored.example",
      },
      5,
    );

    expect(item.candidates.favicon.map((candidate) => candidate.url)).toEqual([
      "https://query.example/favicon.ico",
      "https://query.example/favicon.svg",
      "https://query.example/icon.svg",
      "https://query.example/icon-32x32.png",
      "https://query.example/apple-touch-icon.png",
    ]);
    expect(item.candidates.favicon.every((candidate) => candidate.autoAssignable === false)).toBe(true);
  });

  it("keeps guessed favicon domains on the compact fallback provider budget", () => {
    const syntheticResolver = createMediaResolver([], mediaResolverConfig);
    const item = resolveMediaCandidateItem(
      syntheticResolver,
      "logo",
      "search",
      { id: "guessed-domain", name: "Acme" },
      4,
    );

    expect(item.candidates.favicon.map((candidate) => candidate.url)).toEqual([
      "https://acme.com/favicon.ico",
      "https://acme.com/apple-touch-icon.png",
      "https://www.google.com/s2/favicons?domain=acme.com&sz=128",
      "https://icons.duckduckgo.com/ip3/acme.com.ico",
    ]);
  });
});
