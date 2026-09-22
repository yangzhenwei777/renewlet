import {
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
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
  type PasskeyAuthenticationOptionsResponse,
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

/** 通行密钥是独立 WebAuthn 登录能力；它不消费 MFA ticket，也不出现在身份验证器 methods 中。 */
export const passkeyService = {
  cancelActiveCeremony(): void {
    // SimpleWebAuthn ceremony 挂在浏览器凭据层；SPA 路由/密码登录状态失效时必须显式 abort 原生弹窗。
    WebAuthnAbortService.cancelCeremony();
  },

  async list(signal?: AbortSignal): Promise<Passkey[]> {
    const data = await apiFetch("/api/app/auth/passkeys", passkeysResponseSchema, signal ? { signal } : undefined);
    return data.passkeys;
  },

  async register(body: PasskeyRegisterOptionsBody): Promise<void> {
    const payload = passkeyRegisterOptionsBodySchema.parse(body);
    const options = await apiFetch("/api/app/auth/passkeys/register/options", passkeyRegistrationOptionsResponseSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    // WebAuthn challenge 只在本次浏览器凭据流程内存中流转；verify 后服务端会消费并更新 credential。
    const response = await startRegistration({
      optionsJSON: registrationOptionsForBrowser(options.options),
    });
    const verifyPayload = passkeyRegisterVerifyBodySchema.parse({
      challengeId: options.challengeId,
      name: payload.name,
      response,
    });
    const data = await apiFetch("/api/app/auth/passkeys/register/verify", sessionResponseSchema, {
      method: "POST",
      body: JSON.stringify(verifyPayload),
    });
    writeProductSession(data);
  },

  async startAuthentication(): Promise<PasskeyAuthenticationOptionsResponse> {
    const payload = passkeyAuthenticateOptionsBodySchema.parse({});
    return await apiFetch("/api/app/auth/passkeys/authenticate/options", passkeyAuthenticationOptionsResponseSchema, {
      authMode: "none",
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async authenticate(options: PasskeyAuthenticationOptions = {}): Promise<PasskeyAuthenticationResult> {
    const webAuthnOptions = await passkeyService.startAuthentication();
    // 前端只把服务端 challenge 交给浏览器凭据 API；origin/RP/counter 由后端 WebAuthn 库验证并签 session。
    const authenticationOptions: { optionsJSON: PublicKeyCredentialRequestOptionsJSON; useBrowserAutofill?: boolean } = {
      optionsJSON: authenticationOptionsForBrowser(webAuthnOptions.options),
    };
    if (typeof options.useBrowserAutofill === "boolean") {
      authenticationOptions.useBrowserAutofill = options.useBrowserAutofill;
    }
    let response: Awaited<ReturnType<typeof startAuthentication>>;
    try {
      response = await startAuthentication(authenticationOptions);
    } catch (error) {
      // options 请求会先建立短期 challenge；没有浏览器 credential 时绝不能 verify、写 session 或上报成登录失败。
      if (isWebAuthnAuthenticationCancelled(error)) return { status: "cancelled" };
      throw error;
    }
    const verifyPayload = passkeyAuthenticateVerifyBodySchema.parse({
      challengeId: webAuthnOptions.challengeId,
      response,
    });
    const session = await apiFetch("/api/app/auth/passkeys/authenticate/verify", sessionResponseSchema, {
      authMode: "none",
      method: "POST",
      body: JSON.stringify(verifyPayload),
    });
    return { status: "authenticated", session };
  },

  async delete(id: string, body: PasskeyDeleteBody): Promise<void> {
    const payload = passkeyDeleteBodySchema.parse(body);
    const data = await apiFetch(`/api/app/auth/passkeys/${encodeURIComponent(id)}/delete`, sessionResponseSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    writeProductSession(data);
  },
};
