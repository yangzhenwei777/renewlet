// logo-url 测试保护私有资产路径、http(s) 外链和 HTTPS 页面展示 HTTP Logo 的临时升级规则。
import { describe, expect, it } from "vitest";
import { resolveDisplayLogoSrc, validateCustomLogoUrlInput } from "./logo-url";

describe("logo-url", () => {
  it("validates persistent custom Logo links", () => {
    expect(validateCustomLogoUrlInput(" https://example.com/logo.svg ").ok).toBe(true);
    expect(validateCustomLogoUrlInput("http://example.com/logo.png").ok).toBe(true);
    expect(validateCustomLogoUrlInput("data:image/png;base64,aGVsbG8=")).toMatchObject({ ok: false, code: "scheme" });
    expect(validateCustomLogoUrlInput("/api/app/assets/asset-1")).toMatchObject({ ok: false, code: "invalid" });
    expect(validateCustomLogoUrlInput("https://user:pass@example.com/logo.png")).toMatchObject({ ok: false, code: "userinfo" });
  });

  it("upgrades HTTP domain logos on HTTPS pages but blocks HTTP IP logos", () => {
    expect(resolveDisplayLogoSrc("http://example.com/logo.png", "https:")).toBe("https://example.com/logo.png");
    expect(resolveDisplayLogoSrc("http://192.168.1.10/logo.png", "https:")).toBeUndefined();
    expect(resolveDisplayLogoSrc("http://[::1]/logo.png", "https:")).toBeUndefined();
    expect(resolveDisplayLogoSrc("http://example.com/logo.png", "http:")).toBe("http://example.com/logo.png");
    expect(resolveDisplayLogoSrc("not a url", "https:")).toBeUndefined();
    expect(resolveDisplayLogoSrc("/icons/payment-methods/paypal.svg", "https:")).toBe("/icons/payment-methods/paypal.svg");
  });
});
