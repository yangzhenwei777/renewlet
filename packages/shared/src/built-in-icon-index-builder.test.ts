// 图标索引 builder 测试锁住上游 registry 清洗语义；运行时刷新和生成期 seed 都依赖同一套规则。
import { describe, expect, it } from "vitest";
import {
  buildBuiltInIconIndex,
  buildBuiltInIconProviderIndex,
  canonicalBuiltInIconSeedMetadataJson,
  canonicalBuiltInIconIndexJson,
  countBuiltInIconProviders,
  createBuiltInIconSearchIndex,
  createBuiltInIconSeedMetadata,
  mergeBuiltInIconSearchIndexes,
  mergeBuiltInIconProviderIndexes,
  replaceBuiltInIconProviderIndex,
  type BuiltInIconRegistryFetcher,
} from "./built-in-icon-index-builder";
import { mediaResolverConfig } from "./media-resolver-config";

describe("built-in icon index builder", () => {
  it("parses all providers and rejects unsafe paths", async () => {
    const icons = await buildBuiltInIconIndex(mediaResolverConfig, registryFetcher({
      "TheSVG registry": [
        {
          slug: "safe-app",
          title: "Safe App",
          aliases: ["Safe"],
          categories: ["Productivity"],
          variants: {
            default: "/icons/safe-app/default.svg",
            escape: "/icons/other-app/default.svg",
            "../bad": "/icons/safe-app/bad.svg",
            png: "/icons/safe-app/icon.png",
          },
          url: "https://safe.example",
        },
        {
          slug: "../unsafe",
          title: "Unsafe App",
          variants: { default: "/icons/../unsafe/default.svg" },
        },
      ],
      "selfh.st index": [
        {
          Reference: "paperless-ngx",
          Name: "Paperless-ngx",
          Category: "Documents",
          Tags: "scan, archive",
          SVG: "Yes",
          Light: "Y",
          Dark: "No",
        },
        {
          Reference: "../bad",
          Name: "Bad",
          SVG: "Yes",
        },
      ],
      "Dashboard Icons metadata": {
        homeassistant: {
          aliases: ["Home Assistant"],
          categories: ["Automation"],
          colors: {
            light: "homeassistant-light",
            dark: "../bad",
          },
        },
      },
      "Dashboard Icons tree": {
        svg: ["homeassistant.svg", "homeassistant-light.svg", "../bad.svg"],
      },
    }));

    expect(countBuiltInIconProviders(icons)).toEqual({
      thesvg: 1,
      selfhst: 1,
      dashboardIcons: 1,
    });
    expect(icons.map((icon) => icon.slug)).toEqual(["safe-app", "paperless-ngx", "homeassistant"]);
    expect(icons[0]?.variants).toEqual([{ name: "default", path: "/public/icons/safe-app/default.svg" }]);
    expect(icons[1]?.variants).toEqual([
      { name: "default", path: "/svg/paperless-ngx.svg" },
      { name: "light", path: "/svg/paperless-ngx-light.svg" },
    ]);
    expect(icons[2]?.variants).toEqual([
      { name: "default", path: "/svg/homeassistant.svg" },
      { name: "light", path: "/svg/homeassistant-light.svg" },
    ]);
  });

  it("rejects an empty remote index", async () => {
    await expect(buildBuiltInIconProviderIndex(mediaResolverConfig, "thesvg", registryFetcher({
      "TheSVG registry": [],
    }))).rejects.toThrow("thesvg built-in icon index generation produced no icons");
  });

  it("keeps canonical JSON hash stable for identical input", async () => {
    const icons = await buildBuiltInIconProviderIndex(mediaResolverConfig, "thesvg", registryFetcher({
      "TheSVG registry": [
        {
          slug: "stable",
          title: "Stable",
          variants: { default: "/icons/stable/default.svg" },
        },
      ],
    }));

    const json = canonicalBuiltInIconIndexJson(icons);
    expect(json.endsWith("\n")).toBe(true);
    expect(await sha256Hex(json)).toBe(
      await sha256Hex(canonicalBuiltInIconIndexJson(icons)),
    );
  });

  it("builds seed metadata from the generated index and provider versions", async () => {
    const icons = await buildBuiltInIconIndex(mediaResolverConfig, registryFetcher({
      "TheSVG registry": [
        {
          slug: "seed-thesvg",
          title: "Seed TheSVG",
          variants: { default: "/icons/seed-thesvg/default.svg" },
        },
      ],
      "selfh.st index": [
        {
          Reference: "seed-selfhst",
          Name: "Seed selfh.st",
          SVG: "Yes",
        },
      ],
      "Dashboard Icons metadata": {
        "seed-dashboard": {},
      },
      "Dashboard Icons tree": {
        svg: ["seed-dashboard.svg"],
      },
    }));
    const hash = await sha256Hex(canonicalBuiltInIconIndexJson(icons));
    const metadata = createBuiltInIconSeedMetadata(icons, hash, {
      thesvg: providerVersion("aaa1111222233334444"),
      selfhst: providerVersion("bbb1111222233334444"),
      dashboardIcons: providerVersion("ccc1111222233334444"),
    });

    expect(metadata).toMatchObject({
      hash,
      iconCount: 3,
      providerCounts: {
        thesvg: 1,
        selfhst: 1,
        dashboardIcons: 1,
      },
      providers: {
        thesvg: { commitShortSha: "aaa1111", commitDate: "2026-06-11T00:00:00Z" },
        selfhst: { commitShortSha: "bbb1111", commitDate: "2026-06-11T00:00:00Z" },
        dashboardIcons: { commitShortSha: "ccc1111", commitDate: "2026-06-11T00:00:00Z" },
      },
    });
    expect(canonicalBuiltInIconSeedMetadataJson(metadata).endsWith("\n")).toBe(true);
  });

  it("builds one provider with a pinned source ref and merges providers in resolver order", async () => {
    const urls: string[] = [];
    const thesvg = await buildBuiltInIconProviderIndex(mediaResolverConfig, "thesvg", async (url, label) => {
      urls.push(url);
      return registryFetcher({
        "TheSVG registry": [
          {
            slug: "pinned",
            title: "Pinned",
            variants: { default: "/icons/pinned/default.svg" },
          },
        ],
      })(url, label);
    }, {
      provider: "thesvg",
      cdnBase: "https://testingcf.jsdelivr.net/gh/glincker/thesvg@abc1234",
    });
    const selfhst = await buildBuiltInIconProviderIndex(mediaResolverConfig, "selfhst", registryFetcher({
      "selfh.st index": [
        {
          Reference: "later",
          Name: "Later",
          SVG: "Yes",
        },
      ],
    }));

    expect(urls[0]).toBe("https://testingcf.jsdelivr.net/gh/glincker/thesvg@abc1234/src/data/icons.json");
    expect(mergeBuiltInIconProviderIndexes({ selfhst, thesvg }).map((icon) => icon.provider)).toEqual(["thesvg", "selfhst"]);
  });

  it("merges refreshed provider search indexes with seed provider fallbacks", async () => {
    const seed = await buildBuiltInIconIndex(mediaResolverConfig, registryFetcher({
      "TheSVG registry": [
        {
          slug: "seed-thesvg",
          title: "Seed TheSVG",
          variants: { default: "/icons/seed-thesvg/default.svg" },
        },
      ],
      "selfh.st index": [
        {
          Reference: "seed-selfhst",
          Name: "Seed selfh.st",
          SVG: "Yes",
        },
      ],
      "Dashboard Icons metadata": {
        "seed-dashboard": {},
      },
      "Dashboard Icons tree": {
        svg: ["seed-dashboard.svg"],
      },
    }));
    const dashboard = await buildBuiltInIconProviderIndex(mediaResolverConfig, "dashboardIcons", registryFetcher({
      "Dashboard Icons metadata": {
        "fresh-dashboard": {
          aliases: ["Fresh Dash"],
        },
      },
      "Dashboard Icons tree": {
        svg: ["fresh-dashboard.svg"],
      },
    }));

    const merged = mergeBuiltInIconSearchIndexes({
      dashboardIcons: createBuiltInIconSearchIndex(dashboard),
    }, createBuiltInIconSearchIndex(seed));

    expect(merged.entries.map((entry) => `${entry.p}:${entry.s}`)).toEqual([
      "thesvg:seed-thesvg",
      "selfhst:seed-selfhst",
      "dashboardIcons:fresh-dashboard",
    ]);
    expect(merged.canonicalExact["fresh dashboard"]).toEqual([2]);
    expect(merged.tokenExact["fresh"]).toEqual([2]);
  });

  it("replaces only the requested provider index", async () => {
    const original = await buildBuiltInIconIndex(mediaResolverConfig, registryFetcher({
      "TheSVG registry": [
        {
          slug: "old-thesvg",
          title: "Old TheSVG",
          variants: { default: "/icons/old-thesvg/default.svg" },
        },
      ],
      "selfh.st index": [
        {
          Reference: "keep-selfhst",
          Name: "Keep selfh.st",
          SVG: "Yes",
        },
      ],
      "Dashboard Icons metadata": {
        "keep-dashboard": {},
      },
      "Dashboard Icons tree": {
        svg: ["keep-dashboard.svg"],
      },
    }));
    const replacement = await buildBuiltInIconProviderIndex(mediaResolverConfig, "thesvg", registryFetcher({
      "TheSVG registry": [
        {
          slug: "new-thesvg",
          title: "New TheSVG",
          variants: { default: "/icons/new-thesvg/default.svg" },
        },
      ],
    }));

    expect(replaceBuiltInIconProviderIndex(original, "thesvg", replacement).map((icon) => icon.slug)).toEqual([
      "new-thesvg",
      "keep-selfhst",
      "keep-dashboard",
    ]);
  });
});

function registryFetcher(registries: Record<string, unknown>): BuiltInIconRegistryFetcher {
  return async (_url, label) => {
    if (!(label in registries)) {
      throw new Error(`missing registry fixture: ${label}`);
    }
    return registries[label];
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function providerVersion(commitSha: string) {
  return {
    sourceRef: commitSha,
    displayVersion: commitSha.slice(0, 7),
    commitSha,
    commitShortSha: commitSha.slice(0, 7),
    commitDate: "2026-06-11T00:00:00Z",
    releaseTag: null,
    releasePublishedAt: null,
  };
}
