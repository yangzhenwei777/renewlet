import { type ReactNode, useMemo, useState } from 'react';
import { AlertCircle, AppWindow, Check, Clock3, Image as ImageIcon, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RawErrorResponseDialog } from '@/components/raw-error-response-dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { TruncatedTooltipText } from '@/components/ui/truncated-tooltip-text';
import { BUILT_IN_ICON_PROVIDERS, type BuiltInIconProvider } from '@renewlet/shared/built-in-icons';
import { APP_STORE_STOREFRONTS, type AppStoreStorefront } from '@renewlet/shared/online-icon-sources';
import type { AppSettings } from '@/types/subscription';
import type { BuiltInIconIndexProviderStatus, BuiltInIconProviderVersion, BuiltInIconRefreshJob } from '@/lib/api/schemas/media';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n/I18nProvider';
import type { MessageKey, MessageParams } from '@/i18n/messages';
import { getSettingsSectionClassName } from './settings-layout';
import { CheckboxSettingRow } from './settings-shared-controls';
import type { SettingsBuiltInIconIndexController } from '../application/use-built-in-icon-index-controller';
import { ManagerDataBoundary } from './manager-data-boundary';
import { SettingsManagerDialogFrame } from './settings-manager-dialog-frame';
import { SettingsSectionHeader } from './settings-section-header';

type BuiltInIconIndexController = SettingsBuiltInIconIndexController;

interface BuiltInIconSourcesSectionProps {
  id?: string;
  className?: string;
  /** 内置图标 provider 开关，必须覆盖 shared 中声明的所有 provider。 */
  sources: AppSettings["builtInIconSources"];
  /** 受控更新；SettingsScreen 负责统一保存草稿，组件内不直接打 API。 */
  onChange: (sources: AppSettings["builtInIconSources"]) => void;
  /** 在线图标来源开关；只影响手动 Logo 搜索，不参与内置 provider 索引状态。 */
  onlineSources: AppSettings["onlineIconSources"];
  onOnlineChange: (sources: AppSettings["onlineIconSources"]) => void;
  /** 管理员索引版本检查/刷新；独立于用户 settings 保存草稿。 */
  iconIndex?: BuiltInIconIndexController;
}

// 显式 key map 让 Lingui catalog key 保持可静态追踪；不要用动态字符串拼 App Store 地区文案。
const APP_STORE_STOREFRONT_LABEL_KEYS = {
  us: "settings.onlineIconSource.appStore.storefront.us",
  cn: "settings.onlineIconSource.appStore.storefront.cn",
} satisfies Record<AppStoreStorefront, MessageKey>;

const APP_STORE_STOREFRONT_HELP_KEYS = {
  us: "settings.onlineIconSource.appStore.storefront.us.help",
  cn: "settings.onlineIconSource.appStore.storefront.cn.help",
} satisfies Record<AppStoreStorefront, MessageKey>;

/**
 * 管理内置 Logo/Icon 候选来源。
 *
 * 业务约束：至少保留一个 provider 启用，否则媒体候选会退化成纯 favicon/domain 兜底，
 * 导入自动匹配和手动搜索的结果质量都会明显下降。
 */
export function BuiltInIconSourcesSection({ id, className, sources, onChange, onlineSources, onOnlineChange, iconIndex }: BuiltInIconSourcesSectionProps) {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);
  const enabledCount = BUILT_IN_ICON_PROVIDERS.filter((provider) => sources[provider].enabled).length;
  const providerStatusById = useMemo(
    () => new Map(iconIndex?.status.data?.providers.map((item) => [item.provider, item])),
    [iconIndex?.status.data?.providers],
  );
  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (open && iconIndex?.canManage) {
      // 打开总弹层自动检查全部 provider；这是管理员状态面，不写 settings 草稿也不触发未保存提示。
      void iconIndex.checkAllProviders();
    }
  };

  const updateProvider = (
    provider: BuiltInIconProvider,
    patch: Partial<AppSettings["builtInIconSources"][BuiltInIconProvider]>,
  ) => {
    const next = {
      ...sources,
      [provider]: {
        ...sources[provider],
        ...patch,
      },
    };
    // 至少保留一个来源启用；这是前端 UX 保护，后端/Worker 仍按 settings contract 自行过滤候选。
    if (BUILT_IN_ICON_PROVIDERS.every((item) => !next[item].enabled)) return;
    onChange(next);
  };
  const updateOnlineAppStore = (enabled: boolean) => {
    onOnlineChange({
      ...onlineSources,
      appStore: {
        ...onlineSources.appStore,
        enabled,
      },
    });
  };
  const updateOnlineAppStoreStorefront = (storefront: AppStoreStorefront, enabled: boolean) => {
    const selected = new Set(onlineSources.appStore.storefronts);
    if (enabled) {
      selected.add(storefront);
    } else if (selected.size > 1) {
      selected.delete(storefront);
    } else {
      // storefronts 是 App Store 请求放大开关；关闭来源只能走总开关，不能把地区列表保存为空。
      return;
    }
    const storefronts = APP_STORE_STOREFRONTS.filter((item) => selected.has(item));
    onOnlineChange({
      ...onlineSources,
      appStore: {
        ...onlineSources.appStore,
        storefronts,
      },
    });
  };

  return (
    <section id={id} className={getSettingsSectionClassName(className)}>
      <SettingsSectionHeader
        icon={<ImageIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />}
        title={t("settings.builtInIconSources")}
        help={t("settings.builtInIconSourcesHelp")}
        summary={t("settings.iconSourcesSummary", {
          enabled: enabledCount,
          total: BUILT_IN_ICON_PROVIDERS.length,
          online: onlineSources.appStore.enabled
            ? t("settings.onlineIconSourceEnabled")
            : t("settings.onlineIconSourceDisabled"),
        })}
        action={(
        <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" className="w-full shrink-0 gap-2 sm:w-auto">
              <SlidersHorizontal className="h-4 w-4" />
              {t("settings.builtInIconSourcesConfigure")}
            </Button>
          </DialogTrigger>
          <SettingsManagerDialogFrame
            icon={<ImageIcon className="h-5 w-5 text-primary" />}
            title={t("settings.builtInIconSourcesDialogTitle")}
            description={t("settings.builtInIconSourcesDialogDescription")}
            footer={(
              <>
                <p className="text-left text-xs leading-5 text-muted-foreground sm:mr-auto">
                  {t("settings.builtInIconSourcesPendingHint")}
                </p>
                <Button type="button" onClick={() => setDialogOpen(false)} className="w-full sm:w-auto">
                  {t("settings.builtInIconSourcesDialogDone")}
                </Button>
              </>
            )}
          >
              <div className="grid gap-6">
                <div className="grid gap-3">
                  <div className="grid gap-1">
                    <h3 className="text-sm font-semibold text-foreground">{t("settings.builtInIconSourcesBuiltInTitle")}</h3>
                    <p className="text-xs leading-5 text-muted-foreground">{t("settings.builtInIconSourcesBuiltInHelp")}</p>
                  </div>
                  {BUILT_IN_ICON_PROVIDERS.map((provider) => (
                    <BuiltInIconSourceCard
                      key={provider}
                      provider={provider}
                      source={sources[provider]}
                      disableSourceToggle={sources[provider].enabled && enabledCount <= 1}
                      providerStatus={providerStatusById.get(provider)}
                      iconIndex={iconIndex?.canManage ? iconIndex : undefined}
                      onUpdate={updateProvider}
                      t={t}
                    />
                  ))}
                  <p className="text-xs text-muted-foreground">{t("settings.builtInIconSourcesRequired")}</p>
                </div>

                <div className="grid gap-3 border-t border-border pt-4">
                  <div className="grid gap-1">
                    <h3 className="text-sm font-semibold text-foreground">{t("settings.onlineIconSourcesTitle")}</h3>
                    <p className="text-xs leading-5 text-muted-foreground">{t("settings.onlineIconSourcesHelp")}</p>
                  </div>
                  <OnlineAppStoreSourceCard
                    enabled={onlineSources.appStore.enabled}
                    storefronts={onlineSources.appStore.storefronts}
                    onEnabledChange={updateOnlineAppStore}
                    onStorefrontChange={updateOnlineAppStoreStorefront}
                    t={t}
                  />
                </div>
              </div>
          </SettingsManagerDialogFrame>
        </Dialog>
        )}
      />

      {iconIndex?.canManage ? (
        <RawErrorResponseDialog
          open={iconIndex.errorDetailsOpen}
          details={iconIndex.errorDetails}
          onOpenChange={iconIndex.setErrorDetailsOpen}
          testId="built-in-icon-raw-error-response-dialog"
        />
      ) : null}
    </section>
  );
}

interface BuiltInIconSourceCardProps {
  /** shared 契约中的 provider id，用于读取文案、settings 字段和候选来源。 */
  provider: BuiltInIconProvider;
  source: AppSettings["builtInIconSources"][BuiltInIconProvider];
  /** 当前 provider 是最后一个启用来源时禁用开关，避免把候选体系关空。 */
  disableSourceToggle: boolean;
  providerStatus: BuiltInIconIndexProviderStatus | undefined;
  iconIndex: BuiltInIconIndexController | undefined;
  onUpdate: (
    provider: BuiltInIconProvider,
    patch: Partial<AppSettings["builtInIconSources"][BuiltInIconProvider]>,
  ) => void;
  t: (key: MessageKey, params?: MessageParams) => string;
}

function BuiltInIconSourceCard({
  provider,
  source,
  disableSourceToggle,
  providerStatus,
  iconIndex,
  onUpdate,
  t,
}: BuiltInIconSourceCardProps) {
  return (
    <div className="rounded-lg border border-border bg-secondary/40 p-4" aria-live="polite">
      <div className="flex flex-col gap-3 min-[520px]:flex-row min-[520px]:items-start min-[520px]:justify-between">
        <div className="min-w-0">
          <Label htmlFor={`built-in-icon-source-${provider}`} className="text-sm font-medium">
            {t(`settings.builtInIconSource.${provider}`)}
          </Label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t(`settings.builtInIconSource.${provider}.help`)}
          </p>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 min-[520px]:justify-end">
          {iconIndex ? (
            <BuiltInIconProviderStatusPopover
              provider={provider}
              status={providerStatus}
              iconIndex={iconIndex}
              t={t}
            />
          ) : null}
          <Switch
            id={`built-in-icon-source-${provider}`}
            checked={source.enabled}
            disabled={disableSourceToggle}
            onCheckedChange={(checked) => onUpdate(provider, { enabled: checked })}
            aria-label={t("settings.builtInIconSourceToggle", { source: t(`settings.builtInIconSource.${provider}`) })}
          />
        </div>
      </div>

      <div className={cn("mt-3 flex items-center justify-between gap-3 border-t border-border/70 pt-3", !source.enabled && "opacity-50")}>
        <div className="min-w-0">
          <Label htmlFor={`built-in-icon-source-variants-${provider}`} className="text-xs font-medium">
            {t("settings.builtInIconSourceVariants")}
          </Label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t(`settings.builtInIconSource.${provider}.variantsHelp`)}
          </p>
        </div>
        <Switch
          id={`built-in-icon-source-variants-${provider}`}
          checked={source.variantsEnabled}
          disabled={!source.enabled}
          onCheckedChange={(checked) => onUpdate(provider, { variantsEnabled: checked })}
          aria-label={t("settings.builtInIconSourceVariantsToggle", { source: t(`settings.builtInIconSource.${provider}`) })}
        />
      </div>
    </div>
  );
}

function IconSourceCardHeading({
  description,
  icon,
  labelFor,
  testId,
  title,
}: {
  description: ReactNode;
  icon: ReactNode;
  labelFor: string;
  testId: string;
  title: ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 gap-y-1" data-testid={testId}>
      <span
        aria-hidden="true"
        className="flex h-5 w-5 items-center justify-center text-primary"
        data-testid={`${testId}-icon-frame`}
      >
        {icon}
      </span>
      <Label htmlFor={labelFor} className="min-w-0 cursor-pointer text-sm font-medium leading-5 text-foreground">
        {title}
      </Label>
      <p className="col-start-2 text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

function OnlineAppStoreSourceCard({
  enabled,
  storefronts,
  onEnabledChange,
  onStorefrontChange,
  t,
}: {
  enabled: boolean;
  storefronts: AppSettings["onlineIconSources"]["appStore"]["storefronts"];
  onEnabledChange: (enabled: boolean) => void;
  onStorefrontChange: (storefront: AppStoreStorefront, enabled: boolean) => void;
  t: (key: MessageKey, params?: MessageParams) => string;
}) {
  return (
    <div className="rounded-lg border border-border bg-secondary/40 p-4">
      <div className="flex flex-col gap-3 min-[520px]:flex-row min-[520px]:items-start min-[520px]:justify-between">
        <IconSourceCardHeading
          labelFor="online-icon-source-app-store"
          icon={<AppWindow className="h-4 w-4" />}
          testId="online-icon-source-app-store-heading"
          title={t("settings.onlineIconSource.appStore")}
          description={t("settings.onlineIconSource.appStore.help")}
        />
        <Switch
          id="online-icon-source-app-store"
          checked={enabled}
          onCheckedChange={onEnabledChange}
          aria-label={t("settings.onlineIconSourceToggle", { source: t("settings.onlineIconSource.appStore") })}
        />
      </div>
      {/* 总开关只控制是否请求 Apple；地区 checkbox 保留用户选择，不能用空列表表达关闭。 */}
      <fieldset
        className={cn("mt-4 border-t border-border/70 pt-3", !enabled && "opacity-50")}
        aria-describedby="online-icon-source-app-store-storefronts-help online-icon-source-app-store-storefronts-required"
      >
        <legend className="text-xs font-medium text-foreground">
          {t("settings.onlineIconSource.appStore.storefronts")}
        </legend>
        <p id="online-icon-source-app-store-storefronts-help" className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("settings.onlineIconSource.appStore.storefronts.help")}
        </p>
        <div className="mt-3 grid gap-3" data-testid="app-store-storefront-list">
          {APP_STORE_STOREFRONTS.map((storefront) => {
            const checked = storefronts.includes(storefront);
            const disabled = !enabled || (checked && storefronts.length <= 1);
            return (
              <CheckboxSettingRow
                key={storefront}
                id={`online-icon-source-app-store-storefront-${storefront}`}
                checked={checked}
                disabled={disabled}
                onCheckedChange={(nextChecked) => onStorefrontChange(storefront, nextChecked)}
                label={t(APP_STORE_STOREFRONT_LABEL_KEYS[storefront])}
                description={t(APP_STORE_STOREFRONT_HELP_KEYS[storefront])}
              />
            );
          })}
        </div>
        <p id="online-icon-source-app-store-storefronts-required" className="mt-3 text-xs leading-5 text-muted-foreground">
          {t("settings.onlineIconSource.appStore.storefronts.required")}
        </p>
      </fieldset>
    </div>
  );
}

interface BuiltInIconProviderStatusPopoverProps {
  provider: BuiltInIconProvider;
  status: BuiltInIconIndexProviderStatus | undefined;
  iconIndex: BuiltInIconIndexController;
  t: (key: MessageKey, params?: MessageParams) => string;
}

type BuiltInIconProviderStatusKind = "checking" | "current" | "error" | "loading" | "refreshing" | "unchecked" | "update";

interface BuiltInIconProviderStatusView {
  kind: BuiltInIconProviderStatusKind;
  label: string;
  className: string;
}

function BuiltInIconProviderStatusPopover({ provider, status, iconIndex, t }: BuiltInIconProviderStatusPopoverProps) {
  const { formatDateTime, formatNumber } = useI18n();
  const [open, setOpen] = useState(false);
  const checking = iconIndex.checkingProviders.includes(provider);
  const jobStatus = status?.job?.status;
  const jobRefreshing = jobStatus === "queued" || jobStatus === "running";
  const refreshing = iconIndex.refreshingProvider === provider || jobRefreshing || Boolean(status?.refreshing);
  const busy = iconIndex.status.isInitialLoading || iconIndex.status.isRefreshing || checking || refreshing;
  const providerName = t(`settings.builtInIconSource.${provider}`);
  const statusView = getBuiltInIconProviderStatusView({ checking, iconIndex, refreshing, status, t });
  // 详情只展示仍在进行的后台任务；历史 succeeded/failed job 不参与主状态，避免旧失败盖住“有更新/已最新”。
  const visibleJob = status?.job && (status.job.status === "queued" || status.job.status === "running") ? status.job : null;
  const checkFailureMessage = statusView.kind === "error" ? status?.lastError ?? null : null;
  const canRefresh = Boolean(status && (status.updateAvailable || checkFailureMessage) && !busy);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 max-w-30 items-center gap-1.5 overflow-hidden rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            statusView.className,
          )}
          aria-label={t("settings.builtInIconIndexOpenStatus", {
            source: providerName,
            status: statusView.label,
          })}
        >
          <BuiltInIconProviderStatusIcon kind={statusView.kind} />
          <span className="truncate">{statusView.label}</span>
          {statusView.kind === "update" ? (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
          ) : (
            null
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        mobileTitle={providerName}
        mobileCloseLabel={t("common.close")}
        mobilePresentation="anchored"
        className="flex max-h-[min(calc(var(--app-viewport-height)-1rem),var(--radix-popover-content-available-height,32rem))] w-[min(calc(100vw-2rem),20rem)] flex-col rounded-xl border-border bg-card p-0 shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{providerName}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{statusView.label}</p>
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => {
              void iconIndex.checkProvider(provider);
            }}
            disabled={busy}
            aria-label={t("settings.builtInIconIndexCheckProvider", { source: providerName })}
            title={t("settings.builtInIconIndexCheck")}
          >
            <RefreshCw className={cn("h-4 w-4", checking && "animate-spin")} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <ManagerDataBoundary state={iconIndex.status}>
            {status ? (
              <BuiltInIconProviderInfoList
                items={[
                  {
                    label: t("settings.builtInIconIndexIconCountLabel"),
                    value: t("settings.builtInIconIndexProviderIconCount", { count: formatNumber(status.iconCount) }),
                  },
                  {
                    label: t("settings.builtInIconIndexCurrentVersionLabel"),
                    value: formatProviderVersion(status.current, t, formatDateTime),
                  },
                  {
                    label: t("settings.builtInIconIndexLatestVersionLabel"),
                    value: status.latest ? formatProviderVersion(status.latest, t, formatDateTime) : t("settings.builtInIconIndexVersionUnchecked"),
                  },
                  {
                    label: t("settings.builtInIconIndexCheckedAt"),
                    value: formatProviderTimestamp(status.checkedAt, t("settings.builtInIconIndexTimestampUnchecked"), formatDateTime),
                  },
                  {
                    label: t("settings.builtInIconIndexRefreshedAt"),
                    value: formatProviderTimestamp(status.refreshedAt, t("settings.builtInIconIndexTimestampUnrefreshed"), formatDateTime),
                  },
                  ...(visibleJob ? [{
                    label: t("settings.builtInIconIndexJobStatusLabel"),
                    value: formatRefreshJob(visibleJob, t, formatDateTime),
                  }] : []),
                ]}
              />
            ) : (
              <p className="rounded-md border border-border bg-background/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
                {t("settings.builtInIconIndexUnavailable")}
              </p>
            )}
          </ManagerDataBoundary>

          {checkFailureMessage ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive" role="alert">
              {t("settings.builtInIconIndexLastCheckError", { message: checkFailureMessage })}
            </div>
          ) : null}

          <Button
            type="button"
            className="w-full gap-2"
            variant={checkFailureMessage ? "outline" : "default"}
            disabled={!canRefresh}
            onClick={() => {
              void iconIndex.refreshProvider(provider);
            }}
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            {refreshing ? t("settings.builtInIconIndexRefreshing") : t("settings.builtInIconIndexRefresh")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function getBuiltInIconProviderStatusView({
  checking,
  iconIndex,
  refreshing,
  status,
  t,
}: {
  checking: boolean;
  iconIndex: BuiltInIconIndexController;
  refreshing: boolean;
  status: BuiltInIconIndexProviderStatus | undefined;
  t: (key: MessageKey, params?: MessageParams) => string;
}): BuiltInIconProviderStatusView {
  if (checking) {
    return {
      kind: "checking",
      label: t("settings.builtInIconIndexBadge.checking"),
      className: "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15",
    };
  }
  if (refreshing) {
    return {
      kind: "refreshing",
      label: t("settings.builtInIconIndexBadge.refreshing"),
      className: "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15",
    };
  }
  if (iconIndex.status.isInitialLoading) {
    return {
      kind: "loading",
      label: t("settings.builtInIconIndexBadge.loading"),
      className: "border-border bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground",
    };
  }
  if (iconIndex.status.error && !iconIndex.status.hasData) {
    return {
      kind: "error",
      label: t("settings.builtInIconIndexBadge.failed"),
      className: "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15",
    };
  }
  // 主 badge 只表达当前可操作状态；已有 latest/current 时，非阻塞 lastError 只能进详情，不覆盖更新判断。
  if (status?.updateAvailable) {
    return {
      kind: "update",
      label: t("settings.builtInIconIndexBadge.updateAvailable"),
      className: "border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-200 dark:border-amber-800/50 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50",
    };
  }
  if (!status || !status.latest) {
    if (status?.lastError) {
      return {
        kind: "error",
        label: t("settings.builtInIconIndexBadge.failed"),
        className: "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15",
      };
    }
    return {
      kind: "unchecked",
      label: t("settings.builtInIconIndexBadge.unchecked"),
      className: "border-border bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground",
    };
  }
  return {
    kind: "current",
    label: t("settings.builtInIconIndexBadge.upToDate"),
    className: "border-border bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground",
  };
}

function BuiltInIconProviderStatusIcon({ kind }: { kind: BuiltInIconProviderStatusKind }) {
  if (kind === "checking" || kind === "loading" || kind === "refreshing") {
    return <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />;
  }
  if (kind === "current") {
    return <Check className="h-3.5 w-3.5 shrink-0" />;
  }
  if (kind === "unchecked") {
    return <Clock3 className="h-3.5 w-3.5 shrink-0" />;
  }
  return <AlertCircle className="h-3.5 w-3.5 shrink-0" />;
}

function BuiltInIconProviderInfoList({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <dl className="divide-y divide-border rounded-md border border-border bg-background/40 text-xs">
      {items.map((item) => (
        <div key={item.label} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2">
          <dt className="truncate text-muted-foreground">{item.label}</dt>
          <dd className="max-w-40 text-right font-medium text-foreground">
            <TruncatedTooltipText text={item.value} className="max-w-full text-right" />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function formatProviderVersion(
  version: BuiltInIconProviderVersion | null,
  t: (key: MessageKey, params?: MessageParams) => string,
  formatDateTime: (value: string | Date, options?: Intl.DateTimeFormatOptions) => string,
): string {
  if (!version) return t("settings.builtInIconIndexVersionUnknown");
  const versionText = version.commitShortSha ?? version.releaseTag ?? (version.commitSha ? version.displayVersion : "");
  if (version.commitDate) {
    return t("settings.builtInIconIndexVersionWithTime", {
      time: formatDateTime(version.commitDate, { dateStyle: "medium", timeStyle: "short" }),
      version: versionText,
    });
  }
  return versionText || t("settings.builtInIconIndexVersionUnknown");
}

function formatProviderTimestamp(
  value: string | null,
  fallback: string,
  formatDateTime: (value: string | Date, options?: Intl.DateTimeFormatOptions) => string,
): string {
  return value ? formatDateTime(value, { dateStyle: "medium", timeStyle: "short" }) : fallback;
}

function formatRefreshJob(
  job: BuiltInIconRefreshJob,
  t: (key: MessageKey, params?: MessageParams) => string,
  formatDateTime: (value: string | Date, options?: Intl.DateTimeFormatOptions) => string,
): string {
  const status = refreshJobStatusLabel(job, t);
  const time = job.finishedAt ?? job.startedAt ?? job.queuedAt;
  return t("settings.builtInIconIndexJobStatusValue", {
    status,
    attempts: job.attempts,
    time: formatDateTime(time, { dateStyle: "medium", timeStyle: "short" }),
  });
}

function refreshJobStatusLabel(job: BuiltInIconRefreshJob, t: (key: MessageKey, params?: MessageParams) => string): string {
  switch (job.status) {
    case "queued":
      return t("settings.builtInIconIndexJobStatus.queued");
    case "running":
      return t("settings.builtInIconIndexJobStatus.running");
    case "succeeded":
      return t("settings.builtInIconIndexJobStatus.succeeded");
    case "failed":
      return t("settings.builtInIconIndexJobStatus.failed");
  }
}
