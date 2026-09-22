import { beforeEach, describe, expect, it, vi } from "vitest";
import { passkeyService } from "./passkey-service";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  cancelCeremony: vi.fn(),
  writeProductSession: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
}));

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: mocks.startAuthentication,
  startRegistration: mocks.startRegistration,
  WebAuthnAbortService: {
    cancelCeremony: mocks.cancelCeremony,
  },
}));

vi.mock("@/services/product-session", () => ({
  writeProductSession: mocks.writeProductSession,
}));

const sessionResponse = {
  type: "session" as const,
  session: { expiresAt: "2026-07-03T00:00:00.000Z" },
  user: {
    id: "user-1",
    email: "passkey@example.com",
    name: "Passkey User",
    role: "user",
    banned: false,
  },
};

const authenticationOptions = {
  challenge: "challenge-value",
  timeout: 60_000,
  rpId: "renewlet.example",
  allowCredentials: [],
  userVerification: "required" as const,
  hints: [],
};

const registrationOptions = {
  rp: { id: "renewlet.example", name: "Renewlet" },
  user: { id: "dXNlci0x", name: "passkey@example.com", displayName: "Passkey User" },
  challenge: "challenge-value",
  pubKeyCredParams: [{ alg: -7, type: "public-key" as const }],
  timeout: 60_000,
  excludeCredentials: [],
  authenticatorSelection: {
    requireResidentKey: true,
    residentKey: "required" as const,
    userVerification: "required" as const,
  },
  hints: [],
  attestation: "none" as const,
  extensions: { credProps: true },
};

const authenticationResponse = {
  id: "credential-id",
  rawId: "credential-id",
  response: {
    clientDataJSON: "client-data",
    authenticatorData: "authenticator-data",
    signature: "signature",
    userHandle: "user-handle",
  },
  type: "public-key" as const,
  clientExtensionResults: {},
};

const registrationResponse = {
  id: "new-credential-id",
  rawId: "new-credential-id",
  response: {
    clientDataJSON: "client-data",
    attestationObject: "attestation-object",
  },
  type: "public-key" as const,
  clientExtensionResults: {},
};

describe("passkeyService", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.startAuthentication.mockReset().mockResolvedValue(authenticationResponse);
    mocks.startRegistration.mockReset().mockResolvedValue(registrationResponse);
    mocks.cancelCeremony.mockReset();
    mocks.writeProductSession.mockReset();
  });

  it("cancels an active browser WebAuthn ceremony through SimpleWebAuthn", () => {
    passkeyService.cancelActiveCeremony();

    expect(mocks.cancelCeremony).toHaveBeenCalledTimes(1);
  });

  it("uses unauthenticated API mode for independent passkey sign-in", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce({
        challengeId: "challenge-1",
        expiresAt: "2026-07-03T00:00:00.000Z",
        options: authenticationOptions,
      })
      .mockResolvedValueOnce(sessionResponse);

    await expect(passkeyService.authenticate({ useBrowserAutofill: true })).resolves.toEqual({
      status: "authenticated",
      session: sessionResponse,
    });

    const optionsInit = mocks.apiFetch.mock.calls[0]?.[2] as RequestInit & { authMode?: string };
    const verifyInit = mocks.apiFetch.mock.calls[1]?.[2] as RequestInit & { authMode?: string };
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/auth/passkeys/authenticate/options");
    expect(optionsInit.authMode).toBe("none");
    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/auth/passkeys/authenticate/verify");
    expect(verifyInit.authMode).toBe("none");
    expect(mocks.startAuthentication).toHaveBeenCalledWith(expect.objectContaining({
      useBrowserAutofill: true,
    }));
    expect(JSON.parse(String(verifyInit.body))).toMatchObject({
      challengeId: "challenge-1",
      response: { id: "credential-id" },
    });
  });

  it("treats user cancellation as a neutral passkey result and skips verification", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      challengeId: "challenge-1",
      expiresAt: "2026-07-03T00:00:00.000Z",
      options: authenticationOptions,
    });
    const cause = Object.assign(new Error("The operation either timed out or was not allowed."), {
      name: "NotAllowedError",
    });
    mocks.startAuthentication.mockRejectedValueOnce(Object.assign(new Error("The operation either timed out or was not allowed."), {
      name: "WebAuthnError",
      code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
      cause,
    }));

    await expect(passkeyService.authenticate()).resolves.toEqual({ status: "cancelled" });

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/auth/passkeys/authenticate/options");
  });

  it("treats an aborted WebAuthn ceremony as a neutral passkey result and skips verification", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      challengeId: "challenge-1",
      expiresAt: "2026-07-03T00:00:00.000Z",
      options: authenticationOptions,
    });
    mocks.startAuthentication.mockRejectedValueOnce(Object.assign(new Error("Manually cancelling existing WebAuthn API call"), {
      name: "WebAuthnError",
      code: "ERROR_CEREMONY_ABORTED",
    }));

    await expect(passkeyService.authenticate()).resolves.toEqual({ status: "cancelled" });

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/auth/passkeys/authenticate/options");
  });

  it("stores the renewed session after registering a passkey", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce({
        challengeId: "register-challenge",
        expiresAt: "2026-07-03T00:00:00.000Z",
        options: registrationOptions,
      })
      .mockResolvedValueOnce(sessionResponse);

    await passkeyService.register({ name: "MacBook Touch ID", currentPassword: "password123" });

    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/auth/passkeys/register/verify");
    expect(mocks.writeProductSession).toHaveBeenCalledWith(sessionResponse);
  });

  it("stores the renewed session after deleting a passkey", async () => {
    mocks.apiFetch.mockResolvedValueOnce(sessionResponse);

    await passkeyService.delete("pkey_1", { currentPassword: "password123" });

    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/app/auth/passkeys/pkey_1/delete", expect.anything(), expect.objectContaining({
      method: "POST",
    }));
    expect(mocks.writeProductSession).toHaveBeenCalledWith(sessionResponse);
  });
});
