import { useRef, useState } from "react";
import { Cloud } from "lucide-react";
import { CloudBackupErrorDetailsDialog } from "@/components/cloud-backup-error-details-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/i18n/I18nProvider";
import { CloudBackupActionsPanel } from "./cloud-backup-actions-panel";
import { CloudBackupConnectionForm, type CloudBackupConnectionField } from "./cloud-backup-connection-form";
import { CloudBackupPolicyForm } from "./cloud-backup-policy-form";
import { CloudBackupSnapshotList } from "./cloud-backup-snapshot-list";
import { LoadingButtonContent } from "./settings-shared-controls";
import { getSettingsSectionClassName } from "./settings-layout";
import type { CloudBackupController } from "../application/use-cloud-backup-controller";
import type { CloudBackupProvider, CloudBackupSnapshot } from "@/lib/api/schemas/cloud-backup";
import { ManagerDataBoundary } from "./manager-data-boundary";
import { SettingsSectionHeader } from "./settings-section-header";

interface CloudBackupSectionProps {
  id?: string;
  className?: string;
  controller: CloudBackupController;
  disabled?: boolean;
}

type CloudBackupStatus = "idle" | "success" | "failed";

// Section 只负责编排当前 tab provider；策略、状态、快照和错误详情都来自 controller 的 provider-scoped 视图。
export function CloudBackupSection({
  id,
  className,
  controller,
  disabled = false,
}: CloudBackupSectionProps) {
  const { t, formatDateTime } = useI18n();
  const [deleteTarget, setDeleteTarget] = useState<CloudBackupSnapshot | null>(null);
  const deleteFocusFallbackRef = useRef<HTMLHeadingElement>(null);
  const {
    config,
    form,
    snapshots,
    credentialSet,
    canCreateSnapshot,
    isSaving,
    isTesting,
    isCreating,
    isDownloading,
    isDeleting,
    restoringSnapshotKey,
    deletingSnapshotKey,
    hasUnsavedChanges,
    snapshotsErrorMessage,
    cloudBackupErrorDetails,
    cloudBackupErrorDetailsOpen,
    setCloudBackupErrorDetailsOpen,
    openSnapshotsErrorDetails,
    updateForm,
    saveConfig,
    testConfig,
    createSnapshot,
    restoreSnapshot,
    deleteSnapshot,
  } = controller;
  const busy = isSaving || isTesting || isCreating || isDownloading || isDeleting;
  const providerStatus = config.data?.statusByProvider[form.provider] ?? null;
  const status = providerStatus?.lastStatus ?? "idle";
  const statusLabel = statusLabelFor(status, {
    idle: t("settings.cloudBackupStatusIdle"),
    success: t("settings.cloudBackupStatusSuccess"),
    failed: t("settings.cloudBackupStatusFailed"),
  });
  const credentialLabel = credentialSet ? t("settings.cloudBackupCredentialSaved") : t("settings.cloudBackupCredentialMissing");
  const secretPlaceholder = credentialSet ? t("settings.cloudBackupSecretPlaceholderSaved") : t("settings.cloudBackupSecretPlaceholder");
  const saveLabel = hasUnsavedChanges ? t("settings.cloudBackupSave") : t("settings.cloudBackupSaveAgain");
  const providerLabel = providerLabelFor(form.provider, {
    webdav: t("settings.cloudBackupProviderWebdav"),
    s3: t("settings.cloudBackupProviderS3"),
  });
  const lastBackupLabel = providerStatus?.lastBackupAt
    ? formatDateTime(providerStatus.lastBackupAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : t("settings.cloudBackupNeverBackedUp");
  const deleteDialogBusy = deleteTarget ? deletingSnapshotKey === cloudBackupSnapshotKey(deleteTarget) : false;
  const sectionSummary = config.isInitialLoading
    ? t("common.loading")
    : !config.hasData && config.error
      ? t("settings.statusUnknown")
      : config.error
        ? t("settings.notUpdated")
        : t("settings.cloudBackupSummary", {
          provider: providerLabel,
          credential: credentialLabel,
          status: statusLabel,
        });

  return (
    <section id={id} className={getSettingsSectionClassName(className)}>
      <SettingsSectionHeader
        className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
        icon={<Cloud className="mt-0.5 h-5 w-5 shrink-0 text-primary" />}
        title={t("settings.cloudBackup")}
        help={t("settings.cloudBackupHelp")}
        summary={sectionSummary}
      />
      <ManagerDataBoundary state={config}>
      <div className="grid gap-5">
        <CloudBackupConnectionForm
          form={form}
          secretPlaceholder={secretPlaceholder}
          disabled={disabled}
          onProviderChange={(provider) => updateForm("provider", provider)}
          onTextChange={(field: CloudBackupConnectionField, value) => updateForm(field, value)}
        />
        <CloudBackupPolicyForm
          scheduleEnabled={form.scheduleEnabled}
          scheduleFrequency={form.scheduleFrequency}
          scheduleTime={form.scheduleTime}
          scheduleWeekday={form.scheduleWeekday}
          retention={form.retention}
          busy={busy}
          disabled={disabled}
          onScheduleEnabledChange={(checked) => updateForm("scheduleEnabled", checked)}
          onFrequencyChange={(frequency) => updateForm("scheduleFrequency", frequency)}
          onScheduleTimeChange={(value) => updateForm("scheduleTime", value)}
          onScheduleWeekdayChange={(weekday) => updateForm("scheduleWeekday", weekday)}
          onRetentionChange={(value) => updateForm("retention", value)}
        />
        <CloudBackupActionsPanel
          providerLabel={providerLabel}
          credentialLabel={credentialLabel}
          statusLabel={statusLabel}
          lastBackupLabel={lastBackupLabel}
          lastError={providerStatus?.lastError ?? null}
          saveLabel={saveLabel}
          busy={busy}
          disabled={disabled}
          canCreateSnapshot={canCreateSnapshot}
          isSaving={isSaving}
          isTesting={isTesting}
          isCreating={isCreating}
          onSave={saveConfig}
          onTest={testConfig}
          onCreate={createSnapshot}
        />
        <CloudBackupSnapshotList
          state={snapshots}
          busy={busy}
          disabled={disabled}
          restoringSnapshotKey={restoringSnapshotKey}
          deletingSnapshotKey={deletingSnapshotKey}
          canRefreshSnapshots={canCreateSnapshot}
          snapshotsErrorMessage={snapshotsErrorMessage}
          focusFallbackRef={deleteFocusFallbackRef}
          onOpenErrorDetails={openSnapshotsErrorDetails}
          onRestore={restoreSnapshot}
          onDelete={setDeleteTarget}
        />
      </div>
      </ManagerDataBoundary>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => {
        if (!open && !deleteDialogBusy) setDeleteTarget(null);
      }}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // 删除成功会卸载快照行，回到稳定的列表标题，避免焦点落到已移除按钮或尚未解锁的操作。
            deleteFocusFallbackRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.cloudBackupDeleteTitle", { name: deleteTarget?.filename ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("settings.cloudBackupDeleteDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disabled || deleteDialogBusy}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={disabled || deleteDialogBusy}
              aria-busy={deleteDialogBusy ? true : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (disabled) return;
                const snapshot = deleteTarget;
                if (!snapshot) return;
                void deleteSnapshot(snapshot).finally(() => setDeleteTarget(null));
              }}
              className="min-w-21 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <LoadingButtonContent loading={deleteDialogBusy} loadingLabel={t("settings.cloudBackupDeleting")}>
                {t("common.delete")}
              </LoadingButtonContent>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CloudBackupErrorDetailsDialog
        open={cloudBackupErrorDetailsOpen}
        details={cloudBackupErrorDetails}
        onOpenChange={setCloudBackupErrorDetailsOpen}
      />
    </section>
  );
}

function statusLabelFor(status: CloudBackupStatus, labels: Record<CloudBackupStatus, string>): string {
  return labels[status];
}

function providerLabelFor(provider: CloudBackupProvider, labels: Record<CloudBackupProvider, string>): string {
  return labels[provider];
}

function cloudBackupSnapshotKey(snapshot: CloudBackupSnapshot): string {
  return `${snapshot.provider}:${snapshot.id}`;
}
