import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { assertDateOnly } from "@/lib/time/date-only";
import { parseImportFile, parseJsonText } from "./wallos-import";
import {
  IMPORT_MESSAGE_CODES,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_PREVIEW_SUBSCRIPTIONS,
} from "./import-export-model";

const context = {
  config: DEFAULT_CUSTOM_CONFIG,
  settings: DEFAULT_SETTINGS,
  today: assertDateOnly("2026-08-17"),
};

class OversizedImportFile extends File {
  readonly arrayBufferSpy = vi.fn<() => Promise<ArrayBuffer>>();

  constructor(name: string, type: string) {
    super([], name, { type });
  }

  override get size(): number {
    return MAX_IMPORT_FILE_BYTES + 1;
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    return this.arrayBufferSpy();
  }
}

describe("import parser limits", () => {
  it.each([
    ["oversized.json", "application/json"],
    ["oversized.zip", "application/zip"],
    ["oversized.sqlite", "application/vnd.sqlite3"],
  ])("rejects %s before reading its bytes", async (name, type) => {
    const file = new OversizedImportFile(name, type);

    await expect(parseImportFile(file, context)).rejects.toThrow(IMPORT_MESSAGE_CODES.fileTooLarge);
    expect(file.arrayBufferSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized JSON text before JSON.parse", async () => {
    const text = " ".repeat(MAX_IMPORT_FILE_BYTES + 1);

    await expect(parseJsonText(text, context)).rejects.toThrow(IMPORT_MESSAGE_CODES.fileTooLarge);
  });

  it("rejects 1001 preview subscriptions with the stable size error", async () => {
    const rows = Array.from({ length: MAX_IMPORT_PREVIEW_SUBSCRIPTIONS + 1 }, (_, index) => ({
      Name: `Subscription ${index}`,
      Price: "$1.00",
      "Payment Cycle": "Monthly",
      "Next Payment": "2026-09-01",
    }));

    await expect(parseJsonText(JSON.stringify(rows), context)).rejects.toThrow(IMPORT_MESSAGE_CODES.fileTooLarge);
  });
});
