import type { MfaTotpSetupResponse } from "@/lib/api/schemas/auth";
import type { MessageKey } from "@/i18n/messages";

// 账号安全区只有一个 overlay 状态机；密码管理器浮层可能把确认事件还给页面，不能让背景 MFA 操作与通行密钥管理并行打开。
export type MfaPasswordAction = "regenerate" | "disable";

export type AccountSecurityDialogState =
  | { type: "none" }
  | { type: "mfa_setup"; setup: MfaTotpSetupResponse }
  | { type: "mfa_password"; action: MfaPasswordAction }
  | { type: "recovery_codes"; codes: string[] }
  | { type: "passkeys_manager" };

export type AuthenticatorDialogState = Exclude<
  AccountSecurityDialogState,
  { type: "none" } | { type: "passkeys_manager" }
>;

export function isAuthenticatorDialogState(
  state: AccountSecurityDialogState,
): state is AuthenticatorDialogState {
  return state.type !== "none" && state.type !== "passkeys_manager";
}

export function accountSecurityDialogCopyKeys(
  state: AuthenticatorDialogState,
): { title: MessageKey; description: MessageKey } {
  if (state.type === "mfa_setup") {
    return {
      title: "settings.mfaSetupTitle",
      description: "settings.mfaSetupDescription",
    };
  }
  if (state.type === "recovery_codes") {
    return {
      title: "settings.mfaRecoveryCodesTitle",
      description: "settings.mfaRecoveryCodesDescription",
    };
  }
  return state.action === "disable"
    ? {
        title: "settings.mfaDisableTitle",
        description: "settings.mfaDisableDescription",
      }
    : {
        title: "settings.mfaRegenerateTitle",
        description: "settings.mfaRegenerateDescription",
      };
}
