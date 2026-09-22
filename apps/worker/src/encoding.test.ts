import { describe, expect, it } from "vitest";
import { arrayBufferFromBytes, base64Url, base64UrlToArrayBuffer, base64UrlToBytes, timingSafeEqualBytes } from "./encoding";

describe("Cloudflare encoding helpers", () => {
  it("round-trips base64url bytes without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = base64Url(bytes);

    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect([...base64UrlToBytes(encoded)]).toEqual([...bytes]);
    expect([...new Uint8Array(base64UrlToArrayBuffer(encoded))]).toEqual([...bytes]);
  });

  it("copies ArrayBuffer views without leaking byte offsets", () => {
    const source = new Uint8Array([9, 1, 2, 3, 9]);
    const view = source.subarray(1, 4);

    expect([...new Uint8Array(arrayBufferFromBytes(view))]).toEqual([1, 2, 3]);
  });

  it("compares equal-length bytes without early success on prefixes", () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });
});
