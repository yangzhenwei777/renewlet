import { apiFetch } from "@/lib/api-client";
import {
  mfaCurrentPasswordBodySchema,
  mfaRecoveryCodesResponseSchema,
  mfaStatusResponseSchema,
  mfaTotpEnableBodySchema,
  mfaTotpSetupResponseSchema,
  sessionResponseSchema,
  type MfaCurrentPasswordBody,
  type MfaStatusResponse,
  type MfaTotpEnableBody,
  type MfaTotpSetupResponse,
  type SessionResponse,
} from "@/lib/api/schemas/auth";
import { writeProductSession } from "@/services/product-session";

function writeRenewedSession(data: SessionResponse) {
  writeProductSession({ type: data.type, session: data.session, user: data.user });
}

/** 身份验证器只覆盖 TOTP/恢复码；通行密钥走独立 Passkey service，避免二者在前端边界混用。 */
export const mfaService = {
  async status(signal?: AbortSignal): Promise<MfaStatusResponse> {
    return await apiFetch("/api/app/auth/mfa/status", mfaStatusResponseSchema, signal ? { signal } : undefined);
  },

  async startTotpSetup(): Promise<MfaTotpSetupResponse> {
    return await apiFetch("/api/app/auth/mfa/totp/setup", mfaTotpSetupResponseSchema, {
      method: "POST",
      body: "{}",
    });
  },

  async enableTotp(body: MfaTotpEnableBody): Promise<string[]> {
    const payload = mfaTotpEnableBodySchema.parse(body);
    const data = await apiFetch("/api/app/auth/mfa/totp/enable", mfaRecoveryCodesResponseSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    // 后端会在账号安全状态切换后废弃旧 cookie session；必须先写入续签后的非密 session 视图，再让设置页刷新状态查询。
    writeRenewedSession(data);
    return data.recoveryCodes;
  },

  async regenerateRecoveryCodes(body: MfaCurrentPasswordBody): Promise<string[]> {
    const payload = mfaCurrentPasswordBodySchema.parse(body);
    const data = await apiFetch("/api/app/auth/mfa/recovery/regenerate", mfaRecoveryCodesResponseSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    writeRenewedSession(data);
    return data.recoveryCodes;
  },

  async disable(body: MfaCurrentPasswordBody): Promise<void> {
    const payload = mfaCurrentPasswordBodySchema.parse(body);
    const data = await apiFetch("/api/app/auth/mfa/disable", sessionResponseSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    writeRenewedSession(data);
  },
};
