import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { MAX_IMPORT_FILE_BYTES } from "./import-export-model";
import {
  assertZipEntryWithinLimit,
  inspectZipCentralDirectory,
  MAX_IMPORT_ZIP_ENTRIES,
  ZipLimitExceededError,
} from "./zip-central-directory";

describe("ZIP central directory limits", () => {
  it("rejects a small compressed ZIP whose data entry expands beyond 8 MiB", async () => {
    const zip = new JSZip();
    zip.file("data.json", "a".repeat(MAX_IMPORT_FILE_BYTES + 1));
    const bytes = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 1 },
    });

    expect(bytes.byteLength).toBeLessThan(MAX_IMPORT_FILE_BYTES);
    const directory = inspectZipCentralDirectory(bytes, MAX_IMPORT_ZIP_ENTRIES);
    const entry = directory.byName.get("data.json");
    if (!entry) throw new Error("test ZIP is missing data.json");

    expect(() => assertZipEntryWithinLimit(entry, MAX_IMPORT_FILE_BYTES)).toThrow(ZipLimitExceededError);
  });
});
