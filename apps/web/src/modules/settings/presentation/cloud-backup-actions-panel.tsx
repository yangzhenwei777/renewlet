import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Save, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import { LoadingButtonContent } from "./settings-shared-controls";

// 状态与操作区只展示当前 provider 的凭据和 lastStatus；顶部不再伪装全局云备份状态。
interface CloudBackupActionsPanelProps {
  providerLabel: string;
  credentialLabel: string;
  statusLabel: string;
  lastBackupLabel: string;
  lastError?: string | null;
  saveLabel: string;
  busy: boolean;
  disabled?: boolean;
  canCreateSnapshot: boolean;
  isSaving: boolean;
  isTesting: boolean;
  isCreating: boolean;
  onSave: () => void | Promise<void>;
  onTest: () => void | Promise<void>;
  onCreate: () => void | Promise<void>;
}

export function CloudBackupActionsPanel({
  providerLabel,
  credentialLabel,
  statusLabel,
  lastBackupLabel,
  lastError,
  saveLabel,
  busy,
  disabled = false,
  canCreateSnapshot,
  isSaving,
  isTesting,
  isCreating,
  onSave,
  onTest,
  onCreate,
}: CloudBackupActionsPanelProps) {
  const { t } = useI18n();

  return (
    <div className="grid gap-4 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-foreground">{t("settings.cloudBackupStatusActions")}</h3>
      <div className="grid gap-x-6 gap-y-3 rounded-md border border-border bg-background/50 px-3 py-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatusLine label={t("settings.cloudBackupProvider")} value={providerLabel} />
        <StatusLine label={t("settings.cloudBackupCredential")} value={credentialLabel} />
        <StatusLine label={t("settings.cloudBackupLastStatus")} value={statusLabel} />
        <StatusLine label={t("settings.cloudBackupLastBackupAt")} value={lastBackupLabel} />
      </div>

      {lastError ? (
        <div className="flex max-w-5xl gap-2 rounded-md border border-destructive/25 bg-destructive/5 p-3 text-xs leading-5 text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 wrap-break-word">{lastError}</span>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          type="button"
          size="sm"
          className="h-9 w-full justify-center gap-2 sm:w-auto"
          onClick={() => void onSave()}
          disabled={disabled || busy}
          aria-busy={isSaving ? true : undefined}
          aria-label={saveLabel}
        >
          <LoadingButtonContent loading={isSaving} loadingLabel={t("common.saving")}>
            <Save className="h-4 w-4" />
            {saveLabel}
          </LoadingButtonContent>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 w-full justify-center gap-2 border-border sm:w-auto"
          onClick={() => void onTest()}
          disabled={disabled || busy}
          aria-busy={isTesting ? true : undefined}
          aria-label={t("settings.cloudBackupTest")}
        >
          <LoadingButtonContent loading={isTesting} loadingLabel={t("settings.cloudBackupTesting")}>
            <CheckCircle2 className="h-4 w-4" />
            {t("settings.cloudBackupTest")}
          </LoadingButtonContent>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 w-full justify-center gap-2 border-border sm:w-auto"
          onClick={() => void onCreate()}
          disabled={disabled || busy || !canCreateSnapshot}
          aria-busy={isCreating ? true : undefined}
          aria-label={t("settings.cloudBackupCreateNow")}
        >
          <LoadingButtonContent loading={isCreating} loadingLabel={t("settings.cloudBackupCreating")}>
            <Upload className="h-4 w-4" />
            {t("settings.cloudBackupCreateNow")}
          </LoadingButtonContent>
        </Button>
      </div>
    </div>
  );
}

interface StatusLineProps {
  label: string;
  value: ReactNode;
}

function StatusLine({ label, value }: StatusLineProps) {
  return (
    <div className="grid min-w-0 gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-medium text-foreground">{value}</span>
    </div>
  );
}
