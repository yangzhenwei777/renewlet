import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { apiFetch } from "@/lib/api-client";
import {
  passkeyAuthenticationOptionsResponseSchema,
  passkeyAuthenticateOptionsBodySchema,
  passkeyAuthenticateVerifyBodySchema,
  passkeyDeleteBodySchema,
  passkeyRegistrationOptionsResponseSchema,
  passkeyRegisterOptionsBodySchema,
  passkeyRegisterVerifyBodySchema,
  passkeysResponseSchema,
  sessionResponseSchema,
  type Passkey,
  type PasskeyAuthenticationOptions as PasskeyWebAuthnAuthenticationOptions,
  type PasskeyDeleteBody,
  type PasskeyRegistrationOptions,
  type PasskeyRegisterOptionsBody,
  type SessionResponse,
} from "@/lib/api/schemas/auth";
import { writeProductSession } from "@/services/product-session";

type PasskeyAuthenticationOptions = { useBrowserAutofill?: boolean };

/** Passkey 登录的浏览器 ceremony 结果；`cancelled` 是用户/浏览器中止，不等同于认证失败。 */
export type PasskeyAuthenticationResult =
  | { status: "authenticated"; session: SessionResponse }
  | { status: "cancelled" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordFromError(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function errorName(value: unknown): string | null {
  if (value instanceof Error && value.name) return value.name;
  const record = recordFromError(value);
  const name = record?.["name"];
  return typeof name === "string" && name.trim() ? name : null;
}

function errorCode(value: unknown): string | null {
  const record = recordFromError(value);
  const code = record?.["code"];
  return typeof code === "string" && code.trim() ? code : null;
}

function errorCause(value: unknown): unknown {
  return recordFromError(value)?.["cause"];
}

// SimpleWebAuthn 和浏览器会把“取消/未选择凭据”包装成不同 Error 形状；只有用户中性退出才静默，RP/origin 等安全错误继续 fail closed。
function isWebAuthnAuthenticationCancelled(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "ERROR_CEREMONY_ABORTED") return true;

  const name = errorName(error);
  if (name === "AbortError" || name === "NotAllowedError") return true;

  return code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" && errorName(errorCause(error)) === "NotAllowedError";
}

function registrationOptionsForBrowser(options: PasskeyRegistrationOptions): PublicKeyCredentialCreationOptionsJSON {
  return {
    rp: { id: options.rp.id, name: options.rp.name },
    user: { id: options.user.id, name: options.user.name, displayName: options.user.displayName },
    challenge: options.challenge,
    pubKeyCredParams: options.pubKeyCredParams.map((parameter) => ({ ...parameter })),
    timeout: options.timeout,
    excludeCredentials: options.excludeCredentials.map((credential) => ({
      id: credential.id,
      type: credential.type,
      transports: [...credential.transports],
    })),
    authenticatorSelection: { ...options.authenticatorSelection },
    hints: [...options.hints],
    attestation: options.attestation,
    extensions: { ...options.extensions },
  };
}

function authenticationOptionsForBrowser(options: PasskeyWebAuthnAuthenticationOptions): PublicKeyCredentialRequestOptionsJSON {
  return {
    challenge: options.challenge,
    timeout: options.timeout,
    rpId: options.rpId,
    allowCredentials: options.allowCredentials.map((credential) => ({
      id: credential.id,
      type: credential.type,
      transports: [...credential.transports],
    })),
    userVerification: options.userVerification,
    hints: [...options.hints],
  };
}

type PasskeyBrowser = Pick<typeof import("@simplewebauthn/browser"), "startAuthentication" | "startRegistration"> & {
  WebAuthnAbortService: { cancelCeremony(): void };
};

/** 每个 service 独占当前 ceremony；取消无需加载 SDK，也不能由旧请求结束新流程。 */
export function createPasskeyService(loadBrowser: () => Promise<PasskeyBrowser> = () => import("@simplewebauthn/browser")) {
  let activeCeremony: AbortController | undefined;

  async function runCeremony<Options, Result>(
    prepare: (signal: AbortSignal) => Promise<Options>,
    perform: (browser: PasskeyBrowser, options: Options, signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    activeCeremony?.abort();
    const controller = new AbortController();
    activeCeremony = controller;
    const { signal } = controller;
    try {
      // challenge 与代码无依赖；任一等待期间失效，都必须在原生凭据流程开始前检查取消。
      const [options, browser] = await Promise.all([prepare(signal), loadBrowser()]);
      signal.throwIfAborted();
      const cancelBrowser = () => browser.WebAuthnAbortService.cancelCeremony();
      signal.addEventListener("abort", cancelBrowser, { once: true });
      try {
        return await perform(browser, options, signal);
      } finally {
        signal.removeEventListener("abort", cancelBrowser);
      }
    } catch (error) {
      // HTTP 边界会包装 AbortError；取消身份属于本次流程，不能依赖下层错误形状。
      signal.throwIfAborted();
      throw error;
    } finally {
      if (activeCeremony === controller) activeCeremony = undefined;
    }
  }

  return {
    cancelActiveCeremony(): void {
      activeCeremony?.abort();
    },

    async list(signal?: AbortSignal): Promise<Passkey[]> {
      const data = await apiFetch("/api/app/auth/passkeys", passkeysResponseSchema, signal ? { signal } : undefined);
      return data.passkeys;
    },

    async register(body: PasskeyRegisterOptionsBody): Promise<void> {
      const payload = passkeyRegisterOptionsBodySchema.parse(body);
      await runCeremony(
        (signal) => apiFetch("/api/app/auth/passkeys/register/options", passkeyRegistrationOptionsResponseSchema, {
          method: "POST", body: JSON.stringify(payload), signal,
        }),
        async (browser, options, signal) => {
          const response = await browser.startRegistration({ optionsJSON: registrationOptionsForBrowser(options.options) });
          // 浏览器可能在取消后仍交还已选凭据；只有当前流程能消费 challenge 或更新产品 session。
          signal.throwIfAborted();
          const verifyPayload = passkeyRegisterVerifyBodySchema.parse({ challengeId: options.challengeId, name: payload.name, response });
          const data = await apiFetch("/api/app/auth/passkeys/register/verify", sessionResponseSchema, {
            method: "POST", body: JSON.stringify(verifyPayload), signal,
          });
          signal.throwIfAborted();
          writeProductSession(data);
        },
      );
    },

    async authenticate(options: PasskeyAuthenticationOptions = {}): Promise<PasskeyAuthenticationResult> {
      const payload = passkeyAuthenticateOptionsBodySchema.parse({});
      try {
        return await runCeremony(
          (signal) => apiFetch("/api/app/auth/passkeys/authenticate/options", passkeyAuthenticationOptionsResponseSchema, {
            authMode: "none", method: "POST", body: JSON.stringify(payload), signal,
          }),
          async (browser, webAuthnOptions, signal): Promise<PasskeyAuthenticationResult> => {
            // origin/RP/counter 仍由后端验证；前端只传服务端 challenge 与浏览器凭据。
            const authenticationOptions: { optionsJSON: PublicKeyCredentialRequestOptionsJSON; useBrowserAutofill?: boolean } = {
              optionsJSON: authenticationOptionsForBrowser(webAuthnOptions.options),
            };
            if (typeof options.useBrowserAutofill === "boolean") authenticationOptions.useBrowserAutofill = options.useBrowserAutofill;
            const response = await browser.startAuthentication(authenticationOptions);
            signal.throwIfAborted();
            const verifyPayload = passkeyAuthenticateVerifyBodySchema.parse({ challengeId: webAuthnOptions.challengeId, response });
            const session = await apiFetch("/api/app/auth/passkeys/authenticate/verify", sessionResponseSchema, {
              authMode: "none", method: "POST", body: JSON.stringify(verifyPayload), signal,
            });
            signal.throwIfAborted();
            return { status: "authenticated", session };
          },
        );
      } catch (error) {
        // 用户取消是中性退出；加载、API 与 RP/origin 安全错误仍交还认证边界。
        if (isWebAuthnAuthenticationCancelled(error)) return { status: "cancelled" };
        throw error;
      }
    },

    async delete(id: string, body: PasskeyDeleteBody): Promise<void> {
      const payload = passkeyDeleteBodySchema.parse(body);
      const data = await apiFetch(`/api/app/auth/passkeys/${encodeURIComponent(id)}/delete`, sessionResponseSchema, {
        method: "POST", body: JSON.stringify(payload),
      });
      writeProductSession(data);
    },
  };
}

export const passkeyService = createPasskeyService();
