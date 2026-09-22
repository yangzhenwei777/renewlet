import { useRef, useState, type RefObject } from "react";
import { CalendarDays, CalendarPlus, Clipboard, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCustomConfigState } from "@/contexts/CustomConfigContext";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";
import type { SubscriptionCalendarFeedListItem } from "@/lib/api/schemas/calendar-feed";
import { calendarFeedTargetKey, type CalendarFeedTarget } from "@/services/calendar-feed-service";
import type { SettingsCalendarFeedController } from "../application/use-calendar-feed-settings-controller";
import { getSettingsSectionClassName } from "./settings-layout";
import { ManagerDataBoundary } from "./manager-data-boundary";
import { SettingsManagerDialogFrame } from "./settings-manager-dialog-frame";
import { SettingsSectionHeader } from "./settings-section-header";
import { LoadingButtonContent } from "./settings-shared-controls";

interface CalendarFeedSectionProps {
  id?: string;
  className?: string;
  controller: SettingsCalendarFeedController;
}

type CalendarFeedManagerTab = "global" | "subscriptions";
type CalendarFeedGlobalVisualStatus = "loading" | "unknown" | "enabled" | "disabled" | "enabled-stale" | "disabled-stale";

const CALENDAR_FEED_GLOBAL_VISUALS = {
  loading: {
    enabled: false,
    summaryKey: "settings.calendarFeedGlobalLoadingBadge",
    panelKey: null,
  },
  unknown: {
    enabled: false,
    summaryKey: "settings.calendarFeedGlobalUnknownBadge",
    panelKey: "settings.calendarFeedStatusUnknown",
  },
  enabled: {
    enabled: true,
    summaryKey: "settings.calendarFeedGlobalEnabledBadge",
    panelKey: "settings.calendarFeedStatusEnabled",
  },
  disabled: {
    enabled: false,
    summaryKey: "settings.calendarFeedGlobalDisabledBadge",
    panelKey: "settings.calendarFeedStatusDisabled",
  },
  "enabled-stale": {
    enabled: true,
    summaryKey: "settings.calendarFeedGlobalEnabledStaleBadge",
    panelKey: "settings.calendarFeedStatusEnabledStale",
  },
  "disabled-stale": {
    enabled: false,
    summaryKey: "settings.calendarFeedGlobalDisabledStaleBadge",
    panelKey: "settings.calendarFeedStatusDisabledStale",
  },
} satisfies Record<CalendarFeedGlobalVisualStatus, {
  enabled: boolean;
  summaryKey: MessageKey;
  panelKey: MessageKey | null;
}>;

interface CalendarFeedConfirmation {
  kind: "rotate" | "revoke";
  target: CalendarFeedTarget;
  title: string;
  trigger: HTMLButtonElement;
}

const GLOBAL_CALENDAR_FEED_TARGET: CalendarFeedTarget = { scope: "all" };

export function CalendarFeedSection({ id, className, controller }: CalendarFeedSectionProps) {
  const { t } = useI18n();
  const [managerOpen, setManagerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CalendarFeedManagerTab>("global");
  const [confirmation, setConfirmation] = useState<CalendarFeedConfirmation | null>(null);
  const globalGenerateButtonRef = useRef<HTMLButtonElement>(null);
  const subscriptionsTabRef = useRef<HTMLButtonElement>(null);
  const confirmationFocusTargetRef = useRef<(() => HTMLButtonElement | null) | null>(null);
  const confirmationPending = confirmation
    ? controller.pendingTargetKey === calendarFeedTargetKey(confirmation.target)
      && controller.pendingKind === confirmation.kind
    : false;

  const dismissConfirmation = (completed: boolean) => {
    const closedConfirmation = confirmation;
    if (!closedConfirmation) return;
    // 撤销会替换全局操作区或卸载单订阅行，不能依赖 Radix 把焦点还给已经消失的触发按钮。
    confirmationFocusTargetRef.current = () => {
      const revokedTarget = completed && closedConfirmation.kind === "revoke"
        ? closedConfirmation.target
        : null;
      const preferredTarget = revokedTarget?.scope === "all"
        ? globalGenerateButtonRef.current
        : revokedTarget?.scope === "subscription"
          ? subscriptionsTabRef.current
          : closedConfirmation.trigger;
      const fallbackTarget = closedConfirmation.trigger.isConnected
        ? closedConfirmation.trigger
        : subscriptionsTabRef.current;
      return preferredTarget ?? fallbackTarget;
    };
    setConfirmation(null);
  };

  return (
    <section id={id} className={getSettingsSectionClassName(className)}>
      <SettingsSectionHeader
        icon={<CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-primary" />}
        title={t("settings.calendarFeed")}
        help={t("settings.calendarFeedHelp")}
        summary={<CalendarFeedSubscriptionSummary controller={controller} />}
        status={<CalendarFeedGlobalBadge controller={controller} />}
        action={(
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full gap-2 border-border sm:w-auto"
            onClick={() => setManagerOpen(true)}
          >
            <SlidersHorizontal className="h-4 w-4" />
            {t("settings.calendarFeedManage")}
          </Button>
        )}
      />

      <Dialog open={managerOpen} onOpenChange={setManagerOpen}>
        <SettingsManagerDialogFrame
          icon={<CalendarDays className="h-5 w-5 text-primary" />}
          title={t("settings.calendarFeed")}
          description={t("settings.calendarFeedManageDescription")}
          bodyClassName="flex overflow-hidden px-0 py-0 sm:px-0"
          footer={(
            <Button type="button" onClick={() => setManagerOpen(false)} className="h-11 w-full sm:w-auto">
              {t("settings.calendarFeedManageDone")}
            </Button>
          )}
        >
          <TooltipProvider>
            <Tabs
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as CalendarFeedManagerTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="border-b border-border px-4 py-3 sm:px-6">
                <TabsList
                  className="grid h-auto w-full grid-cols-2 sm:w-auto"
                  aria-label={t("settings.calendarFeedTabsLabel")}
                >
                  <TabsTrigger
                    value="global"
                    className="min-h-11 whitespace-normal px-2 py-1 leading-4"
                  >
                    {t("settings.calendarFeedTabGlobal")}
                  </TabsTrigger>
                  <TabsTrigger
                    ref={subscriptionsTabRef}
                    value="subscriptions"
                    className="min-h-11 whitespace-normal px-2 py-1 leading-4"
                  >
                    {t("settings.calendarFeedTabSubscriptions")}
                  </TabsTrigger>
                </TabsList>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
                <TabsContent value="global" className="mt-0">
                  <CalendarFeedGlobalPanel
                    controller={controller}
                    generateButtonRef={globalGenerateButtonRef}
                    onConfirm={setConfirmation}
                  />
                </TabsContent>
                <TabsContent value="subscriptions" className="mt-0">
                  <CalendarFeedSubscriptionsPanel
                    controller={controller}
                    onConfirm={setConfirmation}
                  />
                </TabsContent>
              </div>
            </Tabs>
          </TooltipProvider>
        </SettingsManagerDialogFrame>
      </Dialog>

      <AlertDialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open && !confirmationPending) dismissConfirmation(false);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            confirmationFocusTargetRef.current?.()?.focus();
            confirmationFocusTargetRef.current = null;
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.kind === "rotate"
                ? t("settings.calendarFeedRegenerateItemTitle", { name: confirmation.title })
                : t("settings.calendarFeedRevokeItemTitle", { name: confirmation?.title ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.kind === "rotate"
                ? t("settings.calendarFeedRegenerateDescription")
                : t("settings.calendarFeedRevokeItemDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11" disabled={confirmationPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={confirmationPending}
              aria-busy={confirmationPending ? true : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (!confirmation) return;
                const operation = confirmation.kind === "rotate" ? controller.rotate : controller.revoke;
                void operation(confirmation.target).then((succeeded) => {
                  if (succeeded) dismissConfirmation(true);
                });
              }}
            >
              <LoadingButtonContent
                loading={confirmationPending}
                loadingLabel={confirmation?.kind === "rotate"
                  ? t("settings.calendarFeedRegenerating")
                  : t("settings.calendarFeedRevoking")}
              >
                {confirmation?.kind === "rotate"
                  ? t("settings.calendarFeedRegenerate")
                  : t("settings.calendarFeedRevoke")}
              </LoadingButtonContent>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function CalendarFeedGlobalBadge({ controller }: { controller: SettingsCalendarFeedController }) {
  const { t } = useI18n();
  const visual = CALENDAR_FEED_GLOBAL_VISUALS[calendarFeedGlobalVisualStatus(controller.global)];

  return (
    <Badge variant={visual.enabled ? "default" : "secondary"} className="w-fit">
      {t(visual.summaryKey)}
    </Badge>
  );
}

function CalendarFeedPanelStatusBadge({ controller }: { controller: SettingsCalendarFeedController }) {
  const { t } = useI18n();
  const visual = CALENDAR_FEED_GLOBAL_VISUALS[calendarFeedGlobalVisualStatus(controller.global)];
  if (!visual.panelKey) return null;

  return (
    <Badge variant={visual.enabled ? "default" : "secondary"} className="w-fit shrink-0">
      {t(visual.panelKey)}
    </Badge>
  );
}

function calendarFeedGlobalVisualStatus(
  global: SettingsCalendarFeedController["global"],
): CalendarFeedGlobalVisualStatus {
  if (!global.hasData) return global.isInitialLoading ? "loading" : "unknown";
  const enabled = global.data?.enabled === true && Boolean(global.data.feedUrl);
  if (global.error) return enabled ? "enabled-stale" : "disabled-stale";
  return enabled ? "enabled" : "disabled";
}

function CalendarFeedSubscriptionSummary({ controller }: { controller: SettingsCalendarFeedController }) {
  const { t } = useI18n();
  const { subscriptions } = controller;
  if (subscriptions.isInitialLoading) {
    return (
      <div role="status" aria-label={t("settings.calendarFeedSubscriptionsSummaryLoading")} className="mt-2">
        <Skeleton aria-hidden="true" className="h-4 w-28" />
      </div>
    );
  }
  const summary = !subscriptions.hasData && subscriptions.error
    ? t("settings.calendarFeedSubscriptionsSummaryFailed")
    : subscriptions.error
      ? t("settings.calendarFeedSubscriptionsSummaryStale", { count: subscriptions.data?.total ?? 0 })
      : t("settings.calendarFeedSubscriptionsSummary", { count: subscriptions.data?.total ?? 0 });

  return <span>{summary}</span>;
}

function CalendarFeedGlobalPanel({
  controller,
  generateButtonRef,
  onConfirm,
}: {
  controller: SettingsCalendarFeedController;
  generateButtonRef: RefObject<HTMLButtonElement | null>;
  onConfirm: (confirmation: CalendarFeedConfirmation) => void;
}) {
  const { t } = useI18n();
  const { global } = controller;
  const feed = global.data;
  const enabled = feed?.enabled === true && Boolean(feed.feedUrl);
  const targetKey = calendarFeedTargetKey(GLOBAL_CALENDAR_FEED_TARGET);
  const pending = controller.pendingTargetKey === targetKey;
  const creating = pending && controller.pendingKind === "create";

  return (
    <div className="grid gap-4">
      <div className="flex min-w-0 flex-col gap-2 min-[480px]:flex-row min-[480px]:items-start min-[480px]:justify-between">
        <p className="max-w-xl text-xs leading-5 text-muted-foreground">
          {t("settings.calendarFeedGlobalScope")}
        </p>
        <CalendarFeedPanelStatusBadge controller={controller} />
      </div>

      <ManagerDataBoundary
        state={global}
        loading={<div role="status" aria-label={t("settings.calendarFeedGlobalLoading")}><Skeleton className="h-28 w-full" /></div>}
      >
        {enabled && feed?.feedUrl ? (
          <div className="grid gap-3">
            <CalendarFeedPrivacyHint />
            <CalendarFeedUrlActions
              title={t("settings.calendarFeedTabGlobal")}
              feedUrl={feed.feedUrl}
              target={GLOBAL_CALENDAR_FEED_TARGET}
              controller={controller}
              onConfirm={onConfirm}
            />
          </div>
        ) : (
          <div className="flex justify-end py-2">
            <Button
              ref={generateButtonRef}
              type="button"
              className="h-11 w-full shrink-0 min-[480px]:w-auto"
              aria-label={t("settings.calendarFeedGenerateGlobalAction")}
              onClick={() => void controller.create(GLOBAL_CALENDAR_FEED_TARGET)}
              disabled={controller.pendingTargetKey !== null}
              aria-busy={creating ? true : undefined}
            >
              <LoadingButtonContent loading={creating} loadingLabel={t("common.saving")}>
                <CalendarPlus className="h-4 w-4" />
                {t("settings.calendarFeedGenerate")}
              </LoadingButtonContent>
            </Button>
          </div>
        )}
      </ManagerDataBoundary>
    </div>
  );
}

function CalendarFeedSubscriptionsPanel({
  controller,
  onConfirm,
}: {
  controller: SettingsCalendarFeedController;
  onConfirm: (confirmation: CalendarFeedConfirmation) => void;
}) {
  const { t } = useI18n();
  const { subscriptions } = controller;
  const items = subscriptions.data?.items ?? [];

  return (
    <ManagerDataBoundary
      state={subscriptions}
      loading={(
        <div role="status" aria-label={t("settings.calendarFeedSubscriptionsLoading")} className="grid gap-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}
    >
      {items.length > 0 ? (
        <div className="grid gap-3">
          <CalendarFeedPrivacyHint />
          <div
            className="overflow-hidden rounded-md border border-border"
            role="list"
            aria-label={t("settings.calendarFeedSubscriptionsList")}
          >
            {items.map((item) => (
              <CalendarFeedSubscriptionRow
                key={item.id}
                item={item}
                controller={controller}
                onConfirm={onConfirm}
              />
            ))}
          </div>
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t("settings.calendarFeedSubscriptionsEmpty")}
        </p>
      )}

      {subscriptions.data?.hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full gap-2 border-border"
          onClick={() => void subscriptions.loadMore()}
          disabled={subscriptions.isLoadingMore}
          aria-busy={subscriptions.isLoadingMore ? true : undefined}
        >
          <LoadingButtonContent
            loading={subscriptions.isLoadingMore}
            loadingLabel={t("settings.calendarFeedLoadingMore")}
          >
            {t("settings.calendarFeedLoadMore")}
          </LoadingButtonContent>
        </Button>
      ) : null}
    </ManagerDataBoundary>
  );
}

function CalendarFeedPrivacyHint() {
  const { t } = useI18n();
  // Feed URL 本身就是读取凭证；只在真实 URL 出现时提示，避免空态把一次性 ICS 误解为依赖 token。
  return <p className="text-xs leading-5 text-muted-foreground">{t("settings.calendarFeedPrivateUrlHint")}</p>;
}

function CalendarFeedSubscriptionRow({
  item,
  controller,
  onConfirm,
}: {
  item: SubscriptionCalendarFeedListItem;
  controller: SettingsCalendarFeedController;
  onConfirm: (confirmation: CalendarFeedConfirmation) => void;
}) {
  const { t, formatDateOnly, label } = useI18n();
  const { config } = useCustomConfigState();
  const status = config.statuses.find((candidate) => candidate.value === item.subscription.status);
  const statusLabel = status ? label(status.labels) : item.subscription.status;
  const target: CalendarFeedTarget = {
    scope: "subscription",
    subscriptionId: item.subscription.id,
  };

  return (
    <div role="listitem" className="grid min-w-0 gap-3 border-b border-border bg-background px-3 py-4 last:border-b-0">
      <div className="min-w-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <h4
              tabIndex={0}
              className="truncate rounded-sm text-sm font-medium text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {item.subscription.name}
            </h4>
          </TooltipTrigger>
          <TooltipContent>{item.subscription.name}</TooltipContent>
        </Tooltip>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("settings.calendarFeedSubscriptionMeta", {
            status: statusLabel,
            date: formatDateOnly(item.subscription.nextBillingDate, "short"),
          })}
        </p>
      </div>
      <CalendarFeedUrlActions
        title={item.subscription.name}
        feedUrl={item.feedUrl}
        target={target}
        controller={controller}
        onConfirm={onConfirm}
      />
    </div>
  );
}

function CalendarFeedUrlActions({
  title,
  feedUrl,
  target,
  controller,
  onConfirm,
}: {
  title: string;
  feedUrl: string;
  target: CalendarFeedTarget;
  controller: SettingsCalendarFeedController;
  onConfirm: (confirmation: CalendarFeedConfirmation) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = controller.pendingTargetKey === calendarFeedTargetKey(target);

  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Tooltip>
          <TooltipTrigger asChild>
            <Input
              ref={inputRef}
              value={feedUrl}
              readOnly
              className="min-w-0 border-border bg-secondary font-mono text-xs"
              aria-label={t("settings.calendarFeedUrlFor", { name: title })}
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-sm break-all text-xs">{feedUrl}</TooltipContent>
        </Tooltip>
        <Button
          type="button"
          variant="outline"
          className="h-11 border-border"
          aria-label={t("settings.calendarFeedCopyFor", { name: title })}
          onClick={() => void controller.copyUrl(feedUrl, inputRef.current)}
          disabled={pending}
        >
          <Clipboard className="h-4 w-4" />
          {t("settings.calendarFeedCopy")}
        </Button>
      </div>

      <div className="flex min-w-0 flex-col gap-2 min-[480px]:flex-row min-[480px]:flex-wrap">
        <Button
          type="button"
          variant="outline"
          className="h-11 border-border"
          aria-label={t("settings.calendarFeedOpenSystemFor", { name: title })}
          onClick={() => void controller.openSystem(feedUrl)}
          disabled={pending}
        >
          <CalendarPlus className="h-4 w-4" />
          {t("settings.calendarFeedOpenSystem")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11 border-border"
          aria-label={t("settings.calendarFeedRegenerateFor", { name: title })}
          disabled={controller.pendingTargetKey !== null}
          onClick={(event) => onConfirm({ kind: "rotate", target, title, trigger: event.currentTarget })}
        >
          <RefreshCw className="h-4 w-4" />
          {t("settings.calendarFeedRegenerate")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 text-destructive hover:text-destructive"
          aria-label={t("settings.calendarFeedRevokeFor", { name: title })}
          disabled={controller.pendingTargetKey !== null}
          onClick={(event) => onConfirm({ kind: "revoke", target, title, trigger: event.currentTarget })}
        >
          <Trash2 className="h-4 w-4" />
          {t("settings.calendarFeedRevoke")}
        </Button>
      </div>
    </div>
  );
}
