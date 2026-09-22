import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaCandidate, MediaCandidateResolveResponse } from "@/lib/api/schemas/media";
import { mediaCandidateService } from "@/services/media-candidate-service";
import type { PreparedImport } from "./import-export-model";
import { resolveAutoLogosForPreparedImport } from "./auto-logo-resolve";

vi.mock("@/services/media-candidate-service", () => ({
  mediaCandidateService: {
    resolve: vi.fn(),
  },
}));

const resolveMock = vi.mocked(mediaCandidateService.resolve);

function prepared(): PreparedImport {
  return {
    payload: {
      source: "ai",
      subscriptions: [
        {
          name: "Netflix",
          logo: null,
          price: "9.99",
          currency: "USD",
          billingCycle: "monthly",
          customDays: null,
          customCycleUnit: null,
          oneTimeTermCount: null,
          oneTimeTermUnit: null,
          category: "other",
          status: "active",
          pinned: false,
          publicHidden: false,
          paymentMethod: null,
          startDate: "2026-06-01",
          nextBillingDate: "2026-07-01",
          autoRenew: false,
          autoCalculateNextBillingDate: true,
          trialEndDate: null,
          website: "https://netflix.com/",
          notes: null,
          tags: [],
          reminderDays: 5,
          repeatReminderEnabled: false,
          repeatReminderInterval: "1h",
          repeatReminderWindow: "72h",
          extra: { import: { source: "ai", sourceId: "netflix", confidence: "high" } },
        },
        {
          name: "Unknown Tool",
          logo: null,
          price: "3",
          currency: "USD",
          billingCycle: "monthly",
          customDays: null,
          customCycleUnit: null,
          oneTimeTermCount: null,
          oneTimeTermUnit: null,
          category: "other",
          status: "active",
          pinned: false,
          publicHidden: false,
          paymentMethod: null,
          startDate: "2026-06-01",
          nextBillingDate: "2026-07-01",
          autoRenew: false,
          autoCalculateNextBillingDate: true,
          trialEndDate: null,
          website: "https://example.com/",
          notes: null,
          tags: [],
          reminderDays: 5,
          repeatReminderEnabled: false,
          repeatReminderInterval: "1h",
          repeatReminderWindow: "72h",
          extra: { import: { source: "ai", sourceId: "unknown", confidence: "low" } },
        },
      ],
    },
    assets: [],
    warnings: [],
  };
}

function candidate(overrides: Partial<MediaCandidate>): MediaCandidate {
  return {
    id: "netflix",
    kind: "logo",
    source: "builtIn",
    provider: "thesvg",
    label: "Netflix",
    variant: null,
    url: "https://cdn.example.com/netflix.svg",
    confidence: "exact",
    autoAssignable: true,
    matchedQuery: "netflix",
    rank: 0,
    ...overrides,
  };
}

function response(items: MediaCandidateResolveResponse["items"]): MediaCandidateResolveResponse {
  return { items };
}

describe("resolveAutoLogosForPreparedImport", () => {
  beforeEach(() => {
    resolveMock.mockReset();
  });

  it("auto-writes only high-confidence built-in logo candidates", async () => {
    // 自动 Logo 只能写入内置 exact/strong 命中，favicon/domain 候选必须留给用户手动确认。
    resolveMock.mockResolvedValue(response([
      {
        id: "0",
        autoCandidate: candidate({ url: "https://cdn.example.com/netflix.svg" }),
        candidates: { best: null, builtIn: [], appStore: [], favicon: [] },
      },
      {
        id: "1",
        autoCandidate: candidate({
          source: "favicon",
          provider: "favicon",
          url: "https://icons.example.com/favicon.png",
          confidence: "exact",
        }),
        candidates: { best: null, builtIn: [], appStore: [], favicon: [] },
      },
    ]));

    const resolved = await resolveAutoLogosForPreparedImport(prepared(), new AbortController().signal);

    expect(resolved.payload.subscriptions[0]?.logo).toBe("https://cdn.example.com/netflix.svg");
    expect(resolved.payload.subscriptions[1]?.logo).toBeNull();
    expect(resolved.logoAutoMatches).toEqual([{
      subscriptionIndex: 0,
      label: "Netflix",
      provider: "thesvg",
      url: "https://cdn.example.com/netflix.svg",
    }]);
  });

  it("does not auto-write weak built-in candidates", async () => {
    // 弱命中即使来自内置库也不能批量写入导入 payload，避免误把相似品牌当作真实 Logo。
    resolveMock.mockResolvedValue(response([
      {
        id: "0",
        autoCandidate: candidate({ confidence: "weak" }),
        candidates: { best: null, builtIn: [], appStore: [], favicon: [] },
      },
    ]));

    const resolved = await resolveAutoLogosForPreparedImport(prepared(), new AbortController().signal);

    expect(resolved.payload.subscriptions[0]?.logo).toBeNull();
    expect(resolved.logoAutoMatches).toBeUndefined();
  });

  it("does not treat staged payment method icons as subscription logo assets", async () => {
    resolveMock.mockResolvedValue(response([
      {
        id: "0",
        autoCandidate: candidate({ url: "https://cdn.example.com/netflix.svg" }),
        candidates: { best: null, builtIn: [], appStore: [], favicon: [] },
      },
    ]));
    const source = prepared();
    source.assets = [{
      target: { type: "paymentMethodIcon", paymentMethodIndex: 0 },
      kind: "icon",
      filename: "card.svg",
      blob: new Blob(["svg"], { type: "image/svg+xml" }),
    }];

    const signal = new AbortController().signal;
    const resolved = await resolveAutoLogosForPreparedImport(source, signal);

    expect(resolveMock).toHaveBeenCalledWith({
      kind: "logo",
      mode: "auto",
      items: [{ id: "0", name: "Netflix", website: "https://netflix.com/" }, { id: "1", name: "Unknown Tool", website: "https://example.com/" }],
      limit: 1,
    }, signal);
    expect(resolved.payload.subscriptions[0]?.logo).toBe("https://cdn.example.com/netflix.svg");
  });

  it("propagates session cancellation instead of continuing with an unmodified preview", async () => {
    const controller = new AbortController();
    resolveMock.mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });

    await expect(resolveAutoLogosForPreparedImport(prepared(), controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
  });
});
