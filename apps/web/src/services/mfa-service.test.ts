import { beforeEach, describe, expect, it, vi } from "vitest";
import { mfaService } from "./mfa-service";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  writeProductSession: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
}));

vi.mock("@/services/product-session", () => ({
  writeProductSession: mocks.writeProductSession,
}));

const renewedSession = {
  type: "session" as const,
  session: { expiresAt: "2026-07-03T00:00:00.000Z" },
  user: {
    id: "user-1",
    email: "mfa@example.com",
    name: "MFA User",
    role: "user",
    banned: false,
  },
};

describe("mfaService", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.writeProductSession.mockReset();
  });

  it("stores the renewed session before returning one-time recovery codes", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ...renewedSession,
      recoveryCodes: ["ABCD-EFGH-IJKL"],
    });

    await expect(mfaService.enableTotp({
      setupId: "setup-token",
      code: "123456",
      currentPassword: "password123",
    })).resolves.toEqual(["ABCD-EFGH-IJKL"]);

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/auth/mfa/totp/enable");
    expect(mocks.writeProductSession).toHaveBeenCalledWith(expect.objectContaining({
      session: { expiresAt: "2026-07-03T00:00:00.000Z" },
    }));
  });

  it("stores the renewed session after regenerating recovery codes", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ...renewedSession,
      recoveryCodes: ["MNOP-QRST-UVWX"],
    });

    await expect(mfaService.regenerateRecoveryCodes({ currentPassword: "password123" })).resolves.toEqual(["MNOP-QRST-UVWX"]);

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/auth/mfa/recovery/regenerate");
    expect(mocks.writeProductSession).toHaveBeenCalledWith(renewedSession);
  });

  it("stores the renewed session after disabling the authenticator", async () => {
    mocks.apiFetch.mockResolvedValueOnce(renewedSession);

    await mfaService.disable({ currentPassword: "password123" });

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/auth/mfa/disable");
    expect(mocks.writeProductSession).toHaveBeenCalledWith(renewedSession);
  });
});
