import { useRef, useState } from "react";
import { Image as ImageIcon, Images, Loader2, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import { FaviconResultImage } from "@/components/favicon-result-image";
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
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { UploadedAsset, UploadKind } from "@/lib/api/schemas/media";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nProvider";
import { LoadingButtonContent } from "./settings-shared-controls";
import { getSettingsSectionClassName } from "./settings-layout";
import type { UploadedAssetsManagerController } from "../application/use-uploaded-assets-manager";
import { ManagerDataBoundary } from "./manager-data-boundary";
import { SettingsManagerDialogFrame } from "./settings-manager-dialog-frame";
import { SettingsSectionHeader } from "./settings-section-header";

interface UploadedIconsSectionProps {
  id?: string;
  className?: string;
  controller: UploadedAssetsManagerController;
}

type UploadedAssetKindController = UploadedAssetsManagerController["logo"];

export function UploadedIconsSection({ id, className, controller }: UploadedIconsSectionProps) {
  const { t, formatDateTime, locale } = useI18n();
  const [managerOpen, setManagerOpen] = useState(false);
  const [activeKind, setActiveKind] = useState<UploadKind>("logo");
  const [deleteTarget, setDeleteTarget] = useState<UploadedAsset | null>(null);
  const logoTabRef = useRef<HTMLButtonElement>(null);
  const iconTabRef = useRef<HTMLButtonElement>(null);
  const isDeletingTarget = deleteTarget ? controller.deletingAssetId === deleteTarget.id : false;
  const logoAssets = controller.logo.readState.data ?? [];
  const iconAssets = controller.icon.readState.data ?? [];
  const summary = controller.logo.readState.isInitialLoading || controller.icon.readState.isInitialLoading
    ? t("common.loading")
    : (!controller.logo.readState.hasData && controller.logo.readState.error)
      || (!controller.icon.readState.hasData && controller.icon.readState.error)
      ? t("settings.uploadedIconsStatusUnknown")
      : controller.logo.readState.error || controller.icon.readState.error
        ? t("settings.uploadedIconsSummaryStale", { logoCount: logoAssets.length, iconCount: iconAssets.length })
        : t("settings.uploadedIconsSummaryCompact", { logoCount: logoAssets.length, iconCount: iconAssets.length });
  const openManager = (kind: UploadKind) => {
    // 入口默认落到用户选择的资产类型，避免 Logo 和支付方式 icon 共用管理器时误删另一类资产。
    setActiveKind(kind);
    setManagerOpen(true);
  };

  return (
    <section id={id} className={getSettingsSectionClassName(className)}>
      <SettingsSectionHeader
        icon={<Images className="mt-0.5 h-5 w-5 shrink-0 text-primary" />}
        title={t("settings.uploadedIcons")}
        help={t("settings.uploadedIconsHelp")}
        summary={summary}
        action={(
          <Button type="button" variant="outline" size="sm" className="gap-2 border-border" onClick={() => openManager("logo")}>
            <SlidersHorizontal className="h-4 w-4" />
            {t("settings.uploadedIconsManage")}
          </Button>
        )}
      />

      <Dialog open={managerOpen} onOpenChange={setManagerOpen}>
        <SettingsManagerDialogFrame
          icon={<Images className="h-5 w-5 text-primary" />}
          title={t("settings.uploadedIconsManageTitle")}
          description={t("settings.uploadedIconsManageDescription")}
          bodyClassName="flex overflow-hidden px-0 py-0 sm:px-0"
          footer={(
            <Button type="button" onClick={() => setManagerOpen(false)} className="w-full sm:w-auto">
              {t("settings.uploadedIconsManageDone")}
            </Button>
          )}
        >
          <Tabs value={activeKind} onValueChange={(value) => setActiveKind(value as UploadKind)} className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-border px-4 py-3 sm:px-6">
              <TabsList className="grid w-full grid-cols-2 sm:w-auto">
                <TabsTrigger ref={logoTabRef} value="logo">{t("settings.uploadedIconsLogoTitle")}</TabsTrigger>
                <TabsTrigger ref={iconTabRef} value="icon">{t("settings.uploadedIconsIconTitle")}</TabsTrigger>
              </TabsList>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
              <TabsContent value="logo" className="mt-0">
                <UploadedAssetKindManagerPanel
                  kind="logo"
                  description={t("settings.uploadedIconsLogoDescription")}
                  emptyLabel={t("settings.uploadedIconsLogoEmpty")}
                  controller={controller.logo}
                  deleteError={controller.deleteError}
                  deletingAssetId={controller.deletingAssetId}
                  locale={locale}
                  formatDateTime={formatDateTime}
                  onDelete={setDeleteTarget}
                />
              </TabsContent>
              <TabsContent value="icon" className="mt-0">
                <UploadedAssetKindManagerPanel
                  kind="icon"
                  description={t("settings.uploadedIconsIconDescription")}
                  emptyLabel={t("settings.uploadedIconsIconEmpty")}
                  controller={controller.icon}
                  deleteError={controller.deleteError}
                  deletingAssetId={controller.deletingAssetId}
                  locale={locale}
                  formatDateTime={formatDateTime}
                  onDelete={setDeleteTarget}
                />
              </TabsContent>
            </div>
          </Tabs>
        </SettingsManagerDialogFrame>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => {
        // 删除请求进行中不允许关闭后清空 target，否则 pending 状态会丢失对应资产。
        if (!open && !isDeletingTarget) setDeleteTarget(null);
      }}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // 删除成功会卸载资产行，焦点回到当前范围 Tab，避免落到已移除的删除按钮。
            (activeKind === "logo" ? logoTabRef.current : iconTabRef.current)?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.uploadedIconsDeleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? t("settings.uploadedIconsDeleteDescription", { name: assetName(deleteTarget, t("settings.uploadedIconsUnnamedAsset")) })
                : t("settings.uploadedIconsDeleteFallback")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteTarget ? (
            <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{assetName(deleteTarget, t("settings.uploadedIconsUnnamedAsset"))}</p>
              <p className="mt-1">{assetMetaLine(deleteTarget, locale, formatDateTime, t)}</p>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingTarget}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeletingTarget}
              aria-busy={isDeletingTarget ? true : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (!deleteTarget) return;
                void controller.deleteAsset(deleteTarget).then((deleted) => {
                  if (deleted) setDeleteTarget(null);
                });
              }}
              className="min-w-21 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <LoadingButtonContent loading={isDeletingTarget} loadingLabel={t("settings.uploadedIconsDeleting")}>
                {t("common.delete")}
              </LoadingButtonContent>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

interface UploadedAssetKindPanelProps {
  kind: UploadKind;
  description: string;
  emptyLabel: string;
  controller: UploadedAssetKindController;
  deleteError: UploadedAssetsManagerController["deleteError"];
  deletingAssetId: string | null;
  locale: string;
  formatDateTime: ReturnType<typeof useI18n>["formatDateTime"];
}

interface UploadedAssetKindManagerPanelProps extends UploadedAssetKindPanelProps {
  onDelete: (asset: UploadedAsset) => void;
}

function UploadedAssetKindManagerPanel({
  kind,
  description,
  emptyLabel,
  controller,
  deleteError,
  deletingAssetId,
  locale,
  formatDateTime,
  onDelete,
}: UploadedAssetKindManagerPanelProps) {
  const { t } = useI18n();
  const assets = controller.readState.data ?? [];

  return (
    <div className="grid gap-3">
      <div className="flex flex-col gap-3 min-[520px]:flex-row min-[520px]:items-start min-[520px]:justify-between">
        <p className="min-w-0 text-xs leading-5 text-muted-foreground">{description}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-full justify-center gap-2 border-border px-2 text-xs min-[520px]:w-auto"
          onClick={() => void controller.readState.retry()}
          disabled={controller.readState.isInitialLoading || controller.readState.isRefreshing}
        >
          {controller.readState.isInitialLoading || controller.readState.isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t("settings.uploadedIconsRefreshKind")}
        </Button>
      </div>

      <ManagerDataBoundary state={controller.readState}>
      {assets.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-background px-3 py-6 text-center">
          <ImageIcon className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        </div>
      ) : (
        <div className="grid gap-2">
          {assets.map((asset) => (
            <UploadedAssetRow
              key={asset.id}
              asset={asset}
              kind={kind}
              deleting={deletingAssetId === asset.id}
              deleteError={deleteError?.assetId === asset.id ? deleteError.message : null}
              locale={locale}
              formatDateTime={formatDateTime}
              onDelete={() => onDelete(asset)}
            />
          ))}
        </div>
      )}
      </ManagerDataBoundary>

      {controller.hasMore ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-1 w-full gap-2 border-border"
          onClick={() => void controller.loadMore()}
          disabled={controller.isLoadingMore}
        >
          {controller.isLoadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("settings.uploadedIconsLoadMore")}
        </Button>
      ) : null}
    </div>
  );
}

interface UploadedAssetRowProps {
  asset: UploadedAsset;
  kind: UploadKind;
  deleting: boolean;
  deleteError: string | null;
  locale: string;
  formatDateTime: ReturnType<typeof useI18n>["formatDateTime"];
  onDelete?: () => void;
}

function UploadedAssetRow({
  asset,
  kind,
  deleting,
  deleteError,
  locale,
  formatDateTime,
  onDelete,
}: UploadedAssetRowProps) {
  const { t } = useI18n();
  const name = assetName(asset, t("settings.uploadedIconsUnnamedAsset"));

  return (
    <div className={cn(
      "grid gap-2 rounded-md border border-border bg-background p-3 min-[560px]:items-center",
      onDelete ? "min-[560px]:grid-cols-[3.5rem_minmax(0,1fr)_auto]" : "min-[560px]:grid-cols-[3.5rem_minmax(0,1fr)]",
    )}>
      <div className="media-thumbnail-canvas flex h-14 w-14 items-center justify-center rounded-lg border border-border p-1.5">
        {/* 资产 URL 仍走私有代理路径，缩略图失败时由 FaviconResultImage 负责降级占位。 */}
        <FaviconResultImage src={asset.url} alt={name} className="media-thumbnail-image" />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 truncate text-sm font-medium text-foreground">{name}</p>
          <span className="rounded-md border border-border bg-secondary px-1.5 py-0.5 text-[11px] font-medium uppercase text-muted-foreground">
            {kind === "logo" ? t("settings.uploadedIconsKindLogo") : t("settings.uploadedIconsKindIcon")}
          </span>
        </div>
        <p className="mt-1 wrap-break-word text-xs leading-5 text-muted-foreground">
          {assetMetaLine(asset, locale, formatDateTime, t)}
        </p>
        {deleteError ? <p className="mt-1 text-xs leading-5 text-destructive">{deleteError}</p> : null}
      </div>
      {onDelete ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-full gap-2 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive min-[560px]:w-auto"
          onClick={onDelete}
          disabled={deleting}
          aria-label={t("settings.uploadedIconsDeleteAsset", { name })}
        >
          {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          {t("common.delete")}
        </Button>
      ) : null}
    </div>
  );
}

function assetName(asset: UploadedAsset, fallback: string): string {
  return asset.originalName?.trim() || fallback;
}

function assetMetaLine(
  asset: UploadedAsset,
  locale: string,
  formatDateTime: ReturnType<typeof useI18n>["formatDateTime"],
  t: ReturnType<typeof useI18n>["t"],
): string {
  const mimeType = asset.mimeType || t("settings.uploadedIconsUnknownMime");
  const size = formatAssetSize(asset.sizeBytes, locale, t);
  const updated = asset.updated
    ? formatDateTime(asset.updated, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : t("settings.uploadedIconsUnknownTime");
  return t("settings.uploadedIconsMeta", { mimeType, size, updated });
}

function formatAssetSize(sizeBytes: number | undefined, locale: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (typeof sizeBytes !== "number") return t("settings.uploadedIconsUnknownSize");
  if (sizeBytes < 1024) return t("settings.uploadedIconsSizeBytes", { size: sizeBytes });
  if (sizeBytes < 1024 * 1024) {
    return t("settings.uploadedIconsSizeKb", { size: formatNumber(sizeBytes / 1024, locale) });
  }
  return t("settings.uploadedIconsSizeMb", { size: formatNumber(sizeBytes / 1024 / 1024, locale) });
}

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}
