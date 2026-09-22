import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { assetService } from "./asset-service";
import { customConfigService } from "./custom-config-service";
import { settingsService } from "./settings-service";
import {
  appSettingsSecretStatus,
  type ApiAppSettings,
  settingsUpdateBodySchema,
  toPublicAppSettings,
} from "@/lib/api/schemas/settings";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  getCurrentUserId: vi.fn(() => "user_1"),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
}));

vi.mock("@/lib/pocketbase", () => ({
  pb: {
    lang: "zh-CN",
    beforeSend: undefined,
  },
  getCurrentUserId: mocks.getCurrentUserId,
}));

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.getCurrentUserId.mockReturnValue("user_1");
});

describe("product API services", () => {
  it("loads and saves settings through /api/app/settings", async () => {
    // settings 服务是 Docker/Cloudflare 共用边界，测试防止前端回退到 PocketBase collection REST。
    const storedSettings: ApiAppSettings = {
      ...DEFAULT_SETTINGS,
      testPhone: "8613800000000",
      telegramBotToken: "telegram-secret",
      aiRecognition: {
        ...DEFAULT_SETTINGS.aiRecognition,
        model: "gpt-5-mini",
        modelInputMode: "manual",
        apiKey: "ai-secret",
      },
    };
    mocks.apiFetch.mockResolvedValue({
      settings: toPublicAppSettings(storedSettings),
      secretStatus: appSettingsSecretStatus(storedSettings),
    });

    const loaded = await settingsService.get();
    await settingsService.update(DEFAULT_SETTINGS, { monthlyBudget: "2000" });

    expect(loaded.settings.testPhone).toBe("8613800000000");
    expect(loaded.settings.aiRecognition.model).toBe("gpt-5-mini");
    expect(loaded.settings.telegramBotToken).toBe("");
    expect(loaded.settings.aiRecognition.apiKey).toBe("");
    expect(loaded.secretStatus.telegramBotToken.configured).toBe(true);
    expect(loaded.secretStatus["aiRecognition.apiKey"].configured).toBe(true);

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/settings");
    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/settings");
    expect(mocks.apiFetch.mock.calls[1]?.[2]).toMatchObject({ method: "PUT" });
    const rawUpdateBody: unknown = JSON.parse(String((mocks.apiFetch.mock.calls[1]?.[2] as RequestInit | undefined)?.body));
    const updateBody = settingsUpdateBodySchema.parse(rawUpdateBody);
    expect(updateBody.secretUpdates).toEqual({});
    expect(updateBody).not.toHaveProperty("telegramBotToken");
    expect(updateBody.aiRecognition).not.toHaveProperty("apiKey");
    for (const [url] of mocks.apiFetch.mock.calls) {
      expect(String(url)).not.toContain("/api/collections/settings/records");
    }
  });

  it("loads and saves custom config through /api/app/custom-config", async () => {
    // custom config 同样必须走产品 API，Cloudflare 运行面没有 PocketBase collection endpoint。
    const emptyConfig = { categories: [], statuses: [], paymentMethods: [], currencies: [] };
    mocks.apiFetch.mockResolvedValue({ config: emptyConfig });

    const loadedConfig = await customConfigService.get(new AbortController().signal);
    const savedConfig = await customConfigService.save(DEFAULT_CUSTOM_CONFIG);

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/custom-config");
    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/custom-config");
    expect(mocks.apiFetch.mock.calls[1]?.[2]).toMatchObject({ method: "PUT" });
    expect(loadedConfig?.currencies.slice(0, 4).map((currency) => currency.value)).toEqual([
      "CNY", "USD", "EUR", "GBP",
    ]);
    expect(savedConfig.currencies.slice(0, 4).map((currency) => currency.value)).toEqual([
      "CNY", "USD", "EUR", "GBP",
    ]);
    for (const [url] of mocks.apiFetch.mock.calls) {
      expect(String(url)).not.toContain("/api/collections/custom_configs/records");
    }
  });

  it("uploads and lists assets through /api/app/assets", async () => {
    // 上传资产只能通过受控代理 URL 暴露，测试固定前端不依赖 PocketBase 文件路径或 R2 key。
    mocks.apiFetch
      .mockResolvedValueOnce({ url: "/api/app/assets/asset_1" })
      .mockResolvedValueOnce({
        items: [{ id: "asset_1", url: "/api/app/assets/asset_1", kind: "logo" }],
        page: 1,
        totalPages: 1,
      })
      .mockResolvedValueOnce({
        items: [{ id: "asset_2", url: "/api/app/assets/asset_2", kind: "icon" }],
        page: 2,
        totalPages: 3,
      })
      .mockResolvedValueOnce({});

    await assetService.create(new Blob(["logo"], { type: "image/png" }), "logo", "logo.png");
    await assetService.list("logo", 1);
    await assetService.list("icon", 2);
    await assetService.delete("asset_1");

    const uploadInit = mocks.apiFetch.mock.calls[0]?.[2] as RequestInit | undefined;
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/assets");
    expect(uploadInit).toMatchObject({ method: "POST" });
    expect(uploadInit?.body).toBeInstanceOf(FormData);
    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/assets?kind=logo&page=1&perPage=48");
    expect(mocks.apiFetch.mock.calls[2]?.[0]).toBe("/api/app/assets?kind=icon&page=2&perPage=48");
    expect(mocks.apiFetch.mock.calls[3]?.[0]).toBe("/api/app/assets/asset_1");
    expect(mocks.apiFetch.mock.calls[3]?.[2]).toMatchObject({ method: "DELETE" });
    for (const [url] of mocks.apiFetch.mock.calls) {
      expect(String(url)).not.toContain("/api/collections/assets/records");
    }
  });
});
