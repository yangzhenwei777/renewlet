// Worker 媒体候选测试保护 App Store 在线来源只走服务端代理、设置开关和 Cache API 命中。
import { createMediaResolver } from "@renewlet/shared/media-resolver";
import { mediaResolverConfig } from "@renewlet/shared/media-resolver-config";
import { mediaCandidateResolvePayloadSchema } from "@renewlet/shared/schemas/media";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { searchAppStoreIconCandidates } from "./app-store-icons";
import { mediaCandidates } from "./search";
import type { Env } from "./types";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getSettings: vi.fn(),
  getActiveBuiltInMediaResolver: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: mocks.requireAuth,
}));

vi.mock("./db", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("./media-icon-index", () => ({
  getActiveBuiltInMediaResolver: mocks.getActiveBuiltInMediaResolver,
}));

const env = {
  DB: {} as D1Database,
  ASSETS: {} as Fetcher,
  ASSETS_BUCKET: {} as R2Bucket,
} as Env;

function mediaRequest(body: unknown): Request {
  return new Request("https://renewlet.example/api/app/media/candidates", {
    method: "POST",
    headers: {
      authorization: "Bearer session",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function appleSearchResponse(trackName: string, trackId: number, artworkUrl512: string): Response {
  return Response.json({
    resultCount: 1,
    results: [{
      trackId,
      trackName,
      sellerName: "Renewlet",
      bundleId: `app.renewlet.${trackId}`,
      artworkUrl512,
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/fallback100.png",
      artworkUrl60: "https://is1-ssl.mzstatic.com/image/fallback60.png",
      trackViewUrl: `https://apps.apple.com/app/id${trackId}`,
    }],
  });
}

describe("Cloudflare media candidates", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("caches", undefined);
    mocks.requireAuth.mockReset().mockResolvedValue({
      token: "session",
      user: { id: "usr_media" },
      session: { id: "ses" },
    });
    mocks.getSettings.mockReset().mockResolvedValue(createDefaultAppSettings());
    mocks.getActiveBuiltInMediaResolver.mockReset().mockResolvedValue(createMediaResolver([], mediaResolverConfig));
  });

  it("adds App Store candidates between built-in and favicon for manual Logo search", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://itunes.apple.com/search");
      expect(url.searchParams.get("media")).toBe("software");
      expect(url.searchParams.get("entity")).toBe("software");
      expect(url.searchParams.get("limit")).toBe("3");
      expect(url.searchParams.get("country")).toBe("us");
      return appleSearchResponse("Renewlet Mobile", 100, "https://is1-ssl.mzstatic.com/image/us.png");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await mediaCandidates(mediaRequest({
      kind: "logo",
      mode: "search",
      items: [{ id: "renewlet-mobile", name: "Renewlet Mobile" }],
      limit: 5,
    }), env);

    expect(response.status).toBe(200);
    const data = mediaCandidateResolvePayloadSchema.parse(await readSuccessData(response));
    const item = data.items[0];
    expect(item?.autoCandidate).toBeNull();
    expect(item?.candidates.appStore).toHaveLength(1);
    expect(item?.candidates.appStore[0]).toMatchObject({
      source: "appStore",
      provider: "appStore",
      url: "https://is1-ssl.mzstatic.com/image/us.png",
      autoAssignable: false,
    });
    expect(item?.candidates.best?.id).toBe(item?.candidates.appStore[0]?.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the App Store storefronts selected in settings", async () => {
    for (const storefronts of [["cn"], ["us", "cn"]] as const) {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        const country = url.searchParams.get("country");
        return appleSearchResponse("Renewlet Mobile", country === "us" ? 100 : 101, `https://is1-ssl.mzstatic.com/image/${country}.png`);
      });
      vi.stubGlobal("fetch", fetchMock);
      mocks.getSettings.mockResolvedValue({
        ...createDefaultAppSettings(),
        onlineIconSources: { appStore: { enabled: true, storefronts: [...storefronts] } },
      });

      const response = await mediaCandidates(mediaRequest({
        kind: "logo",
        mode: "search",
        items: [{ id: "renewlet-mobile", name: "Renewlet Mobile" }],
        limit: 5,
      }), env);

      expect(response.status).toBe(200);
      const countries = fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("country")).sort();
      expect(countries).toEqual([...storefronts].sort());
    }
  });

  it("does not call Apple when App Store is disabled", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getSettings.mockResolvedValue({
      ...createDefaultAppSettings(),
      onlineIconSources: { appStore: { enabled: false, storefronts: ["us"] } },
    });

    const response = await mediaCandidates(mediaRequest(
      { kind: "logo", mode: "search", items: [{ id: "disabled", name: "Renewlet Mobile" }], limit: 5 },
    ), env);
    expect(response.status).toBe(200);
    const data = mediaCandidateResolvePayloadSchema.parse(await readSuccessData(response));
    expect(data.items[0]?.candidates.appStore).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call Apple when the request is not manual Logo search", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    for (const body of [
      { kind: "logo", mode: "auto", items: [{ id: "auto", name: "Renewlet Mobile" }], limit: 5 },
      { kind: "icon", mode: "search", items: [{ id: "icon", name: "Renewlet Mobile" }], limit: 5 },
    ]) {
      const response = await mediaCandidates(mediaRequest(body), env);
      expect(response.status).toBe(200);
      const data = mediaCandidateResolvePayloadSchema.parse(await readSuccessData(response));
      expect(data.items[0]?.candidates.appStore).toEqual([]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call Apple for batch search requests", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mediaCandidates(mediaRequest({
      kind: "logo",
      mode: "search",
      items: [
        { id: "one", name: "Renewlet Mobile" },
        { id: "two", name: "Another Mobile" },
      ],
      limit: 5,
    }), env);

    expect(response.status).toBe(200);
    const data = mediaCandidateResolvePayloadSchema.parse(await readSuccessData(response));
    expect(data.items).toHaveLength(2);
    expect(data.items.every((item) => item.candidates.appStore.length === 0)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the media candidate route available when Apple fails", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("rate limited", { status: 429 })));

    const response = await mediaCandidates(mediaRequest({
      kind: "logo",
      mode: "search",
      items: [{ id: "apple-failure", name: "Renewlet Mobile" }],
      limit: 5,
    }), env);

    expect(response.status).toBe(200);
    const data = mediaCandidateResolvePayloadSchema.parse(await readSuccessData(response));
    expect(data.items[0]?.candidates.appStore).toEqual([]);
    expect(data.items[0]?.candidates.favicon.length).toBeGreaterThan(0);
  });
});

describe("App Store icon provider Cache API", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses caches.default for fresh App Store narrow results", async () => {
    const cache = new MemoryCache();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const country = new URL(String(input)).searchParams.get("country");
      return appleSearchResponse("Cache App", country === "us" ? 300 : 301, `https://is1-ssl.mzstatic.com/image/cache-${country}.png`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { default: cache as unknown as Cache });

    const first = await searchAppStoreIconCandidates("logo", "Cache App", 4, ["us", "cn"]);
    const second = await searchAppStoreIconCandidates("logo", "Cache App", 4, ["us", "cn"]);

    expect(first.map((candidate) => candidate.url)).toEqual(second.map((candidate) => candidate.url));
    expect(first).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cache.putCalls).toBe(2);
    expect(cache.matchCalls).toBe(4);
  });

  it("ignores non-Apple CDN artwork URLs from Apple metadata", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const country = new URL(String(input)).searchParams.get("country");
      return Response.json({
        resultCount: 2,
        results: [
          {
            trackId: country === "us" ? 400 : 401,
            trackName: "Safe App",
            artworkUrl512: "https://example.com/not-apple.png",
          },
          {
            trackId: country === "us" ? 500 : 501,
            trackName: "Safe App",
            artworkUrl100: `https://is1-ssl.mzstatic.com/image/safe-${country}.png`,
          },
        ],
      });
    }));

    const candidates = await searchAppStoreIconCandidates("logo", "Safe App", 4, ["us", "cn"]);

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => new URL(candidate.url).hostname.endsWith("mzstatic.com"))).toBe(true);
  });
});

class MemoryCache {
  // 只模拟 caches.default 的 match/put 克隆语义，避免测试依赖真实 Cloudflare 数据中心缓存行为。
  readonly store = new Map<string, Response>();
  matchCalls = 0;
  putCalls = 0;

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    this.matchCalls += 1;
    return this.store.get(cacheKey(request))?.clone();
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.putCalls += 1;
    this.store.set(cacheKey(request), response.clone());
  }

  async add(): Promise<void> {
    throw new Error("not implemented");
  }

  async addAll(): Promise<void> {
    throw new Error("not implemented");
  }

  async delete(): Promise<boolean> {
    throw new Error("not implemented");
  }

  async keys(): Promise<readonly Request[]> {
    throw new Error("not implemented");
  }
}

function cacheKey(request: RequestInfo | URL): string {
  if (request instanceof Request) return request.url;
  if (request instanceof URL) return request.toString();
  return String(request);
}
