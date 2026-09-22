import { useLayoutEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogModulePending } from "@/components/ui/dialog-module-pending";
import { createLazyDialogResource, useLazyDialogSession } from "@/hooks/use-lazy-dialog-session";
import { useI18n } from "@/i18n/I18nProvider";
import type { AccountSecurityDialogsProps } from "./account-security-dialogs";
import {
  accountSecurityDialogCopyKeys,
  isAuthenticatorDialogState,
  type AuthenticatorDialogState,
} from "./account-security-dialog-state";
import {
  AccountPasskeysManagerDialog,
  type AccountPasskeysManagerDialogProps,
} from "./account-passkeys-manager-dialog";

const accountSecurityDialogResource = createLazyDialogResource(() =>
  import("./account-security-dialogs").then((module) => module.AccountSecurityDialogContent),
);

export function preloadAccountSecurityDialogs(): void {
  void accountSecurityDialogResource.load().catch(() => undefined);
}

type DeferredAccountSecurityDialogsProps = AccountSecurityDialogsProps &
  Omit<AccountPasskeysManagerDialogProps, "open" | "onOpenChange"> & {
    onPasskeysOpenChange: (open: boolean) => void;
  };

/** 账号安全入口保留单一状态机；二维码和凭据管理表单仅在对应会话存活期间装载。 */
export function DeferredAccountSecurityDialogs({
  state,
  onStateChange,
  onPasskeysOpenChange,
  ...passkeysProps
}: DeferredAccountSecurityDialogsProps) {
  const { t } = useI18n();
  const securityDialogOpen = isAuthenticatorDialogState(state);
  const [activeSecurityState, setActiveSecurityState] = useState<AuthenticatorDialogState | null>(() => (
    isAuthenticatorDialogState(state) ? state : null
  ));
  const { value: Content, error, sessionKey } = useLazyDialogSession(securityDialogOpen, accountSecurityDialogResource);
  const dialogState = isAuthenticatorDialogState(state) ? state : activeSecurityState;
  const pendingCopy = dialogState ? accountSecurityDialogCopyKeys(dialogState) : null;

  useLayoutEffect(() => {
    if (isAuthenticatorDialogState(state)) setActiveSecurityState(state);
  }, [state]);

  if (securityDialogOpen && error) throw error;

  if (state.type === "passkeys_manager") {
    return (
      <AccountPasskeysManagerDialog
        {...passkeysProps}
        open
        onOpenChange={onPasskeysOpenChange}
      />
    );
  }

  return (
    <Dialog
      open={securityDialogOpen}
      onOpenChange={(open) => {
        if (!open) onStateChange({ type: "none" });
      }}
    >
      <DialogContent
        closeLabel={t("common.close")}
        dismissMode="explicit"
        aria-busy={Content && dialogState ? undefined : true}
        data-testid={Content && dialogState ? undefined : "account-security-dialog-loading"}
      >
        {Content && dialogState
          ? <Content key={sessionKey} state={dialogState} onStateChange={onStateChange} />
          : (
            <>
              <DialogHeader>
                <DialogTitle>{pendingCopy ? t(pendingCopy.title) : t("common.loading")}</DialogTitle>
                <DialogDescription>
                  {pendingCopy ? t(pendingCopy.description) : t("common.loading")}
                </DialogDescription>
              </DialogHeader>
              <DialogModulePending label={t("common.loading")} />
            </>
          )}
      </DialogContent>
    </Dialog>
  );
}
