/**
 * 通知历史与调度预览面板。
 *
 * 架构位置：
 * - `SettingsScreen` 传入由 `useNotificationHistory` 产出的严格类型数据。
 * - 本组件只做展示、筛选交互和任务详情选择，不直接读取动态 JSON。
 *
 * 状态链路：
 * ```
 * 汇总卡片 -> 打开 Dialog -> upcoming/history tabs
 * 历史筛选 -> hook 重新请求 -> selectedJobId 清空 -> 首条任务作为详情兜底
 * ```
 *
 * 注意： `NotificationJobResult` 是 cron result | empty object。访问 message/channels 前必须用 `hasCronResult` 收窄。
 */
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { AlertTriangle, BellRing, CheckCircle2, Clock, History, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MobileBottomDrawerContent, MobileDrawerRoot } from "@/components/ui/mobile-drawer";
import { TruncatedTooltipText } from "@/components/ui/truncated-tooltip-text";
import { VirtualizedList } from "@/components/ui/virtualized-list";
import {
  Dialog,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMediaQuery } from "@/hooks/use-media-query";
import { formatTimeZoneOffset } from "@/lib/time/time-zone";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nProvider";
import { CHANNEL_LABELS, type NotificationChannel } from "@/types/subscription";
import type {
  NotificationJobResult,
  NotificationHistoryJob,
  NotificationHistoryStatusFilter,
  SettingsNotificationHistoryController,
  UpcomingNotificationBatch,
} from "../application/use-notification-history";
import { ManagerDataBoundary } from "./manager-data-boundary";
import { SettingsManagerDialogFrame } from "./settings-manager-dialog-frame";

const UPCOMING_VIRTUALIZATION_THRESHOLD = 30;
const UPCOMING_BATCH_GAP = 12;
const UPCOMING_BATCH_ESTIMATE = 132;

type NotificationHistoryPanelProps = {
  controller: SettingsNotificationHistoryController;
};

function formatSchedule(date: string, time: string, timeZone: string, scheduledInstantUtc: string) {
  return `${date} ${time} (${formatTimeZoneOffset(timeZone, new Date(scheduledInstantUtc))})`;
}

function repeatIntervalHours(interval: string) {
  const hours = Number.parseInt(interval, 10);
  return Number.isFinite(hours) && hours > 0 ? hours : 0;
}

function getStatusClass(status: NotificationHistoryJob["status"]) {
  if (status === "sent") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600";
  if (status === "failed") return "border-destructive/30 bg-destructive/10 text-destructive";
  if (status === "skipped") return "border-amber-500/30 bg-amber-500/10 text-amber-600";
  return "border-border bg-secondary/50 text-muted-foreground";
}

function StatusIcon({ status }: { status: NotificationHistoryJob["status"] }) {
  if (status === "sent") return <CheckCircle2 className="h-3 w-3" />;
  if (status === "failed") return <XCircle className="h-3 w-3" />;
  if (status === "skipped") return <AlertTriangle className="h-3 w-3" />;
  return <Clock className="h-3 w-3" />;
}

function hasCronResult(result: NotificationJobResult): result is Extract<NotificationJobResult, { source: "cron" }> {
  // 后端允许早期/空任务保存 `{}`；判别字段收窄能让详情面板安全地读取 message/channels。
  return "source" in result && result.source === "cron";
}

function getResultReason(job: NotificationHistoryJob) {
  return hasCronResult(job.result) && job.result.reason ? job.result.reason : job.lastError ?? "ok";
}

function getResultItems(job: NotificationHistoryJob) {
  return hasCronResult(job.result) ? job.result.message.items : [];
}

function getResultChannels(job: NotificationHistoryJob) {
  return hasCronResult(job.result)
    ? job.result.channels
    : { attempted: [], succeeded: [], failed: [] };
}

function getMessageContent(job: NotificationHistoryJob) {
  return hasCronResult(job.result) ? job.result.message.content : "";
}

function formatNotificationChannel(channel: NotificationChannel, label: ReturnType<typeof useI18n>["label"]) {
  return label(CHANNEL_LABELS[channel]);
}

function formatNotificationChannels(channels: NotificationChannel[], label: ReturnType<typeof useI18n>["label"], emptyLabel: string) {
  return channels.length > 0
    ? channels.map((channel) => formatNotificationChannel(channel, label)).join(", ")
    : emptyLabel;
}

function SummaryValue({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg bg-secondary/50 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <TruncatedTooltipText
        as="div"
        text={value}
        className={cn("mt-1 text-sm font-medium", muted ? "text-muted-foreground" : "text-foreground")}
      />
    </div>
  );
}

function getUpcomingBatchKey(batch: UpcomingNotificationBatch) {
  return `${batch.scheduledLocalDate}-${batch.scheduledLocalTime}-${batch.timeZone}`;
}

function formatUpcomingItemTarget(
  item: UpcomingNotificationBatch["items"][number],
  t: ReturnType<typeof useI18n>["t"],
  formatCurrency: ReturnType<typeof useI18n>["formatCurrency"],
) {
  if (item.type === "costSharing" && item.costSharing) {
    return t("notification.targetCostSharingReminder", {
      date: item.targetDate,
      member: item.costSharing.memberName,
      amount: formatCurrency(item.costSharing.amount, item.costSharing.currency),
      days: item.reminderDays,
    });
  }
  if (item.type === "expired") return t("notification.dailyIncluded");
  if (item.repeatReminder) {
    return t("notification.targetRepeatReminder", {
      date: item.targetDate,
      hours: repeatIntervalHours(item.repeatReminder.interval),
    });
  }
  return t("notification.targetReminder", { date: item.targetDate, days: item.reminderDays });
}

function UpcomingBatchCard({ batch }: { batch: UpcomingNotificationBatch }) {
  const { t, formatCurrency } = useI18n();
  return (
    <div className="min-w-0 rounded-lg border border-border bg-secondary/30 p-3 sm:p-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <TruncatedTooltipText
          as="div"
          text={formatSchedule(
            batch.scheduledLocalDate,
            batch.scheduledLocalTime,
            batch.timeZone,
            batch.scheduledInstantUtc,
          )}
          className="min-w-0 flex-1 text-sm font-medium text-foreground"
        />
        <Badge variant="outline" className="shrink-0 border-border text-muted-foreground">
          {t("notification.items", { count: batch.items.length })}
        </Badge>
      </div>
      <div className="mt-3 grid gap-2">
        {batch.items.map((item, index) => (
          <div key={`${item.subscriptionId}-${item.type}-${item.targetDate}-${index}`} className="flex min-w-0 flex-col gap-1 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <TruncatedTooltipText text={item.name} className="min-w-0 flex-1 text-foreground" />
            <span className="wrap-break-word text-xs text-muted-foreground sm:shrink-0 sm:text-right">
              {formatUpcomingItemTarget(item, t, formatCurrency)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function UpcomingBatchList({
  batches,
  scrollElementRef,
}: {
  batches: UpcomingNotificationBatch[];
  scrollElementRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const getScrollElement = useCallback(() => scrollElementRef.current, [scrollElementRef]);
  const getItemKey = useCallback((index: number) => {
    const batch = batches[index];
    return batch ? getUpcomingBatchKey(batch) : index;
  }, [batches]);
  const renderItem = useCallback((index: number) => {
    const batch = batches[index];
    return batch ? <UpcomingBatchCard batch={batch} /> : null;
  }, [batches]);

  if (batches.length === 0) {
    return <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground sm:p-6">{t("notification.upcoming.empty")}</div>;
  }

  if (batches.length > UPCOMING_VIRTUALIZATION_THRESHOLD) {
    return (
      <VirtualizedList
        count={batches.length}
        estimatedItemSize={UPCOMING_BATCH_ESTIMATE}
        gap={UPCOMING_BATCH_GAP}
        getItemKey={getItemKey}
        getScrollElement={getScrollElement}
        overscan={5}
        testId="virtualized-upcoming-notification-list"
        renderItem={renderItem}
      />
    );
  }

  return (
    <div className="grid gap-3">
      {batches.map((batch) => (
        <UpcomingBatchCard key={getUpcomingBatchKey(batch)} batch={batch} />
      ))}
    </div>
  );
}

function HistoryRow({ job, selected, onSelect }: { job: NotificationHistoryJob; selected: boolean; onSelect: () => void }) {
  const { t } = useI18n();
  const items = getResultItems(job);
  const reason = getResultReason(job);

  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="notification-history-row"
      className={cn(
        "grid w-full min-w-0 grid-cols-1 gap-2 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto_auto_minmax(110px,160px)] sm:items-center",
        selected ? "bg-primary/5" : "hover:bg-secondary/50",
      )}
    >
      <div className="min-w-0">
        <TruncatedTooltipText
          as="div"
          text={formatSchedule(
            job.scheduledLocalDate,
            job.scheduledLocalTime,
            job.timeZone,
            job.scheduledInstantUtc,
          )}
          className="text-sm font-medium text-foreground"
        />
        <TruncatedTooltipText as="div" text={reason} className="mt-1 text-xs text-muted-foreground" />
      </div>
      <Badge variant="outline" className={cn("w-fit shrink-0 gap-1", getStatusClass(job.status))}>
        <StatusIcon status={job.status} />
        {t(`notification.status.${job.status}`)}
      </Badge>
      <div className="whitespace-nowrap text-xs text-muted-foreground">{t("notification.items", { count: items.length })}</div>
      <div className="min-w-0 wrap-break-word text-xs text-muted-foreground">{t("notification.attempts", { count: job.attempts })}</div>
    </button>
  );
}

function HistoryDetail({ job, className, testId }: { job: NotificationHistoryJob; className?: string; testId?: string }) {
  const { t, label, formatDateTime } = useI18n();
  const channels = getResultChannels(job);
  const content = getMessageContent(job);
  const failed = channels.failed;
  const attempted = channels.attempted;
  const succeeded = channels.succeeded;
  const emptyChannelsLabel = t("common.none");

  return (
    <div className={cn("min-w-0 rounded-lg border border-border bg-secondary/30 p-3 sm:p-4", className)} data-testid={testId}>
      <div className="grid gap-3 sm:grid-cols-2">
        <SummaryValue label={t("notification.createdAt")} value={formatDateTime(job.createdAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} />
        <SummaryValue label={t("notification.updatedAt")} value={formatDateTime(job.updatedAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} />
        <SummaryValue label={t("notification.attemptedChannels")} value={formatNotificationChannels(attempted, label, emptyChannelsLabel)} />
        <SummaryValue label={t("notification.succeededChannels")} value={formatNotificationChannels(succeeded, label, emptyChannelsLabel)} />
      </div>

      {Array.isArray(failed) && failed.length > 0 ? (
        <div className="mt-4 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
          {failed.map((item, index) => (
            <div key={index} className="wrap-break-word">
              {formatNotificationChannel(item.channel, label)}：{item.error}
            </div>
          ))}
        </div>
      ) : null}

      {content ? (
        <pre className="mt-4 max-h-48 max-w-full overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-background p-3 text-xs text-foreground">{content}</pre>
      ) : null}
    </div>
  );
}

function HistoryDetailDrawer({
  job,
  open,
  onOpenChange,
}: {
  job: NotificationHistoryJob | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();

  return (
    <MobileDrawerRoot open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
      {open && job ? (
        <MobileBottomDrawerContent
          title={t("notification.historyDetailTitle")}
          description={formatSchedule(
            job.scheduledLocalDate,
            job.scheduledLocalTime,
            job.timeZone,
            job.scheduledInstantUtc,
          )}
          descriptionClassName="truncate text-xs"
          closeLabel={t("common.close")}
          icon={<History className="h-5 w-5 shrink-0 text-primary" />}
          className="h5-notification-history-detail-drawer"
          zIndexClassName="z-70"
          data-testid="notification-history-detail-drawer"
        >
          <HistoryDetail job={job} />
        </MobileBottomDrawerContent>
      ) : null}
    </MobileDrawerRoot>
  );
}

function HistoryList({
  jobs,
  selectedJobId,
  onSelect,
}: {
  jobs: NotificationHistoryJob[];
  selectedJobId: string | null;
  onSelect: (jobId: string) => void;
}) {
  const { t } = useI18n();
  if (jobs.length === 0) {
    return <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground sm:p-6">{t("notification.historyEmpty")}</div>;
  }

  const firstJob = jobs[0];
  if (!firstJob) return null;
  const selected = jobs.find((job) => job.id === selectedJobId) ?? firstJob;

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]">
      <div className="min-w-0 overflow-hidden rounded-lg border border-border">
        {jobs.map((job) => (
          <HistoryRow key={job.id} job={job} selected={selected.id === job.id} onSelect={() => onSelect(job.id)} />
        ))}
      </div>
      <HistoryDetail job={selected} className="hidden lg:block" testId="notification-history-desktop-detail" />
    </div>
  );
}

export function NotificationHistoryPanel({
  controller,
}: NotificationHistoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"upcoming" | "history">("upcoming");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [detailJob, setDetailJob] = useState<NotificationHistoryJob | null>(null);
  const isCompactHistoryLayout = useMediaQuery("(max-width: 1023px)");
  const dialogScrollRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const overview = controller.overview;
  const history = controller.history;
  const overviewData = overview.data;
  const historyData = history.data;
  const filterLabels: Array<{ value: NotificationHistoryStatusFilter; label: string }> = [
    { value: "all", label: t("notification.filter.all") },
    { value: "sent", label: t("notification.status.sent") },
    { value: "failed", label: t("notification.status.failed") },
    { value: "skipped", label: t("notification.status.skipped") },
  ];
  const latestJob = overviewData?.summary.latestJob ?? null;
  const nextBatch = overviewData?.summary.nextContentBatch ?? null;
  const blockerText = overviewData?.summary.blockers.includes("no_enabled_channels")
    ? t("notification.blocker.noChannels")
    : overviewData?.summary.blockers.includes("no_upcoming_items")
      ? t("notification.blocker.noUpcoming")
      : t("notification.blocker.ok");

  const latestResult = useMemo(() => {
    if (!latestJob) return t("notification.noHistory");
    return `${t(`notification.status.${latestJob.status}`)} · ${getResultReason(latestJob)}`;
  }, [latestJob, t]);

  return (
    <div className="min-w-0 rounded-lg border border-border bg-secondary/30 p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <ManagerDataBoundary state={overview} className="min-w-0 flex-1">
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-3">
          <SummaryValue
            label={t("notification.nextCheck")}
            value={
              overviewData
                ? formatSchedule(
                  overviewData.summary.nextCheck.scheduledLocalDate,
                  overviewData.summary.nextCheck.scheduledLocalTime,
                  overviewData.summary.nextCheck.timeZone,
                  overviewData.summary.nextCheck.scheduledInstantUtc,
                )
                : t("common.unknown")
            }
            muted={!overviewData}
          />
          <SummaryValue
            label={t("notification.nextContent")}
            value={nextBatch ? `${nextBatch.scheduledLocalDate} · ${t("notification.items", { count: nextBatch.items.length })}` : blockerText}
            muted={!nextBatch}
          />
          <SummaryValue label={t("notification.latestRun")} value={latestResult} muted={!latestJob} />
        </div>
        </ManagerDataBoundary>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" className="w-full gap-2 sm:w-auto lg:self-end">
              <History className="h-4 w-4" />
              {t("notification.viewScheduleHistory")}
            </Button>
          </DialogTrigger>
          <SettingsManagerDialogFrame
            icon={<BellRing className="h-5 w-5 text-primary" />}
            title={t("notification.historyTitle")}
            description={t("notification.historyDescription")}
            bodyClassName="flex overflow-hidden px-0 py-0 sm:px-0"
            footer={(
              <Button type="button" onClick={() => setOpen(false)} className="w-full sm:w-auto">
                {t("common.close")}
              </Button>
            )}
          >
              <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "upcoming" | "history")} className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <TabsList className="w-full justify-start sm:w-auto">
                    <TabsTrigger value="upcoming" className="flex-1 sm:flex-none">{t("notification.upcomingTab")}</TabsTrigger>
                    <TabsTrigger value="history" className="flex-1 sm:flex-none">{t("notification.historyTab")}</TabsTrigger>
                  </TabsList>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full gap-2 sm:w-auto"
                    onClick={() => void (activeTab === "upcoming" ? overview.retry() : history.retry())}
                    disabled={activeTab === "upcoming" ? overview.isRefreshing : history.isRefreshing}
                  >
                    <RefreshCw className={cn(
                      "h-4 w-4",
                      (activeTab === "upcoming" ? overview.isRefreshing : history.isRefreshing) && "animate-spin",
                    )} />
                    {t("notification.refresh")}
                  </Button>
                </div>

                <div ref={dialogScrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6" data-testid="notification-history-scroll">
                  <TabsContent value="upcoming" className="mt-0">
                    <p className="mb-4 text-xs leading-5 text-muted-foreground">{t("notification.upcomingDescription")}</p>
                    <ManagerDataBoundary state={overview}>
                      <UpcomingBatchList batches={overviewData?.upcoming ?? []} scrollElementRef={dialogScrollRef} />
                    </ManagerDataBoundary>
                  </TabsContent>

                  <TabsContent value="history" className="mt-0 grid gap-4">
                    <p className="text-xs leading-5 text-muted-foreground">{t("notification.executionSnapshotsDescription")}</p>
                    <div className="flex min-w-0 flex-wrap gap-2">
                      {filterLabels.map((item) => (
                        <Button
                          key={item.value}
                          type="button"
                          size="sm"
                          variant={controller.historyStatus === item.value ? "default" : "outline"}
                          className="min-w-0"
                          onClick={() => {
                            setSelectedJobId(null);
                            setDetailJob(null);
                            controller.setStatus(item.value);
                          }}
                        >
                          {item.label}
                        </Button>
                      ))}
                    </div>

                    <ManagerDataBoundary state={history}>
                      <HistoryList
                        jobs={historyData?.jobs ?? []}
                        selectedJobId={selectedJobId}
                        onSelect={(jobId) => {
                          const job = historyData?.jobs.find((item) => item.id === jobId) ?? null;
                          setSelectedJobId(jobId);
                          if (isCompactHistoryLayout) {
                            setDetailJob(job);
                          }
                        }}
                      />
                    </ManagerDataBoundary>

                    {historyData?.hasMore ? (
                      <div className="flex justify-center">
                        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={controller.loadMore} disabled={history.isRefreshing}>
                          {t("notification.loadMore")}
                        </Button>
                      </div>
                    ) : null}
                  </TabsContent>
                </div>
              </Tabs>
          </SettingsManagerDialogFrame>
          <HistoryDetailDrawer
            job={detailJob}
            open={Boolean(detailJob)}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) {
                setDetailJob(null);
              }
            }}
          />
        </Dialog>
      </div>
    </div>
  );
}
