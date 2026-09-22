import { describe, expect, it } from "vitest";
import { CLOUD_BACKUP_MAX_SNAPSHOT_BYTES } from "@renewlet/shared/schemas/cloud-backup";
import { createStoredZipFromSources, type StoredZipSource } from "./zip-store";

const encoder = new TextEncoder();

describe("stored ZIP writer", () => {
  it("writes a deterministic store-only ZIP with valid local, central, and end records", async () => {
    const archive = await createStoredZipFromSources([
      source("data.json", "{}"),
      source("assets/logo.txt", "logo"),
    ], new Date("2026-08-17T12:34:56.000Z"));
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);

    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const endOffset = archive.length - 22;
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
    expect(view.getUint16(endOffset + 8, true)).toBe(2);
    expect(view.getUint16(endOffset + 10, true)).toBe(2);
    const centralOffset = view.getUint32(endOffset + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    expect(view.getUint32(endOffset + 12, true)).toBe(endOffset - centralOffset);
  });

  it("loads at most one entry at a time", async () => {
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const load = (value: string) => async () => {
      activeLoads += 1;
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
      await Promise.resolve();
      activeLoads -= 1;
      return encoder.encode(value);
    };

    await createStoredZipFromSources([
      { name: "one", size: 3, load: load("one") },
      { name: "two", size: 3, load: load("two") },
      { name: "three", size: 5, load: load("three") },
    ]);

    expect(maxActiveLoads).toBe(1);
  });

  it("encodes text entries directly without invoking a binary loader", async () => {
    const archive = await createStoredZipFromSources([
      { name: "data.json", size: encoder.encode('{"name":"订阅"}').length, text: '{"name":"订阅"}' },
    ]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const nameLength = view.getUint16(26, true);
    const dataSize = view.getUint32(18, true);
    const dataOffset = 30 + nameLength;

    expect(new TextDecoder().decode(archive.subarray(dataOffset, dataOffset + dataSize))).toBe('{"name":"订阅"}');
  });

  it("rejects invalid metadata before loading any asset", async () => {
    const load = async () => encoder.encode("x");
    await expect(createStoredZipFromSources([{ name: "x", size: -1, load }])).rejects.toThrow("CLOUD_BACKUP_ASSET_SIZE_INVALID");
    await expect(createStoredZipFromSources([{ name: "x", size: 1.5, load }])).rejects.toThrow("CLOUD_BACKUP_ASSET_SIZE_INVALID");
  });

  it("rejects a loaded entry whose bytes differ from metadata", async () => {
    await expect(createStoredZipFromSources([
      { name: "asset.bin", size: 4, load: async () => encoder.encode("five!") },
    ])).rejects.toThrow("CLOUD_BACKUP_ASSET_SIZE_MISMATCH");
  });

  it("enforces the 16 MiB final archive limit before loading assets", async () => {
    let loaded = false;
    const oversized: StoredZipSource = {
      name: "asset.bin",
      size: CLOUD_BACKUP_MAX_SNAPSHOT_BYTES,
      load: async () => {
        loaded = true;
        return new Uint8Array(CLOUD_BACKUP_MAX_SNAPSHOT_BYTES);
      },
    };

    await expect(createStoredZipFromSources([oversized], new Date(), CLOUD_BACKUP_MAX_SNAPSHOT_BYTES))
      .rejects.toThrow("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
    expect(loaded).toBe(false);
  });

  it("accepts a stored archive close to 15.9 MiB", async () => {
    const payloadBytes = Math.floor(15.9 * 1024 * 1024);
    const archive = await createStoredZipFromSources([{
      name: "snapshot.bin",
      size: payloadBytes,
      load: async () => new Uint8Array(payloadBytes),
    }], new Date("2026-08-17T12:34:56.000Z"), CLOUD_BACKUP_MAX_SNAPSHOT_BYTES);

    expect(archive.byteLength).toBeGreaterThan(15.8 * 1024 * 1024);
    expect(archive.byteLength).toBeLessThanOrEqual(CLOUD_BACKUP_MAX_SNAPSHOT_BYTES);
  });
});

function source(name: string, value: string): StoredZipSource {
  const bytes = encoder.encode(value);
  return { name, size: bytes.length, load: async () => bytes };
}
