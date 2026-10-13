import { afterEach, describe, expect, it, vi } from "vitest";
import { renewletExportManifestV1Schema, renewletExportV1Schema } from "@renewlet/shared/schemas/import-export";
import { buildCloudBackupExportZip } from "./cloud-backup-export";
import { getAsset, getOwnedAssetsByIds } from "./db";
import { CronBudget } from "./cron-budget";
import { createCronFixture } from "./cron-test-support";
import { insertSubscriptionStatement, subscriptionRow } from "./subscription-d1-test-support";
import { readStoredZipText } from "./zip-store-test-support";

afterEach(() => vi.restoreAllMocks());

describe("cloud backup owner metadata queries", () => {
  it.each([0, 100, 150, 1000])("reads %i referenced assets in at most one bounded-parameter query", async (size) => {
    const { db, env } = createCronFixture(2);
    try {
      const ids = Array.from({ length: size }, (_, index) => `asset-${index}`);
      const insert = db.prepare("INSERT INTO assets (id, user_id, kind, r2_key, original_name, mime_type, size_bytes, created_at, updated_at) VALUES (?, ?, 'logo', ?, 'logo.svg', 'image/svg+xml', 7, '', '')");
      for (const id of ids) insert.run(id, "usr-0000", `private/${id}`);
      insert.run("foreign", "usr-0001", "secret/foreign");
      const prepare = vi.spyOn(env.DB, "prepare");
      for (const id of ids) await getAsset(env, "usr-0000", id);
      expect(prepare).toHaveBeenCalledTimes(size);
      prepare.mockClear();
      const requested = size === 0 ? [] : [...ids, ids[0] ?? "", "foreign", "missing"];
      const result = await getOwnedAssetsByIds(env, "usr-0000", requested);
      expect(result.map((row) => row.id).sort()).toEqual([...ids].sort());
      expect(prepare).toHaveBeenCalledTimes(size === 0 ? 0 : 1);
      if (size > 0) {
        const sql = prepare.mock.calls[0]?.[0];
        if (!sql) throw new Error("Missing metadata query");
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("usr-0000", JSON.stringify(requested), requested.length);
        const details = plan.map((row) => String(row["detail"]));
        expect(details.some((detail) => /SEARCH assets .*INDEX/.test(detail))).toBe(true);
        expect(details.some((detail) => /SCAN assets|TEMP B-TREE/.test(detail))).toBe(false);
      }
    } finally { db.close(); }
  });

  it.each([1, 150])("exports 1000 subscriptions with %i owned objects in 15 SQL statements", async (uniqueAssets) => {
    const { db, env } = createCronFixture(2);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const insertAsset = db.prepare("INSERT INTO assets (id, user_id, kind, r2_key, original_name, mime_type, size_bytes, created_at, updated_at) VALUES (?, ?, 'logo', ?, 'logo.svg', 'image/svg+xml', 7, '', '')");
      for (let index = 0; index < uniqueAssets; index++) insertAsset.run(`shared-${index}`, "usr-0000", `private/shared-${index}`);
      insertAsset.run("foreign", "usr-0001", "secret/foreign");
      for (let index = 0; index < 1000; index++) {
        await insertSubscriptionStatement(env, subscriptionRow(`sub-${index}`, {
          user_id: "usr-0000", logo: `/api/app/assets/shared-${index % uniqueAssets}`, price: "123456789.012345",
        })).run();
      }
      const paymentMethods = ["first", "second", "foreign", "missing"].map((id) => ({
        id, value: id, labels: { "zh-CN": id, "en-US": id }, icon: `/api/app/assets/${id === "first" || id === "second" ? "shared-0" : id}`,
      }));
      db.prepare("INSERT INTO custom_configs (user_id, config_json, created_at, updated_at) VALUES ('usr-0000', ?, '', '')")
        .run(JSON.stringify({ categories: [], statuses: [], currencies: [], paymentMethods }));
      const bytes = new TextEncoder().encode("<svg />");
      const head = vi.fn(async () => ({ size: bytes.length, httpMetadata: { contentType: "image/svg+xml" } }) as R2Object);
      const get = vi.fn(async () => ({ arrayBuffer: async () => bytes.buffer }) as R2ObjectBody);
      env.ASSETS_BUCKET = { head, get } as unknown as R2Bucket;
      const budget = new CronBudget();
      env.DB = budget.database(env.DB);
      const { content } = await buildCloudBackupExportZip(env, "usr-0000", new Date("2026-10-09T00:00:00Z"), budget);
      const payload = renewletExportV1Schema.parse(JSON.parse(readStoredZipText(content, "data.json")));
      const manifest = renewletExportManifestV1Schema.parse(JSON.parse(readStoredZipText(content, "manifest.json")));
      // 100条订阅游标页为11次读取，另外三项业务读取加一次metadata；不改变既有分页大小。
      expect(budget.used.sql).toBe(15);
      expect(budget.used.storageReserved).toBe(uniqueAssets * 2);
      const expectedKeys = Array.from({ length: uniqueAssets }, (_, index) => `private/shared-${index}`).sort();
      expect(head.mock.calls.flat().sort()).toEqual(expectedKeys);
      expect(get.mock.calls.flat().sort()).toEqual(expectedKeys);
      expect(payload.schemaVersion).toBe(1);
      expect(payload.data.subscriptions).toHaveLength(1000);
      expect(payload.data.subscriptions.every((subscription) => subscription.price === "123456789.012345" && subscription.logo === `assets/shared-${Number(subscription.id.slice(4)) % uniqueAssets}.svg`)).toBe(true);
      expect(payload.data.customConfig?.paymentMethods[0]?.icon).toBe("assets/shared-0.svg");
      expect(payload.data.customConfig?.paymentMethods[1]?.icon).toBe("assets/shared-0.svg");
      expect(payload.data.customConfig?.paymentMethods[2]).not.toHaveProperty("icon");
      expect(manifest.assets).toBe(uniqueAssets);
      expect(manifest.missingAssets.map((asset) => [asset.assetId, asset.reason])).toEqual([["foreign", "not_found"], ["missing", "not_found"]]);
      expect(new TextDecoder().decode(content)).not.toContain("secret/foreign");
      expect(info).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it("propagates metadata failures before reading any R2 object", async () => {
    const { db, env } = createCronFixture(1);
    try {
      await insertSubscriptionStatement(env, subscriptionRow("broken", { user_id: "usr-0000", logo: "/api/app/assets/logo" })).run();
      db.exec("DROP TABLE assets");
      const head = vi.fn();
      env.ASSETS_BUCKET = { head } as unknown as R2Bucket;
      await expect(buildCloudBackupExportZip(env, "usr-0000")).rejects.toThrow("no such table: assets");
      expect(head).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});
