import { useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { mfaService } from "@/services/mfa-service";
import { useI18n } from "@/i18n/I18nProvider";
import type { MfaTotpSetupResponse } from "@/lib/api/schemas/auth";
import { MFA_STATUS_QUERY_KEY } from "./account-security-query-keys";
import type { MfaPasswordAction } from "./account-security-dialog-state";
import { preloadAccountSecurityDialogs } from "./account-security-dialogs-loader";
import { toSettingsReadState } from "../application/settings-read-state";
import { ManagerDataBoundary } from "./manager-data-boundary";

export interface AccountMfaSectionProps {
  disabled?: boolean;
  onSetupReady: (setup: MfaTotpSetupResponse) => void;
  onPasswordAction: (action: MfaPasswordAction) => void;
}

export function AccountMfaSection({
  disabled = false,
  onSetupReady,
  onPasswordAction,
}: AccountMfaSectionProps) {
  const { t } = useI18n();

  const statusQuery = useQuery({
    queryKey: MFA_STATUS_QUERY_KEY,
    queryFn: ({ signal }) => mfaService.status(signal),
    staleTime: 30_000,
  });

  const status = statusQuery.data;
  const readState = toSettingsReadState(statusQuery);
  const enabled = Boolean(status?.enabled);
  const statusLabel = readState.isInitialLoading
    ? t("common.loading")
    : !readState.hasData && readState.error
      ? t("settings.statusUnknown")
      : readState.error
        ? t("settings.notUpdated")
        : enabled
          ? t("common.enabled")
          : t("common.disabled");

  const setupMutation = useMutation({
    mutationFn: () => mfaService.startTotpSetup(),
    onSuccess: (setup) => {
      onSetupReady(setup);
    },
    onError: (error) => {
      toast.error(t("settings.mfaSetupFailed"), {
        description: getDisplayErrorMessage(error, t("settings.mfaSetupFailedDescription")),
      });
    },
  });

  const methodLabels = status?.methods.map((method) => {
    if (method === "totp") return t("settings.mfaMethodTotp");
    return t("settings.mfaMethodRecovery");
  }) ?? [];

  return (
    <div className="grid gap-3 rounded-md border border-border bg-secondary/20 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-foreground">{t("settings.mfaTitle")}</h3>
            <Badge variant={enabled ? "default" : "secondary"}>
              {statusLabel}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{t("settings.mfaHelp")}</p>
        </div>
        {readState.hasData ? <Button
          type="button"
          size="sm"
          variant={enabled ? "outline" : "default"}
          disabled={disabled || setupMutation.isPending}
          onFocus={preloadAccountSecurityDialogs}
          onPointerEnter={preloadAccountSecurityDialogs}
          onTouchStart={preloadAccountSecurityDialogs}
          onClick={() => setupMutation.mutate()}
        >
          <ShieldCheck className="h-4 w-4" />
          {enabled ? t("settings.mfaAddAuthenticator") : t("settings.mfaEnable")}
        </Button> : null}
      </div>

      <ManagerDataBoundary state={readState}>
      <div className="grid gap-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-2">
          {methodLabels.length > 0 ? methodLabels.map((label) => (
            <Badge key={label} variant="outline">{label}</Badge>
          )) : (
            <span>{t("settings.mfaNoMethods")}</span>
          )}
        </div>
        {status ? (
          <p>{t("settings.mfaRecoveryRemaining", { count: status.recoveryCodesRemaining })}</p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !enabled}
          onFocus={preloadAccountSecurityDialogs}
          onPointerEnter={preloadAccountSecurityDialogs}
          onTouchStart={preloadAccountSecurityDialogs}
          onClick={() => onPasswordAction("regenerate")}
        >
          <RefreshCw className="h-4 w-4" />
          {t("settings.mfaRegenerateRecovery")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !enabled}
          onFocus={preloadAccountSecurityDialogs}
          onPointerEnter={preloadAccountSecurityDialogs}
          onTouchStart={preloadAccountSecurityDialogs}
          onClick={() => onPasswordAction("disable")}
        >
          <ShieldOff className="h-4 w-4" />
          {t("settings.mfaDisable")}
        </Button>
      </div>
      </ManagerDataBoundary>
    </div>
  );
}
