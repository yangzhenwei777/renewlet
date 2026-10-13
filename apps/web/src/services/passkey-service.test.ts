import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPasskeyService } from "./passkey-service";

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

const browser = {
  startAuthentication: mocks.startAuthentication,
  startRegistration: mocks.startRegistration,
  WebAuthnAbortService: { cancelCeremony: mocks.cancelCeremony },
};
const loadBrowser = vi.fn(async () => browser);
let passkeyService: ReturnType<typeof createPasskeyService>;

function deferred<T>() {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return {
    promise,
    resolve(value: T) {
      if (!settle) throw new Error("Deferred promise is not initialized");
      settle(value);
    },
  };
}

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
    passkeyService = createPasskeyService(loadBrowser);
    loadBrowser.mockReset().mockResolvedValue(browser);
    mocks.apiFetch.mockReset();
    mocks.startAuthentication.mockReset().mockResolvedValue(authenticationResponse);
    mocks.startRegistration.mockReset().mockResolvedValue(registrationResponse);
    mocks.cancelCeremony.mockReset();
    mocks.writeProductSession.mockReset();
  });

  it("does not load the browser SDK when cancelling an idle ceremony", () => {
    passkeyService.cancelActiveCeremony();

    expect(mocks.cancelCeremony).not.toHaveBeenCalled();
    expect(loadBrowser).not.toHaveBeenCalled();
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

  it("loads the SDK and challenge concurrently and cancels before the SDK arrives", async () => {
    const loading = deferred<typeof browser>();
    loadBrowser.mockReturnValueOnce(loading.promise);
    mocks.apiFetch.mockResolvedValueOnce({ challengeId: "challenge-1", options: authenticationOptions });
    const pending = passkeyService.authenticate();
    expect(loadBrowser).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    passkeyService.cancelActiveCeremony();
    loading.resolve(browser);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(mocks.startAuthentication).not.toHaveBeenCalled();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("does not open a native ceremony after a cancelled challenge response", async () => {
    const challenge = deferred<{ challengeId: string; options: typeof authenticationOptions }>();
    mocks.apiFetch.mockReturnValueOnce(challenge.promise);
    const pending = passkeyService.authenticate();
    passkeyService.cancelActiveCeremony();
    challenge.resolve({ challengeId: "challenge-1", options: authenticationOptions });
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(mocks.startAuthentication).not.toHaveBeenCalled();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation neutral when the HTTP boundary wraps AbortError", async () => {
    mocks.apiFetch.mockImplementationOnce((_path: string, _schema: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("Request aborted"), {
        name: "ApiError", code: "aborted",
      })), { once: true });
    }));
    const pending = passkeyService.authenticate();
    passkeyService.cancelActiveCeremony();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(mocks.startAuthentication).not.toHaveBeenCalled();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts native WebAuthn and rejects a credential returned after cancellation", async () => {
    const credential = deferred<typeof authenticationResponse>();
    mocks.startAuthentication.mockReturnValueOnce(credential.promise);
    mocks.apiFetch.mockResolvedValueOnce({ challengeId: "challenge-1", options: authenticationOptions });
    const pending = passkeyService.authenticate();
    await vi.waitFor(() => expect(mocks.startAuthentication).toHaveBeenCalledTimes(1));
    passkeyService.cancelActiveCeremony();
    expect(mocks.cancelCeremony).toHaveBeenCalledTimes(1);
    credential.resolve(authenticationResponse);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("a superseded request cannot clear the cancellation owner of a new ceremony", async () => {
    const oldChallenge = deferred<{ challengeId: string; options: typeof authenticationOptions }>();
    const credential = deferred<typeof authenticationResponse>();
    mocks.apiFetch.mockReturnValueOnce(oldChallenge.promise)
      .mockResolvedValueOnce({ challengeId: "new-challenge", options: authenticationOptions });
    mocks.startAuthentication.mockReturnValueOnce(credential.promise);
    const old = passkeyService.authenticate();
    const current = passkeyService.authenticate();
    await vi.waitFor(() => expect(mocks.startAuthentication).toHaveBeenCalledTimes(1));
    oldChallenge.resolve({ challengeId: "old-challenge", options: authenticationOptions });
    await expect(old).resolves.toEqual({ status: "cancelled" });
    passkeyService.cancelActiveCeremony();
    expect(mocks.cancelCeremony).toHaveBeenCalledTimes(1);
    credential.resolve(authenticationResponse);
    await expect(current).resolves.toEqual({ status: "cancelled" });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps SDK loading and RP security failures as authentication failures", async () => {
    mocks.apiFetch.mockResolvedValue({ challengeId: "challenge-1", options: authenticationOptions });
    const loadError = new Error("Unable to load SDK");
    loadBrowser.mockRejectedValueOnce(loadError);
    await expect(passkeyService.authenticate()).rejects.toBe(loadError);
    const securityError = new DOMException("Invalid RP", "SecurityError");
    mocks.startAuthentication.mockRejectedValueOnce(securityError);
    await expect(passkeyService.authenticate()).rejects.toBe(securityError);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });

  it("does not return a verified session after the authentication was cancelled", async () => {
    const verification = deferred<typeof sessionResponse>();
    mocks.apiFetch.mockResolvedValueOnce({ challengeId: "challenge-1", options: authenticationOptions })
      .mockReturnValueOnce(verification.promise);
    const pending = passkeyService.authenticate();
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    passkeyService.cancelActiveCeremony();
    verification.resolve(sessionResponse);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(mocks.writeProductSession).not.toHaveBeenCalled();
  });

  it("cancels registration while the SDK loads without opening or verifying a credential", async () => {
    const loading = deferred<typeof browser>();
    loadBrowser.mockReturnValueOnce(loading.promise);
    mocks.apiFetch.mockResolvedValueOnce({ challengeId: "register-challenge", options: registrationOptions });
    const result = expect(passkeyService.register({ name: "MacBook", currentPassword: "password123" }))
      .rejects.toMatchObject({ name: "AbortError" });
    passkeyService.cancelActiveCeremony();
    loading.resolve(browser);
    await result;
    expect(mocks.startRegistration).not.toHaveBeenCalled();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("does not persist a registration session returned after cancellation", async () => {
    const verification = deferred<typeof sessionResponse>();
    mocks.apiFetch.mockResolvedValueOnce({ challengeId: "register-challenge", options: registrationOptions })
      .mockReturnValueOnce(verification.promise);
    const result = expect(passkeyService.register({ name: "MacBook", currentPassword: "password123" }))
      .rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    passkeyService.cancelActiveCeremony();
    verification.resolve(sessionResponse);
    await result;
    expect(mocks.writeProductSession).not.toHaveBeenCalled();
  });

});
