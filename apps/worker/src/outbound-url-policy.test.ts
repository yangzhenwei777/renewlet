// SSRF 策略测试覆盖 URL 解析怪异输入和 DNS 解析到内网的场景，保护通知外部请求边界。
import { describe, expect, it } from "vitest";
import { outboundUrlPolicyFixtures } from "@renewlet/shared/contract-fixtures";
import { assertSafeOutboundUrl } from "./outbound-url-policy";

describe("outbound URL policy", () => {
  it.each(outboundUrlPolicyFixtures)("matches shared fixture $name", async (fixture) => {
    const result = assertSafeOutboundUrl(fixture.url, "en-US", async () => fixture.resolvedIps);
    if (!fixture.safe) {
      await expect(result).rejects.toThrow();
      return;
    }
    await expect(result).resolves.toMatchObject({ href: fixture.expectedUrl ?? fixture.url });
  });

  it.each([
    "http://example.com/webhook",
    "https://user:pass@example.com/webhook",
    "https://localhost/webhook",
    "https://service.localhost/webhook",
    "https://127.0.0.1/webhook",
    "https://0x7f000001/webhook",
    "https://2130706433/webhook",
    "https://[::1]/webhook",
    "https://[fd00::1]/webhook",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(assertSafeOutboundUrl(url, "en-US", async () => ["93.184.216.34"])).rejects.toThrow();
  });

  it("rejects hostnames that resolve to private addresses", async () => {
    await expect(assertSafeOutboundUrl("https://hooks.example/webhook", "en-US", async () => ["10.0.0.8"])).rejects.toThrow(
      "URL cannot point to private or localhost addresses",
    );
  });

  it("allows public HTTPS webhook endpoints", async () => {
    const url = await assertSafeOutboundUrl("https://hooks.example/webhook?topic=renewlet", "en-US", async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
    expect(url.toString()).toBe("https://hooks.example/webhook?topic=renewlet");
  });
});
