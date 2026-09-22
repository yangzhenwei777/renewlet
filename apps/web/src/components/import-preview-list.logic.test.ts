// 导入预览列表测试保护手动 skip 的优先级，避免前端冲突策略覆盖用户明确跳过或服务端错误。
import { describe, expect, it } from "vitest";
import type { ImportPreviewResponse } from "@/lib/api/schemas/import-export";
import { recomputePreviewForConflictMode } from "./import-preview-list";

const basePreview: ImportPreviewResponse = {
  summary: { total: 2, creates: 1, replaces: 0, skips: 0, errors: 1, warnings: 0 },
  items: [
    {
      index: 0,
      name: "Apple",
      source: "wallos",
      sourceId: "display:apple",
      action: "create",
      warnings: [],
      errors: [],
    },
    {
      index: 1,
      name: "Broken",
      source: "wallos",
      sourceId: "display:broken",
      action: "error",
      warnings: [],
      errors: ["BROKEN"],
    },
  ],
  includesSettings: false,
  includesCustomConfig: false,
  includesExchangeRateSnapshots: false,
  exchangeRateSnapshotsCount: 0,
};

describe("import preview list", () => {
  it("lets a manual skip remove a row from create/error summaries", () => {
    const preview = recomputePreviewForConflictMode(basePreview, "skip", new Set([0, 1]));

    expect(preview.items.map((item) => item.action)).toEqual(["skip", "skip"]);
    expect(preview.summary.creates).toBe(0);
    expect(preview.summary.skips).toBe(2);
    expect(preview.summary.errors).toBe(0);
  });
});
