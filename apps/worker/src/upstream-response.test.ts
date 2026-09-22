import { describe, expect, it } from "vitest";
import { readUpstreamResponseTextUpToLimit } from "./upstream-response";

describe("Cloudflare upstream response body helpers", () => {
  it("rejects declared oversized responses before parsing", async () => {
    const response = new Response("hello", {
      headers: { "content-length": "6" },
    });

    await expect(readUpstreamResponseTextUpToLimit(response, "Provider", 5))
      .rejects.toThrow("Provider response too large");
  });

  it("rejects streamed responses that exceed the limit", async () => {
    const response = new Response("abcdef");

    await expect(readUpstreamResponseTextUpToLimit(response, "Provider", 5))
      .rejects.toThrow("Provider response too large");
  });

  it("returns full text within the byte limit", async () => {
    const response = new Response("abc");

    await expect(readUpstreamResponseTextUpToLimit(response, "Provider", 3))
      .resolves.toBe("abc");
  });
});
