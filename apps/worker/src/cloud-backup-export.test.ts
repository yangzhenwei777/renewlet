import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { apiSubscriptionSchema, type ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCloudBackupExportZip } from "./cloud-backup-export";
import type { AssetRow, Env } from "./types";

const dbMocks = vi.hoisted(() => ({
  getAsset: vi.fn(),
  getCustomConfig: vi.fn(),
  getSettings: vi.fn(),
  listSubscriptions: vi.fn(),
  toApiSubscription: vi.fn(),
}));
const snapshotMocks = vi.hoisted(() => ({
  listExchangeRateSnapshots: vi.fn(),
}));

vi.mock("./db", () => ({
  getAsset: dbMocks.getAsset,
  getCustomConfig: dbMocks.getCustomConfig,
  getSettings: dbMocks.getSettings,
  listSubscriptions: dbMocks.listSubscriptions,
  toApiSubscription: dbMocks.toApiSubscription,
}));

vi.mock("./exchange-rate-snapshots", () => ({
  listExchangeRateSnapshots: snapshotMocks.listExchangeRateSnapshots,
}));

describe("Cloudflare cloud backup export ZIP", () => {
  beforeEach(() => {
    dbMocks.getAsset.mockReset().mockResolvedValue(null);
    dbMocks.getCustomConfig.mockReset().mockResolvedValue({ categories: [], statuses: [], paymentMethods: [], currencies: [] });
    dbMocks.getSettings.mockReset().mockResolvedValue(createDefaultAppSettings());
    dbMocks.listSubscriptions.mockReset().mockResolvedValue([]);
    dbMocks.toApiSubscription.mockReset().mockImplementation((row: ApiSubscription) => row);
    snapshotMocks.listExchangeRateSnapshots.mockReset().mockResolvedValue([]);
  });

  it("removes subscription logos when D1 metadata exists but the R2 object is missing", async () => {
    dbMocks.listSubscriptions.mockResolvedValue([subscriptionFixture({ logo: "/api/app/assets/asset_logo" })]);
    dbMocks.getAsset.mockResolvedValue(assetRow({ id: "asset_logo", r2_key: "missing/logo.svg" }));

    const { content } = await buildCloudBackupExportZip(envWithR2({}), "usr_cloud");
    const data = readStoredZipJson(content, "data.json");
    const manifest = readStoredZipJson(content, "manifest.json");

    expect(data.data.subscriptions[0]).not.toHaveProperty("logo");
    expect(manifest.missingAssets).toEqual([{
      assetId: "asset_logo",
      path: "/api/app/assets/asset_logo",
      reference: "subscription.logo",
      referenceId: "sub_1",
      reason: "file_missing",
    }]);
  });

  it("exports payment method icons and audits only missing R2 objects", async () => {
    dbMocks.getCustomConfig.mockResolvedValue({
      categories: [],
      statuses: [],
      paymentMethods: [
        { id: "pm_ok", value: "card", labels: { "zh-CN": "Card", "en-US": "Card" }, icon: "/api/app/assets/asset_icon" },
        { id: "pm_missing", value: "wallet", labels: { "zh-CN": "Wallet", "en-US": "Wallet" }, icon: "/api/app/assets/asset_missing" },
      ],
      currencies: [],
    });
    dbMocks.getAsset.mockImplementation(async (_env: Env, _userId: string, assetId: string) => (
      assetId === "asset_icon"
        ? assetRow({ id: "asset_icon", r2_key: "icons/card.svg" })
        : assetRow({ id: "asset_missing", r2_key: "icons/missing.svg" })
    ));

    const { content } = await buildCloudBackupExportZip(envWithR2({ "icons/card.svg": "<svg />" }), "usr_cloud");
    const data = readStoredZipJson(content, "data.json");
    const manifest = readStoredZipJson(content, "manifest.json");

    expect(data.data.customConfig.paymentMethods[0].icon).toBe("assets/asset_icon.svg");
    expect(data.data.customConfig.paymentMethods[1]).not.toHaveProperty("icon");
    expect(readStoredZipText(content, "assets/asset_icon.svg")).toBe("<svg />");
    expect(manifest.assets).toBe(1);
    expect(manifest.missingAssets).toEqual([{
      assetId: "asset_missing",
      path: "/api/app/assets/asset_missing",
      reference: "customConfig.paymentMethods.icon",
      referenceId: "pm_missing",
      reason: "file_missing",
    }]);
  });

  it("includes exchange rate snapshots in the recoverable data payload", async () => {
    snapshotMocks.listExchangeRateSnapshots.mockResolvedValue([{
      schemaVersion: 1,
      month: "2026-08",
      base: "USD",
      rates: { USD: 1, CNY: 7 },
      requestedProvider: "frankfurter",
      provider: "frankfurter",
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T00:00:00.000Z",
    }]);

    const { content } = await buildCloudBackupExportZip(envWithR2({}), "usr_cloud");
    const data = readStoredZipJson(content, "data.json");

    expect(data.data.exchangeRateSnapshots).toEqual([{
      schemaVersion: 1,
      month: "2026-08",
      base: "USD",
      rates: { USD: 1, CNY: 7 },
      requestedProvider: "frankfurter",
      provider: "frankfurter",
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T00:00:00.000Z",
    }]);
  });

  it.each([
    ["auto", undefined],
    ["zh-CN", "zh-CN"],
    ["en-US", "en-US"],
  ] as const)("maps %s to the v1 locale field", async (localePreference, expectedLocale) => {
    dbMocks.getSettings.mockResolvedValue({ ...createDefaultAppSettings(), localePreference });

    const { content } = await buildCloudBackupExportZip(envWithR2({}), "usr_cloud");
    const data = readStoredZipJson(content, "data.json");
    const manifest = readStoredZipJson(content, "manifest.json");

    expect(data.schemaVersion).toBe(1);
    expect(manifest.schemaVersion).toBe(1);
    expect(data.data.settings).not.toHaveProperty("localePreference");
    if (expectedLocale) {
      expect(data.data.settings.locale).toBe(expectedLocale);
    } else {
      expect(data.data.settings).not.toHaveProperty("locale");
    }
  });

  it("loads multiple R2 assets sequentially through the export call chain", async () => {
    dbMocks.getCustomConfig.mockResolvedValue({
      categories: [],
      statuses: [],
      paymentMethods: [
        { id: "pm_one", value: "one", labels: { "zh-CN": "One", "en-US": "One" }, icon: "/api/app/assets/asset_one" },
        { id: "pm_two", value: "two", labels: { "zh-CN": "Two", "en-US": "Two" }, icon: "/api/app/assets/asset_two" },
      ],
      currencies: [],
    });
    dbMocks.getAsset.mockImplementation(async (_env: Env, _userId: string, assetId: string) => (
      assetRow({ id: assetId, r2_key: `${assetId}.svg`, size_bytes: null })
    ));
    const reads: string[] = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    const env = envWithR2({
      "asset_one.svg": "<svg>one</svg>",
      "asset_two.svg": "<svg>two</svg>",
    }, async (key) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await Promise.resolve();
      reads.push(key);
      activeReads -= 1;
    });

    await buildCloudBackupExportZip(env, "usr_cloud");

    expect(reads).toEqual(["asset_one.svg", "asset_two.svg"]);
    expect(maxActiveReads).toBe(1);
  });
});

function envWithR2(objects: Record<string, string>, beforeGet?: (key: string) => Promise<void>): Env {
  const encoder = new TextEncoder();
  return {
    ASSETS_BUCKET: {
      head: vi.fn(async (key: string) => {
        const value = objects[key];
        if (value === undefined) return null;
        return {
          size: encoder.encode(value).byteLength,
          httpMetadata: { contentType: "image/svg+xml" },
        } as R2Object;
      }),
      get: vi.fn(async (key: string) => {
        const value = objects[key];
        if (value === undefined) return null;
        await beforeGet?.(key);
        const bytes = encoder.encode(value);
        return {
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          httpMetadata: { contentType: "image/svg+xml" },
        } as R2ObjectBody;
      }),
    } as unknown as R2Bucket,
  } as Env;
}

function assetRow(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "asset_logo",
    user_id: "usr_cloud",
    kind: "logo",
    r2_key: "assets/logo.svg",
    original_name: "logo.svg",
    mime_type: "image/svg+xml",
    size_bytes: 7,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

function subscriptionFixture(overrides: Partial<ApiSubscription> = {}): ApiSubscription {
  return apiSubscriptionSchema.parse({
    id: "sub_1",
    name: "GitHub",
    logo: undefined,
    price: "4",
    currency: "USD",
    billingCycle: "monthly",
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: "2026-05-21",
    nextBillingDate: "2026-06-21",
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  });
}

function readStoredZipJson(content: Uint8Array, name: string) {
  return JSON.parse(readStoredZipText(content, name));
}

function readStoredZipText(content: Uint8Array, name: string): string {
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= content.length) {
    const view = new DataView(content.buffer, content.byteOffset + offset, content.byteLength - offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const entryName = decoder.decode(content.slice(nameStart, nameStart + nameLength));
    const data = content.slice(dataStart, dataStart + compressedSize);
    if (entryName === name) return decoder.decode(data);
    offset = dataStart + compressedSize;
  }
  throw new Error(`missing ZIP entry ${name}`);
}
