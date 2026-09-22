// MFA schema 测试保护 Go、Worker 和前端共享的二阶段登录契约，避免任一运行面偷偷扩宽字段。
import { describe, expect, it } from "vitest";
import { adminResetUserMfaResponseSchema, adminResetUserPasskeysResponseSchema } from "./admin";
import {
  loginBodySchema,
  loginResponseSchema,
  mfaRecoveryCodesResponseSchema,
  mfaStatusResponseSchema,
  mfaTotpEnableBodySchema,
  mfaTotpSetupResponseSchema,
  mfaVerifyBodySchema,
  passkeyAuthenticationOptionsResponseSchema,
  passkeyAuthenticateOptionsBodySchema,
  passkeyAuthenticateVerifyBodySchema,
  passkeyDeleteBodySchema,
  passkeyRegistrationOptionsResponseSchema,
  passkeyRegisterOptionsBodySchema,
  passkeyRegisterVerifyBodySchema,
  passkeysResponseSchema,
} from "./auth";

const success = <T>(data: T) => ({ ok: true, data });

describe("auth schemas", () => {
  it("accepts direct session login responses", () => {
    const parsed = loginResponseSchema.parse(success({
      type: "session",
      session: { expiresAt: "2026-07-01T00:00:00.000Z" },
      user: { id: "usr_1", email: "admin@example.com", name: "Admin", role: "admin", banned: false },
    })).data;

    expect(parsed.type).toBe("session");
  });

  it("rejects leaking session identifiers in session responses", () => {
    expect(loginResponseSchema.safeParse(success({
      type: "session",
      session: { id: "ses_1", expiresAt: "2026-07-01T00:00:00.000Z" },
      user: { id: "usr_1", email: "admin@example.com", name: "Admin", role: "admin", banned: false },
    })).success).toBe(false);
  });

  it("accepts MFA-required login responses with authenticator methods only", () => {
    const parsed = loginResponseSchema.parse(success({
      type: "mfa_required",
      ticketId: "ticket-token",
      expiresAt: "2026-07-01T00:00:00.000Z",
      methods: ["totp", "recovery_code"],
    })).data;

    expect(parsed.type).toBe("mfa_required");
    if (parsed.type !== "mfa_required") {
      throw new Error("expected MFA-required login response");
    }
    expect(parsed.methods).toEqual(["totp", "recovery_code"]);
    expect(loginResponseSchema.safeParse(success({
      type: "mfa_required",
      ticketId: "ticket-token",
      expiresAt: "2026-07-01T00:00:00.000Z",
      methods: ["passkey"],
    })).success).toBe(false);
  });

  it("rejects unknown login response variants", () => {
    expect(loginResponseSchema.safeParse({ type: "password_ok" }).success).toBe(false);
    expect(loginResponseSchema.safeParse(success({ type: "password_ok" })).success).toBe(false);
  });

  it("parses MFA setup, status and WebAuthn management payloads", () => {
    expect(mfaStatusResponseSchema.parse(success({
      enabled: true,
      methods: ["totp", "recovery_code"],
      recoveryCodesRemaining: 9,
      passkeyCount: 1,
    })).data.passkeyCount).toBe(1);
    expect(mfaStatusResponseSchema.safeParse(success({
      enabled: true,
      methods: ["passkey"],
      recoveryCodesRemaining: 0,
      passkeyCount: 1,
    })).success).toBe(false);
    expect(mfaTotpSetupResponseSchema.parse(success({
      setupId: "setup-token",
      secret: "BASE32SECRET",
      otpauthUrl: "otpauth://totp/Renewlet:admin@example.com",
      expiresAt: "2026-07-01T00:00:00.000Z",
    })).data.setupId).toBe("setup-token");
    expect(mfaTotpEnableBodySchema.parse({
      setupId: "setup-token",
      code: "123456",
      currentPassword: "password123",
    }).code).toBe("123456");
    expect(mfaRecoveryCodesResponseSchema.parse(success({
      type: "session",
      session: { expiresAt: "2026-07-01T00:00:00.000Z" },
      user: { id: "usr_1", email: "admin@example.com", name: "Admin", role: "admin", banned: false },
      recoveryCodes: ["ABCD-EFGH-IJKL"],
    })).data.recoveryCodes).toHaveLength(1);
    expect(mfaRecoveryCodesResponseSchema.safeParse(success({
      recoveryCodes: ["ABCD-EFGH-IJKL"],
    })).success).toBe(false);
    expect(passkeysResponseSchema.parse(success({
      passkeys: [{ id: "pkey_1", name: "MacBook Touch ID", createdAt: "2026-07-01T00:00:00.000Z" }],
    })).data.passkeys).toHaveLength(1);
    expect(passkeyRegistrationOptionsResponseSchema.parse(success({
      challengeId: "challenge-token",
      expiresAt: "2026-07-01T00:00:00.000Z",
      options: registrationOptions(),
    })).data.options.extensions).toEqual({ credProps: true });
    const { extensions, ...optionsWithoutExtensions } = registrationOptions();
    expect(extensions).toEqual({ credProps: true });
    expect(passkeyRegistrationOptionsResponseSchema.parse(success({
      challengeId: "challenge-token",
      expiresAt: "2026-07-01T00:00:00.000Z",
      options: optionsWithoutExtensions,
    })).data.options.extensions).toEqual({ credProps: false });
    expect(passkeyRegistrationOptionsResponseSchema.parse(success({
      challengeId: "challenge-token",
      expiresAt: "2026-07-01T00:00:00.000Z",
      options: { ...optionsWithoutExtensions, extensions: {} },
    })).data.options.extensions).toEqual({ credProps: false });
    expect(passkeyRegistrationOptionsResponseSchema.safeParse(success({
      challengeId: "challenge-token",
      expiresAt: "2026-07-01T00:00:00.000Z",
      options: { ...optionsWithoutExtensions, extensions: { unsupported: true } },
    })).success).toBe(false);
    expect(passkeyAuthenticationOptionsResponseSchema.parse(success({
      challengeId: "challenge-token",
      expiresAt: "2026-07-01T00:00:00.000Z",
      options: authenticationOptions(),
    })).data.options.rpId).toBe("renewlet.example");
    expect(passkeyAuthenticationOptionsResponseSchema.safeParse(success({
      challengeId: "challenge-token",
      expiresAt: "2026-07-01T00:00:00.000Z",
      options: { challenge: "abc" },
    })).success).toBe(false);
  });

  it("parses MFA verify and passkey lifecycle requests", () => {
    expect(mfaVerifyBodySchema.parse({ method: "totp", ticketId: "ticket", code: "123456" }).method).toBe("totp");
    expect(mfaVerifyBodySchema.parse({ method: "recovery_code", ticketId: "ticket", code: "ABCD-EFGH-IJKL" }).method).toBe("recovery_code");
    expect(mfaVerifyBodySchema.safeParse({
      method: "passkey",
      ticketId: "ticket",
      challengeId: "challenge",
      response: { id: "credential" },
    }).success).toBe(false);
    expect(passkeyRegisterOptionsBodySchema.parse({ name: "Security Key", currentPassword: "password123" }).name).toBe("Security Key");
    expect(passkeyRegisterVerifyBodySchema.parse({ challengeId: "challenge", name: "Security Key", response: registrationResponse() }).challengeId).toBe("challenge");
    expect(passkeyAuthenticateOptionsBodySchema.parse({})).toEqual({});
    expect(passkeyAuthenticateVerifyBodySchema.parse({ challengeId: "challenge", response: authenticationResponse() }).challengeId).toBe("challenge");
    expect(passkeyDeleteBodySchema.parse({ currentPassword: "password123" }).currentPassword).toBe("password123");
  });

  it("keeps admin reset MFA as an ok-only response", () => {
    expect(adminResetUserMfaResponseSchema.parse(success({}))).toEqual(success({}));
    expect(adminResetUserPasskeysResponseSchema.parse(success({}))).toEqual(success({}));
    expect(adminResetUserMfaResponseSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it("accepts optional Turnstile token on password login without widening the request body", () => {
    expect(loginBodySchema.parse({
      email: "admin@example.com",
      password: "password123",
      turnstileToken: " token-value ",
    }).turnstileToken).toBe("token-value");
    expect(loginBodySchema.safeParse({
      email: "admin@example.com",
      password: "password123",
      turnstileToken: "",
    }).success).toBe(false);
    expect(loginBodySchema.safeParse({
      email: "admin@example.com",
      password: "password123",
      token: "old-field",
    }).success).toBe(false);
  });
});

function registrationOptions() {
  return {
    rp: { id: "renewlet.example", name: "Renewlet" },
    user: { id: "dXNlci0x", name: "admin@example.com", displayName: "Admin" },
    challenge: "registration-challenge",
    pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    timeout: 60_000,
    excludeCredentials: [],
    authenticatorSelection: {
      requireResidentKey: true,
      residentKey: "required",
      userVerification: "required",
    },
    hints: [],
    attestation: "none",
    extensions: { credProps: true },
  };
}

function authenticationOptions() {
  return {
    challenge: "authentication-challenge",
    timeout: 60_000,
    rpId: "renewlet.example",
    allowCredentials: [],
    userVerification: "required",
    hints: [],
  };
}

function registrationResponse() {
  return {
    id: "credential-id",
    rawId: "credential-id",
    response: {
      clientDataJSON: "client-data",
      attestationObject: "attestation-object",
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}

function authenticationResponse() {
  return {
    id: "credential-id",
    rawId: "credential-id",
    response: {
      clientDataJSON: "client-data",
      authenticatorData: "authenticator-data",
      signature: "signature",
      userHandle: "user-handle",
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}
