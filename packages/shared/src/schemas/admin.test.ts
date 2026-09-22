// 管理 schema 测试保护 admin-only 契约，尤其是 write-only secret 不被响应 schema 放宽。
import { describe, expect, it } from "vitest";
import {
  authSecuritySettingsResponseSchema,
  authSecuritySettingsUpdateBodySchema,
  authSecurityTurnstileTestBodySchema,
  authSecurityTurnstileTestResponseSchema,
} from "./admin";

const success = <T>(data: T) => ({ ok: true, data });

describe("admin schemas", () => {
  it("keeps Turnstile secret write-only in auth security responses", () => {
    const parsed = authSecuritySettingsResponseSchema.parse(success({
      turnstile: {
        enabled: true,
        siteKey: "site-key",
        secretConfigured: true,
      },
    })).data;

    expect(parsed.turnstile.secretConfigured).toBe(true);
    expect(authSecuritySettingsResponseSchema.safeParse(success({
      turnstile: {
        enabled: true,
        siteKey: "site-key",
        secretConfigured: true,
        secret: "secret-value",
      },
    })).success).toBe(false);
  });

  it("accepts omitted and empty Turnstile secret on auth security updates", () => {
    expect(authSecuritySettingsUpdateBodySchema.parse({
      turnstile: {
        enabled: true,
        siteKey: "site-key",
      },
    }).turnstile.secret).toBeUndefined();
    expect(authSecuritySettingsUpdateBodySchema.parse({
      turnstile: {
        enabled: false,
        siteKey: "site-key",
        secret: "",
      },
    }).turnstile.secret).toBe("");
    expect(authSecuritySettingsUpdateBodySchema.safeParse({
      turnstile: {
        enabled: false,
        siteKey: "site-key",
        secret: "",
        secretConfigured: false,
      },
    }).success).toBe(false);
  });

  it("keeps Turnstile test request and response strict without exposing secrets", () => {
    const parsed = authSecurityTurnstileTestBodySchema.parse({
      turnstile: {
        siteKey: " site-key ",
        secret: "",
        turnstileToken: "",
      },
    });

    expect(parsed.turnstile.siteKey).toBe("site-key");
    expect(parsed.turnstile.turnstileToken).toBe("");
    expect(authSecurityTurnstileTestBodySchema.safeParse({
      turnstile: {
        siteKey: "site-key",
        turnstileToken: "token",
        unexpected: true,
      },
    }).success).toBe(false);
    expect(authSecurityTurnstileTestResponseSchema.parse(success({ verified: true })).data.verified).toBe(true);
    expect(authSecurityTurnstileTestResponseSchema.safeParse(success({
      verified: true,
      secret: "secret-value",
    })).success).toBe(false);
  });
});
