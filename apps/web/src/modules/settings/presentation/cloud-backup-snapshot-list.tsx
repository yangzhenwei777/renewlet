import { useState, type RefObject } from "react";
import { AlertTriangle, Archive, Download, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { preloadImportDataDialog } from "@/components/import-data-dialog-loader";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MobileBottomDrawerContent, MobileDrawerRoot } from "@/components/ui/mobile-drawer";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { LoadingButtonContent } from "./settings-shared-controls";
import type { CloudBackupSnapshot } from "@/lib/api/schemas/cloud-backup";
import type { SettingsReadState } from "../application/settings-read-state";
import { ManagerDataBoundary } from "./manager-data-boundary";

const SUMMARY_SNAPSHOT_LIMIT = 2;

interface CloudBackupSnapshotListProps {
  state: SettingsReadState<CloudBackupSnapshot[]>;
  busy: boolean;
  disabled?: boolean;
  restoringSnapshotKey: string | null;
  deletingSnapshotKey: string | null;
  canRefreshSnapshots: boolean;
  snapshotsErrorMessage: string | null;
  focusFallbackRef?: RefObject<HTMLHeadingElement | null>;
  onOpenErrorDetails: () => void;
  onRestore: (snapshot: CloudBackupSnapshot) => void | Promise<void>;
  onDelete: (snapshot: CloudBackupSnapshot) => void;
}

export function CloudBackupSnapshotList({
  state,
  busy,
  disabled = false,
  restoringSnapshotKey,
  deletingSnapshotKey,
  canRefreshSnapshots,
  snapshotsErrorMessage,
  focusFallbackRef,
  onOpenErrorDetails,
  onRestore,
  onDelete,
}: CloudBackupSnapshotListProps) {
  const { t, formatDateTime } = useI18n();
  const [fullListOpen, setFullListOpen] = useState(false);
  const snapshots = state.data ?? [];
  const isMobile = useMediaQuery("(max-width: 767px)");
  const summarySnapshots = snapshots.slice(0, SUMMARY_SNAPSHOT_LIMIT);
  const hasMoreSnapshots = snapshots.length > SUMMARY_SNAPSHOT_LIMIT;
  const title = t("settings.cloudBackupSnapshots");
  const description = t("settings.cloudBackupSnapshotsHelp");
  const refreshLabel = t("settings.cloudBackupRefresh");
  const refreshDisabled = disabled || busy || state.isRefreshing || !canRefreshSnapshots;
  const shouldRenderFullListOverlay = fullListOpen && !state.isInitialLoading && snapshots.length > 0;
  const rowLabels = {
    restore: t("settings.cloudBackupRestore"),
    restoring: t("settings.cloudBackupRestoring"),
    delete: t("common.delete"),
    deleting: t("settings.cloudBackupDeleting"),
    restoreNamed: (name: string) => t("settings.cloudBackupRestoreNamed", { name }),
    restoringNamed: (name: string) => t("settings.cloudBackupRestoringNamed", { name }),
    deleteNamed: (name: string) => t("settings.cloudBackupDeleteNamed", { name }),
    deletingNamed: (name: string) => t("settings.cloudBackupDeletingNamed", { name }),
    webdavProvider: t("settings.cloudBackupProviderWebdav"),
    s3Provider: t("settings.cloudBackupProviderS3"),
  };
  const formatSnapshotDate = (snapshot: CloudBackupSnapshot) =>
    formatDateTime(snapshot.createdAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="grid gap-3 border-t border-border pt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 ref={focusFallbackRef} tabIndex={-1} className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        <SnapshotRefreshButton
          disabled={refreshDisabled}
          isRefreshing={state.isRefreshing}
          label={refreshLabel}
          onRefresh={state.retry}
          className="sm:shrink-0"
        />
      </div>

      <ManagerDataBoundary state={state}>
      {snapshots.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-background px-3 py-4 text-sm text-muted-foreground">{t("settings.cloudBackupSnapshotsEmpty")}</div>
      ) : (
        <>
          {/* 设置页只保留最近快照作为操作摘要；完整列表放进用户主动打开的二级界面，避免 provider 切换和大量快照重排整页。 */}
          <SnapshotRows
            snapshots={summarySnapshots}
            busy={disabled || busy}
            restoringSnapshotKey={restoringSnapshotKey}
            deletingSnapshotKey={deletingSnapshotKey}
            rowLabels={rowLabels}
            formatSnapshotDate={formatSnapshotDate}
            onRestore={onRestore}
            onDelete={onDelete}
          />
          {hasMoreSnapshots ? (
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" className="border-border" onClick={() => setFullListOpen(true)}>
                {t("settings.cloudBackupSnapshotsViewAll", { count: snapshots.length })}
              </Button>
            </div>
          ) : null}
        </>
      )}
      </ManagerDataBoundary>
      {snapshotsErrorMessage ? (
        <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={onOpenErrorDetails}>
          {t("settings.cloudBackupUpstreamOpen")}
        </Button>
      ) : null}
      {shouldRenderFullListOverlay ? (
        <CloudBackupSnapshotListOverlay
          open={fullListOpen}
          onOpenChange={setFullListOpen}
          isMobile={isMobile}
          title={title}
          description={description}
          closeLabel={t("common.close")}
          refreshLabel={refreshLabel}
          refreshDisabled={refreshDisabled}
          isRefreshing={state.isRefreshing}
          snapshots={snapshots}
          snapshotsErrorMessage={snapshotsErrorMessage}
          busy={busy}
          disabled={disabled}
          restoringSnapshotKey={restoringSnapshotKey}
          deletingSnapshotKey={deletingSnapshotKey}
          rowLabels={rowLabels}
          formatSnapshotDate={formatSnapshotDate}
          onRefresh={state.retry}
          onOpenErrorDetails={onOpenErrorDetails}
          onRestore={onRestore}
          onDelete={onDelete}
        />
      ) : null}
    </div>
  );
}

interface SnapshotRowsProps {
  snapshots: CloudBackupSnapshot[];
  busy: boolean;
  restoringSnapshotKey: string | null;
  deletingSnapshotKey: string | null;
  rowLabels: SnapshotRowLabels;
  formatSnapshotDate: (snapshot: CloudBackupSnapshot) => string;
  onRestore: (snapshot: CloudBackupSnapshot) => void | Promise<void>;
  onDelete: (snapshot: CloudBackupSnapshot) => void;
}

function SnapshotRows({
  snapshots,
  busy,
  restoringSnapshotKey,
  deletingSnapshotKey,
  rowLabels,
  formatSnapshotDate,
  onRestore,
  onDelete,
}: SnapshotRowsProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      {snapshots.map((snapshot) => (
        <SnapshotRow
          key={`${snapshot.provider}:${snapshot.id}`}
          snapshot={snapshot}
          busy={busy}
          isRestoring={restoringSnapshotKey === snapshotKey(snapshot)}
          isDeleting={deletingSnapshotKey === snapshotKey(snapshot)}
          restoreLabel={rowLabels.restore}
          restoringLabel={rowLabels.restoring}
          deleteLabel={rowLabels.delete}
          deletingLabel={rowLabels.deleting}
          restoreAriaLabel={rowLabels.restoreNamed(snapshot.filename)}
          restoringAriaLabel={rowLabels.restoringNamed(snapshot.filename)}
          deleteAriaLabel={rowLabels.deleteNamed(snapshot.filename)}
          deletingAriaLabel={rowLabels.deletingNamed(snapshot.filename)}
          providerLabel={providerLabelFor(snapshot.provider, {
            webdav: rowLabels.webdavProvider,
            s3: rowLabels.s3Provider,
          })}
          formattedDate={formatSnapshotDate(snapshot)}
          onRestore={onRestore}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

interface CloudBackupSnapshotListOverlayProps extends SnapshotRowsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isMobile: boolean;
  title: string;
  description: string;
  closeLabel: string;
  refreshLabel: string;
  refreshDisabled: boolean;
  isRefreshing: boolean;
  snapshotsErrorMessage: string | null;
  disabled: boolean;
  onRefresh: () => void | Promise<void>;
  onOpenErrorDetails: () => void;
}

function CloudBackupSnapshotListOverlay({
  open,
  onOpenChange,
  isMobile,
  title,
  description,
  closeLabel,
  refreshLabel,
  refreshDisabled,
  isRefreshing,
  snapshots,
  snapshotsErrorMessage,
  disabled,
  busy,
  restoringSnapshotKey,
  deletingSnapshotKey,
  rowLabels,
  formatSnapshotDate,
  onRefresh,
  onOpenErrorDetails,
  onRestore,
  onDelete,
}: CloudBackupSnapshotListOverlayProps) {
  const content = (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6" data-testid="cloud-backup-snapshot-full-list-scroll">
      <div className="grid gap-3">
        {/* Dialog 会把页面背景设为 inert；刷新失败入口必须与缓存行一起留在弹窗内，不能用错误替换旧数据。 */}
        {snapshotsErrorMessage ? (
          <SnapshotErrorMessage message={snapshotsErrorMessage} onOpenErrorDetails={onOpenErrorDetails} />
        ) : null}
        <SnapshotRows
          snapshots={snapshots}
          busy={disabled || busy}
          restoringSnapshotKey={restoringSnapshotKey}
          deletingSnapshotKey={deletingSnapshotKey}
          rowLabels={rowLabels}
          formatSnapshotDate={formatSnapshotDate}
          onRestore={onRestore}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
  // 弹窗内刷新复用当前 provider-scoped query，避免完整列表和设置页摘要各自维护一份远端状态。
  const refreshButton = (
    <SnapshotRefreshButton
      disabled={refreshDisabled}
      isRefreshing={isRefreshing}
      label={refreshLabel}
      onRefresh={onRefresh}
    />
  );

  if (isMobile) {
    return (
      <MobileDrawerRoot open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
        {open ? (
          <MobileBottomDrawerContent
            title={title}
            description={description}
            descriptionClassName="text-xs"
            closeLabel={closeLabel}
            actions={refreshButton}
            className="max-h-[calc(var(--app-viewport-height)-1rem)]"
            headerClassName="border-b border-border"
            bodyClassName={null}
            zIndexClassName="z-70"
          >
            {content}
          </MobileBottomDrawerContent>
        ) : null}
      </MobileDrawerRoot>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent layout="frame" className="h-[min(calc(var(--app-viewport-height)-2rem),42rem)] max-w-4xl gap-0 overflow-hidden border-border bg-card p-0" closeLabel={closeLabel}>
        <DialogHeader className="shrink-0 border-b border-border px-4 py-5 pr-12 text-left sm:px-6 sm:pr-14">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <DialogTitle className="text-base leading-6">{title}</DialogTitle>
              <DialogDescription className="text-left text-xs leading-5">{description}</DialogDescription>
            </div>
            {refreshButton}
          </div>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}

interface SnapshotRowLabels {
  restore: string;
  restoring: string;
  delete: string;
  deleting: string;
  restoreNamed: (name: string) => string;
  restoringNamed: (name: string) => string;
  deleteNamed: (name: string) => string;
  deletingNamed: (name: string) => string;
  webdavProvider: string;
  s3Provider: string;
}

function SnapshotRefreshButton({
  disabled,
  isRefreshing,
  label,
  onRefresh,
  className,
}: {
  disabled: boolean;
  isRefreshing: boolean;
  label: string;
  onRefresh: () => void | Promise<void>;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void onRefresh()}
      disabled={disabled}
      aria-busy={isRefreshing ? true : undefined}
      className={cn("relative justify-center gap-2 border-border", className)}
    >
      <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
      {label}
    </Button>
  );
}

function SnapshotErrorMessage({ message, onOpenErrorDetails }: { message: string; onOpenErrorDetails: () => void }) {
  const { t } = useI18n();

  return (
    <div role="alert" className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 text-sm text-foreground sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <span className="min-w-0 wrap-break-word">{message}</span>
      </div>
      <Button type="button" variant="outline" size="sm" className="shrink-0 justify-center gap-2 border-border text-destructive hover:text-destructive" onClick={onOpenErrorDetails}>
        {t("settings.cloudBackupUpstreamOpen")}
      </Button>
    </div>
  );
}

interface SnapshotRowProps {
  snapshot: CloudBackupSnapshot;
  busy: boolean;
  isRestoring: boolean;
  isDeleting: boolean;
  restoreLabel: string;
  restoringLabel: string;
  deleteLabel: string;
  deletingLabel: string;
  restoreAriaLabel: string;
  restoringAriaLabel: string;
  deleteAriaLabel: string;
  deletingAriaLabel: string;
  providerLabel: string;
  formattedDate: string;
  onRestore: (snapshot: CloudBackupSnapshot) => void | Promise<void>;
  onDelete: (snapshot: CloudBackupSnapshot) => void;
}

function SnapshotRow({
  snapshot,
  busy,
  isRestoring,
  isDeleting,
  restoreLabel,
  restoringLabel,
  deleteLabel,
  deletingLabel,
  restoreAriaLabel,
  restoringAriaLabel,
  deleteAriaLabel,
  deletingAriaLabel,
  providerLabel,
  formattedDate,
  onRestore,
  onDelete,
}: SnapshotRowProps) {
  return (
    <div className="grid gap-3 border-b border-border px-3 py-2.5 last:border-b-0 md:grid-cols-[minmax(0,1fr)_max-content_max-content_max-content_max-content] md:items-center">
      <div className="flex min-w-0 items-center gap-2">
        <Archive className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-xs text-foreground">{snapshot.filename}</span>
      </div>
      <div className="md:text-right">
        <Badge variant="outline" className="w-fit font-medium md:ml-auto">
          {providerLabel}
        </Badge>
      </div>
      <div className="text-xs text-muted-foreground md:text-right">{formattedDate}</div>
      <div className="whitespace-nowrap text-xs font-medium text-muted-foreground md:text-right">{formatBytes(snapshot.sizeBytes)}</div>
      <div className="grid grid-cols-2 gap-2 md:flex md:flex-nowrap md:items-center md:justify-end">
        {/* 云备份远端操作是全局单操作；只有 provider:id 命中的当前行显示 loading，其它行只禁用。 */}
        <Button type="button" variant="outline" size="sm" onClick={() => void onRestore(snapshot)} onFocus={preloadImportDataDialog} onPointerEnter={preloadImportDataDialog} onTouchStart={preloadImportDataDialog} disabled={busy} aria-label={isRestoring ? restoringAriaLabel : restoreAriaLabel} aria-busy={isRestoring ? true : undefined} className="inline-flex h-8 min-w-21 shrink-0 justify-center gap-1.5 whitespace-nowrap border-border px-2.5">
          <LoadingButtonContent loading={isRestoring} loadingLabel={restoringLabel}>
            <Download className="h-4 w-4 shrink-0" />
            {restoreLabel}
          </LoadingButtonContent>
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onDelete(snapshot)} disabled={busy} aria-label={isDeleting ? deletingAriaLabel : deleteAriaLabel} aria-busy={isDeleting ? true : undefined} className="inline-flex h-8 min-w-21 shrink-0 justify-center gap-1.5 whitespace-nowrap px-2.5 text-destructive hover:text-destructive">
          <LoadingButtonContent loading={isDeleting} loadingLabel={deletingLabel}>
            <Trash2 className="h-4 w-4 shrink-0" />
            {deleteLabel}
          </LoadingButtonContent>
        </Button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function providerLabelFor(provider: CloudBackupSnapshot["provider"], labels: Record<CloudBackupSnapshot["provider"], string>): string {
  return labels[provider];
}

function snapshotKey(snapshot: CloudBackupSnapshot): string {
  return `${snapshot.provider}:${snapshot.id}`;
}
