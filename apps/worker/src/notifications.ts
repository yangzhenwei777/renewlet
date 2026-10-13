import { z } from "zod";
import {
  type NotificationEmailItem,
  type NotificationEmailMessage,
} from "@renewlet/shared/email-template";
import {
  notificationHistoryPayloadSchema,
  notificationOverviewPayloadSchema,
  notificationRunPayloadSchema,
  notificationsRunBodySchema,
  notificationsTestBodySchema,
  type NotificationHistoryStatusFilter,
} from "@renewlet/shared/schemas/notifications";
import { effectiveReminderDays, isDisabledReminderDays } from "@renewlet/shared/runtime";
import { appSettingsSchema, applySettingsSecretUpdates, settingsUpdateBodySchema, type ApiAppSettings } from "@renewlet/shared/schemas/settings";
import type { ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { divideMoney, type MoneyString } from "@renewlet/shared/money";
import { costSharingCollectionReminderOccurrencesForDate } from "@renewlet/shared/cost-sharing";
import { isOneTimeBuyout } from "@renewlet/shared/subscription-billing";
import { cleanBuiltInIconSourceSettingsPatch, mergeBuiltInIconSourceSettings } from "@renewlet/shared/built-in-icons";
import { cleanOnlineIconSourceSettingsPatch, mergeOnlineIconSourceSettings } from "@renewlet/shared/online-icon-sources";
import {
  getSettings,
  listNotificationScheduleCandidateSubscriptions,
  listRepeatReminderCandidateSubscriptions,
  listSubscriptions,
  parseJobResult,
  toApiSubscription,
} from "./db";
import { renewAutoSubscriptionsForUserWithSettings } from "./subscription-renewal";
import { refreshCostSharingCollectionReminderMirrors } from "./subscriptions";
import { advanceSubscriptionSchedulerDueState, getSubscriptionSchedulerState } from "./subscription-scheduler-state";
import { HttpError, ok, readOptionalJson, readJson, requestLocale, successJson, type AppLocale } from "./http";
import { accountContentLocale, serverFormat, serverText } from "./server-i18n";
import { requireAuth } from "./auth";
import { notificationChannelErrorDetails } from "./notification-errors";
import { sendChannel, sendChannels } from "./notification-channel-send";
import type { Env, NotificationJobRow } from "./types";
import { readNotificationHistoryRows } from "./notification-message-storage";
import { runCronForUser, type CronRunOutcome } from "./notification-cron";
import type { CronBudget } from "./cron-budget";
import {
  NOTIFICATION_CRON_WINDOW_MINUTES,
  normalizeNotificationJobResultForHistory,
  publicScheduleOccurrence,
  type SendSummary,
} from "./notification-jobs";
import {
  addDays,
  dateOnlyInZone,
  daysBetween,
  displayTime,
  getLocalScheduleDecision,
  getNextLocalScheduleOccurrence,
  getNextRepeatScheduleOccurrence,
  getRepeatScheduleDecision,
  nextRepeatOccurrenceAfter,
  repeatReminderOccurrenceMatches,
  repeatReminderSnapshot,
  scheduleOccurrence,
  isSubscriptionReminderEligible,
  type RepeatReminderSnapshot,
  type ScheduleOccurrence,
} from "./notification-schedule";


type NotificationMessage = NotificationEmailMessage;

/** 发送单渠道测试通知；settings 只临时合并，正文跟随请求语言，两者都不改写账号偏好。 */
export async function notificationTest(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, notificationsTestBodySchema, locale);
  const settings = await effectiveSettings(env, auth.user.id, body.settings);
  const message = buildTestMessage(new Date(), settings, locale);
  try {
    await sendChannel(env, body.channel, settings, message, locale, requestAppUrl(request));
  } catch (error) {
    throw new HttpError(
      400,
      serverFormat(locale, "notification.testFailed", { error: error instanceof Error ? error.message : String(error) }),
      "NOTIFICATION_TEST_FAILED",
      notificationChannelErrorDetails(error),
    );
  }
  return ok();
}

/** 手动运行当前用户通知任务；正文跟随请求语言，force 只影响本次 due 判断。 */
export async function notificationRun(request: Request, env: Env): Promise<Response> {
  const startedAt = performance.now();
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readOptionalJson(request, notificationsRunBodySchema, locale);
  const result = await runManualForUser(env, auth.user.id, body.force === true, body.settings, locale, { appUrl: requestAppUrl(request) });
  logNotificationResources("manual", result.subscriptionCount, result.sent ? 1 : 0, startedAt);
  if (!result.sent) return successJson(notificationRunPayloadSchema.parse({ sent: false, reason: "no_due_items" }));
  return successJson(notificationRunPayloadSchema.parse({ sent: true, summary: result.summary }));
}

/** 单独计算当前用户通知概览；自动续订和订阅读取不得泄漏到 history 翻页路径。 */
export async function notificationOverview(request: Request, env: Env): Promise<Response> {
  const startedAt = performance.now();
  const auth = await requireAuth(request, env);
  const settings = await getSettings(env, auth.user.id);
  await renewAutoSubscriptionsForUserWithSettings(env, auth.user.id, settings, new Date());
  const subscriptions = (await listSubscriptions(env, auth.user.id)).map(toApiSubscription);
  const overview = buildOverview(new Date(), settings, subscriptions);
  const [latestJob] = await readNotificationHistoryRows(env, auth.user.id, "all", 1);
  const [latestFailedJob] = await readNotificationHistoryRows(env, auth.user.id, "failed", 1);
  logNotificationResources("overview", subscriptions.length, overview.upcoming.length, startedAt);
  return successJson(notificationOverviewPayloadSchema.parse({
    summary: {
      ...overview.summary,
      latestJob: latestJob ? toHistoryJob(latestJob) : null,
      latestFailedJob: latestFailedJob ? toHistoryJob(latestFailedJob) : null,
    },
    upcoming: overview.upcoming,
  }));
}

/** 返回当前用户分页历史审计；状态过滤和读取都限定在 user_id 内。 */
export async function notificationHistory(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const url = new URL(request.url);
  const status = parseHistoryStatus(url.searchParams.get("status"));
  const limit = clamp(parseIntOr(url.searchParams.get("limit"), 20), 1, 50);
  const offset = Math.max(0, parseIntOr(url.searchParams.get("offset"), 0));
  const rows = await readNotificationHistoryRows(env, auth.user.id, status, limit + 1, offset);
  const hasMore = rows.length > limit;
  const jobs = rows.slice(0, limit).map(toHistoryJob);
  return successJson(notificationHistoryPayloadSchema.parse({
    jobs,
    status,
    limit,
    offset,
    hasMore,
  }));
}

function logNotificationResources(operation: "manual" | "overview", subscriptions: number, batches: number, startedAt: number): void {
  console.info("notification_resources", {
    event: "notification_resources",
    operation,
    subscriptions,
    batches,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  });
}

export async function runScheduledForUser(
  env: Env,
  userId: string,
  now = new Date(),
  continued?: { settings: ApiAppSettings; leaseNow: Date; budget: CronBudget },
): Promise<{ subscriptions: number; batches: number; outcome: CronRunOutcome }> {
  const settings = continued?.settings ?? await getSettings(env, userId);
  // Cron 没有设备/请求上下文；明确账号偏好生效，auto 固定按英文生成正文和历史 locale。
  const locale = accountContentLocale(settings.localePreference);
  let repeatCandidatesForRefresh: ApiSubscription[] | undefined;
  let decision = getLocalScheduleDecision(now, settings.timezone, settings.notificationTimeLocal, NOTIFICATION_CRON_WINDOW_MINUTES, false);
  if (!decision.due) {
    const schedulerState = await getSubscriptionSchedulerState(env, userId);
    if (schedulerState.repeat_reminder_count > 0) {
      const repeatCandidates = (await listRepeatReminderCandidateSubscriptions(env, userId, dateOnlyInZone(now, settings.timezone))).map(toApiSubscription);
      repeatCandidatesForRefresh = repeatCandidates;
      // 非日常窗口只允许 repeat 候选参与 due 判断；gate=0 时连候选查询都不做，避免空跑读放大。
      const repeatDecision = getRepeatScheduleDecision(now, settings, repeatCandidates, NOTIFICATION_CRON_WINDOW_MINUTES);
      if (repeatDecision.due) decision = repeatDecision;
    }
  }
  if (!decision.due) {
    await advanceSubscriptionSchedulerDueState(env, userId, now, false, repeatCandidatesForRefresh);
    return { subscriptions: 0, batches: 0, outcome: "settled" };
  }
  const occurrence = publicScheduleOccurrence(decision);
  // due 确认后才推进续订并读取 payload 候选，保持自动续订先于通知内容且不污染非 due 分钟。
  if (!continued) await renewAutoSubscriptionsForUserWithSettings(env, userId, settings, now);
  let subscriptionCount = 0;
  // 续接直接读取冻结正文；只在新一轮开始时查询候选，避免每个渠道重复扫描千条订阅。
  const outcome = await runCronForUser(env, userId, settings, occurrence, continued?.leaseNow ?? now, locale, async () => {
    const subscriptions = (await listNotificationScheduleCandidateSubscriptions(env, userId, {
      scheduledLocalDate: occurrence.scheduledLocalDate, includeExpired: true, showExpired: settings.showExpired,
    })).map(toApiSubscription);
    subscriptionCount = subscriptions.length;
    return buildDueMessageForSchedule(occurrence, continued?.leaseNow ?? now, settings, subscriptions, true, locale);
  }, continued?.budget);
  if (outcome === "settled") {
    // failed/fresh sending 需要继续留在 due-index 内重试；只有 sent/skipped/终止状态才推进到下一次提醒。
    await refreshCostSharingCollectionReminderMirrors(env, userId, settings, addDays(occurrence.scheduledLocalDate, 1));
    const repeatCandidates = (await listRepeatReminderCandidateSubscriptions(
      env,
      userId,
      dateOnlyInZone(now, settings.timezone),
    )).map(toApiSubscription);
    await advanceSubscriptionSchedulerDueState(env, userId, now, true, repeatCandidates);
  }
  return { subscriptions: subscriptionCount, batches: 1, outcome };
}

async function runManualForUser(
  env: Env,
  userId: string,
  force: boolean,
  settingsPatch: SettingsPatch | undefined,
  locale: AppLocale,
  options: { appUrl?: string } = {},
): Promise<{ sent: boolean; summary: SendSummary; subscriptionCount: number }> {
  const settings = await effectiveSettings(env, userId, settingsPatch);
  const now = new Date();
  // 通知正文生成前先幂等推进自动续订，避免已自动续订的旧日期继续进入 expired/renewal 内容。
  await renewAutoSubscriptionsForUserWithSettings(env, userId, settings, now);
  const subscriptions = (await listSubscriptions(env, userId)).map(toApiSubscription);
  const message = buildDueMessage(now, settings, subscriptions, true, locale);
  if (!message.hasPayload && !force) {
    return { sent: false, summary: { attempted: [], succeeded: [], failed: [] }, subscriptionCount: subscriptions.length };
  }
  if (settings.enabledChannels.length === 0) {
    throw new HttpError(400, serverText(locale, "notification.noEnabledChannels"));
  }
  const summary = await sendChannels(env, settings.enabledChannels, settings, message, locale, options.appUrl);
  return { sent: true, summary, subscriptionCount: subscriptions.length };
}

type SettingsPatch = z.infer<typeof settingsUpdateBodySchema>;

/** 合并临时设置 patch 只服务“测试发送/手动运行”，不会写回 D1 用户设置。 */
async function effectiveSettings(env: Env, userId: string, patch?: SettingsPatch): Promise<ApiAppSettings> {
  const current = await getSettings(env, userId);
  const stripped = stripUndefined(patch ?? {});
  const { secretUpdates, ...publicPatch } = stripped;
  const merged = appSettingsSchema.parse({
    ...current,
    ...publicPatch,
    builtInIconSources: mergeBuiltInIconSourceSettings(current.builtInIconSources, cleanBuiltInIconSourceSettingsPatch(publicPatch.builtInIconSources)),
    onlineIconSources: mergeOnlineIconSourceSettings(current.onlineIconSources, cleanOnlineIconSourceSettingsPatch(publicPatch.onlineIconSources)),
    aiRecognition: publicPatch.aiRecognition
      ? { ...current.aiRecognition, ...publicPatch.aiRecognition }
      : current.aiRecognition,
  });
  return applySettingsSecretUpdates(merged, secretUpdates);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function buildOverview(now: Date, settings: ApiAppSettings, subscriptions: ApiSubscription[]) {
  const dailyNextCheck = getNextLocalScheduleOccurrence(now, settings.timezone, settings.notificationTimeLocal);
  const repeatNextCheck = getNextRepeatScheduleOccurrence(now, settings, subscriptions);
  const nextCheck = earlierOccurrence(dailyNextCheck, repeatNextCheck);
  const batchesByKey = new Map<string, ScheduleOccurrence & { items: NotificationEmailItem[] }>();
  // 预览只看未来 30 天，保证设置页打开时不会按订阅总量无限扩展调度计算。
  for (let offset = 0; offset < 30; offset += 1) {
    const occurrence = scheduleOccurrence(addDays(dailyNextCheck.scheduledLocalDate, offset), settings.notificationTimeLocal, settings.timezone);
    appendUpcomingBatch(batchesByKey, occurrence, collectItemsForSchedule(occurrence, settings, subscriptions, { includeExpired: offset === 0 }));
  }
  for (const batch of collectUpcomingRepeatBatches(now, settings, subscriptions, 30)) {
    appendUpcomingBatch(batchesByKey, batch, batch.items);
  }
  const upcoming = [...batchesByKey.values()].sort((a, b) => a.scheduledInstantUtc.localeCompare(b.scheduledInstantUtc));
  const blockers = notificationBlockers(settings);
  if (upcoming.length === 0) blockers.push("no_upcoming_items");
  return {
    summary: {
      nextCheck,
      nextContentBatch: upcoming[0] ?? null,
      blockers,
      enabledChannels: settings.enabledChannels,
      upcomingDays: 30,
    },
    upcoming,
  };
}

function buildTestMessage(now: Date, settings: ApiAppSettings, locale: AppLocale): NotificationMessage {
  return { title: serverText(locale, "notification.content.testTitle"), content: serverText(locale, "notification.content.testBody"), timestamp: displayTime(now, settings), hasPayload: true, items: [] };
}

function buildDueMessage(now: Date, settings: ApiAppSettings, subscriptions: ApiSubscription[], includeExpired: boolean, locale: AppLocale): NotificationMessage {
  const items = collectItems(dateOnlyInZone(now, settings.timezone), settings, subscriptions, { includeExpired });
  return buildMessageFromItems(now, settings, items, locale);
}

function buildDueMessageForSchedule(schedule: ScheduleOccurrence, now: Date, settings: ApiAppSettings, subscriptions: ApiSubscription[], includeExpired: boolean, locale: AppLocale): NotificationMessage {
  const items = collectItemsForSchedule(schedule, settings, subscriptions, { includeExpired });
  return buildMessageFromItems(now, settings, items, locale);
}

function buildMessageFromItems(now: Date, settings: ApiAppSettings, items: NotificationEmailItem[], locale: AppLocale): NotificationMessage {
  const content = items.length === 0
    ? serverText(locale, "notification.content.empty")
    : groupedNotificationContent(items, locale);
  return { title: serverText(locale, "notification.content.title"), content, timestamp: displayTime(now, settings), hasPayload: items.length > 0, items };
}

function groupedNotificationContent(items: NotificationEmailItem[], locale: AppLocale): string {
  const groups = [
    ["renewal", "notification.content.renewalBlock"],
    ["expiry", "notification.content.expiryBlock"],
    ["trial", "notification.content.trialBlock"],
    ["expired", "notification.content.expiredBlock"],
    ["costSharing", "notification.content.costSharingBlock"],
  ] as const;
  return groups
    .map(([type, titleKey]) => {
      const lines = items
        .filter((item) => item.type === type)
        .map((item) => notificationItemLine(item, locale));
      return lines.length > 0 ? `${serverText(locale, titleKey)}\n${lines.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function notificationItemLine(item: NotificationEmailItem, locale: AppLocale): string {
  let extra = serverFormat(locale, "notification.content.reminderDays", { days: item.reminderDays });
  if (item.type === "trial") {
    extra = serverFormat(locale, "notification.content.trialReminderDays", { days: item.reminderDays });
  } else if (item.type === "expiry") {
    extra = serverFormat(locale, "notification.content.expiryReminderDays", { days: item.reminderDays });
  } else if (item.type === "expired") {
    extra = serverText(locale, "notification.content.expiredStatus");
  } else if (item.type === "costSharing" && item.costSharing) {
    extra = serverFormat(locale, "notification.content.costSharingReminderDays", { member: item.costSharing.memberName, days: item.reminderDays });
  }
  if (item.repeatReminder) {
    extra += serverText(locale, "notification.content.repeatSeparator") + serverFormat(locale, "notification.content.repeatEvery", { hours: repeatReminderHours(item.repeatReminder.interval) });
  }
  const amount = item.type === "costSharing" && item.costSharing ? item.costSharing.amount : item.price;
  const currency = item.type === "costSharing" && item.costSharing ? item.costSharing.currency : item.currency;
  return serverFormat(locale, "notification.content.itemLine", {
    name: item.name,
    targetDate: item.targetDate,
    amount: formatAmount(amount),
    currency,
    extra,
  });
}

function repeatReminderHours(interval: string): number {
  const match = /^(\d+)h$/.exec(interval);
  return match?.[1] ? Number.parseInt(match[1], 10) : 1;
}

function formatAmount(amount: string): string {
  return amount;
}

export function collectNotificationItemsForLocalDate(
  localDate: string,
  settings: ApiAppSettings,
  subscriptions: ApiSubscription[],
  options: { includeExpired?: boolean } = {},
): NotificationEmailItem[] {
  return collectItems(localDate, settings, subscriptions, { includeExpired: options.includeExpired ?? true });
}

function collectItems(localDate: string, settings: ApiAppSettings, subscriptions: ApiSubscription[], options: { includeExpired: boolean }): NotificationEmailItem[] {
  const items: NotificationEmailItem[] = [];
  for (const sub of subscriptions) {
    const daysUntilNext = daysBetween(localDate, sub.nextBillingDate);
    const buyout = isOneTimeBuyout(sub);
    const reminderDays = effectiveReminderDays(sub.reminderDays, settings.notificationReminderDays);
    if (isSubscriptionReminderEligible(sub) && !isDisabledReminderDays(sub.reminderDays) && reminderDays !== undefined && !buyout) {
      if (sub.billingCycle === "one-time") {
        if (daysUntilNext === reminderDays) items.push(item("expiry", sub, sub.nextBillingDate, daysUntilNext, reminderDays));
        if (daysUntilNext < 0 && settings.showExpired && options.includeExpired) items.push(item("expired", sub, sub.nextBillingDate, daysUntilNext, reminderDays));
      } else {
        if (daysUntilNext < 0 && settings.showExpired && options.includeExpired) items.push(item("expired", sub, sub.nextBillingDate, daysUntilNext, reminderDays));
        if (daysUntilNext === reminderDays) items.push(item("renewal", sub, sub.nextBillingDate, daysUntilNext, reminderDays));
      }
      if (sub.status === "trial" && sub.trialEndDate) {
        const daysUntilTrial = daysBetween(localDate, sub.trialEndDate);
        if (daysUntilTrial === reminderDays) items.push(item("trial", sub, sub.trialEndDate, daysUntilTrial, reminderDays));
      }
    }
    if (!buyout) {
      items.push(...collectCostSharingCollectionItems(sub, settings, localDate));
    }
  }
  return items;
}

function collectCostSharingCollectionItems(
  sub: ApiSubscription,
  settings: ApiAppSettings,
  localDate: string,
): NotificationEmailItem[] {
  const occurrences = costSharingCollectionReminderOccurrencesForDate({
    costSharing: sub.costSharing,
    subscriptionStartDate: sub.startDate,
    nextBillingDate: sub.nextBillingDate,
    billingCycle: sub.billingCycle,
    customDays: sub.customDays,
    customCycleUnit: sub.customCycleUnit,
    oneTimeTermCount: sub.oneTimeTermCount,
    oneTimeTermUnit: sub.oneTimeTermUnit,
    notificationReminderDays: settings.notificationReminderDays,
    referenceDate: localDate,
  });
  return occurrences.flatMap((occurrence) => {
    const payload = costSharingCollectionPayload(sub, occurrence.member);
    return payload ? [item("costSharing", sub, occurrence.targetDate, occurrence.reminderDays, occurrence.reminderDays, undefined, payload)] : [];
  });
}

function costSharingCollectionPayload(
  sub: ApiSubscription,
  member: NonNullable<ApiSubscription["costSharing"]>["members"][number],
): { memberName: string; amount: MoneyString; currency: string } | null {
  if (!sub.costSharing) return null;
  if (sub.costSharing.splitMode === "custom") {
    if (!member.customAmount) return null;
    // custom 模式只使用成员配置金额和币种；Worker 不做汇率猜测，也不改写为订阅币种。
    return { memberName: member.name, amount: member.customAmount, currency: member.currency ?? sub.currency };
  }
  return {
    memberName: member.name,
    amount: divideMoney(sub.price, sub.costSharing.members.length + 1),
    currency: sub.currency,
  };
}

export function collectNotificationItemsForSchedule(schedule: ScheduleOccurrence, settings: ApiAppSettings, subscriptions: ApiSubscription[], options: { includeExpired?: boolean } = {}): NotificationEmailItem[] {
  return collectItemsForSchedule(schedule, settings, subscriptions, { includeExpired: options.includeExpired ?? true });
}

function collectItemsForSchedule(schedule: ScheduleOccurrence, settings: ApiAppSettings, subscriptions: ApiSubscription[], options: { includeExpired: boolean }): NotificationEmailItem[] {
  const items: NotificationEmailItem[] = [];
  if (schedule.scheduledLocalTime === settings.notificationTimeLocal) {
    items.push(...collectItems(schedule.scheduledLocalDate, settings, subscriptions, options));
  }
  items.push(...collectRepeatItems(schedule, settings, subscriptions));
  return items;
}

function collectRepeatItems(schedule: ScheduleOccurrence, settings: ApiAppSettings, subscriptions: ApiSubscription[]): NotificationEmailItem[] {
  const items: NotificationEmailItem[] = [];
  for (const sub of subscriptions) {
    // one-time 固定服务期只发首轮到期提醒；repeat 留给周期订阅和 trial，避免买断项反复打扰。
    if (!isSubscriptionReminderEligible(sub) || isDisabledReminderDays(sub.reminderDays) || sub.billingCycle === "one-time" || !sub.repeatReminderEnabled) continue;
    const reminderDays = effectiveReminderDays(sub.reminderDays, settings.notificationReminderDays);
    if (reminderDays === undefined) continue;
    const repeat = repeatReminderSnapshot(sub);
    if (repeatReminderOccurrenceMatches(schedule, settings, reminderDays, sub.nextBillingDate, repeat)) {
      items.push(item("renewal", sub, sub.nextBillingDate, daysBetween(schedule.scheduledLocalDate, sub.nextBillingDate), reminderDays, repeat));
    }
    if (sub.status === "trial" && sub.trialEndDate && repeatReminderOccurrenceMatches(schedule, settings, reminderDays, sub.trialEndDate, repeat)) {
      items.push(item("trial", sub, sub.trialEndDate, daysBetween(schedule.scheduledLocalDate, sub.trialEndDate), reminderDays, repeat));
    }
  }
  return items;
}

function collectUpcomingRepeatBatches(now: Date, settings: ApiAppSettings, subscriptions: ApiSubscription[], days: number): Array<ScheduleOccurrence & { items: NotificationEmailItem[] }> {
  const end = now.getTime() + Math.max(1, days) * 86_400_000;
  const batchesByKey = new Map<string, ScheduleOccurrence & { items: NotificationEmailItem[] }>();
  for (const sub of subscriptions) {
    if (!isSubscriptionReminderEligible(sub) || isDisabledReminderDays(sub.reminderDays) || sub.billingCycle === "one-time" || !sub.repeatReminderEnabled) continue;
    const reminderDays = effectiveReminderDays(sub.reminderDays, settings.notificationReminderDays);
    if (reminderDays === undefined) continue;
    const repeat = repeatReminderSnapshot(sub);
    const targets = sub.status === "trial" && sub.trialEndDate
      ? [{ type: "renewal" as const, date: sub.nextBillingDate }, { type: "trial" as const, date: sub.trialEndDate }]
      : [{ type: "renewal" as const, date: sub.nextBillingDate }];
    for (const target of targets) {
      let occurrence = nextRepeatOccurrenceAfter(now, settings, reminderDays, target.date, repeat);
      while (occurrence && Date.parse(occurrence.scheduledInstantUtc) <= end) {
        // 当前订阅已足够构造 occurrence item；内层不得重新扫描全部 subscriptions。
        appendUpcomingBatch(batchesByKey, occurrence, [item(target.type, sub, target.date, daysBetween(occurrence.scheduledLocalDate, target.date), reminderDays, repeat)]);
        occurrence = nextRepeatOccurrenceAfter(new Date(Date.parse(occurrence.scheduledInstantUtc) + 60_000), settings, reminderDays, target.date, repeat);
      }
    }
  }
  return [...batchesByKey.values()];
}

function appendUpcomingBatch(
  batches: Map<string, ScheduleOccurrence & { items: NotificationEmailItem[] }>,
  occurrence: ScheduleOccurrence,
  items: NotificationEmailItem[],
): void {
  if (items.length === 0) return;
  const key = `${occurrence.scheduledLocalDate}|${occurrence.scheduledLocalTime}|${occurrence.timeZone}`;
  const existing = batches.get(key);
  if (!existing) {
    batches.set(key, { ...occurrence, items: uniqueNotificationItems(items) });
    return;
  }
  existing.items = uniqueNotificationItems([...existing.items, ...items]);
}

function uniqueNotificationItems(items: NotificationEmailItem[]): NotificationEmailItem[] {
  const seen = new Set<string>();
  const out: NotificationEmailItem[] = [];
  for (const item of items) {
    const repeatKey = item.repeatReminder ? `${item.repeatReminder.interval}/${item.repeatReminder.window}` : "";
    const collectionKey = item.costSharing ? `${item.costSharing.memberName}/${item.costSharing.amount}/${item.costSharing.currency}` : "";
    const key = `${item.type}|${item.subscriptionId}|${item.targetDate}|${repeatKey}|${collectionKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function earlierOccurrence(daily: ScheduleOccurrence, repeat: ScheduleOccurrence | null): ScheduleOccurrence {
  if (!repeat) return daily;
  return Date.parse(repeat.scheduledInstantUtc) < Date.parse(daily.scheduledInstantUtc) ? repeat : daily;
}

function item(
  type: "renewal" | "trial" | "expired" | "expiry" | "costSharing",
  sub: ApiSubscription,
  targetDate: string,
  daysUntil: number,
  reminderDays: number,
  repeatReminder?: RepeatReminderSnapshot,
  costSharing?: { memberName: string; amount: MoneyString; currency: string },
): NotificationEmailItem {
  return {
    type,
    subscriptionId: sub.id,
    name: sub.name,
    price: sub.price,
    currency: sub.currency,
    status: sub.status,
    targetDate,
    // -1 只在订阅存储层表示“继承设置”；通知历史和渠道 payload 保存解析后的可解释天数。
    reminderDays,
    daysUntil,
    ...(repeatReminder ? { repeatReminder } : {}),
    ...(costSharing ? { costSharing } : {}),
  };
}

function toHistoryJob(row: NotificationJobRow) {
  return {
    id: row.id,
    scheduledLocalDate: row.scheduled_local_date,
    scheduledLocalTime: row.scheduled_local_time,
    timeZone: row.time_zone,
    scheduledInstantUtc: row.scheduled_instant_utc,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    result: normalizeNotificationJobResultForHistory(parseJobResult(row)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseHistoryStatus(value: string | null): NotificationHistoryStatusFilter {
  return z.enum(["all", "sent", "failed", "skipped", "sending"]).catch("all").parse(value ?? "all");
}

function notificationBlockers(settings: ApiAppSettings): string[] {
  const blockers: string[] = [];
  if (settings.enabledChannels.length === 0) blockers.push("no_enabled_channels");
  if (settings.enabledChannels.includes("email") && !settings.recipientEmail.trim()) blockers.push("email_recipient_missing");
  return blockers;
}

function requestAppUrl(request: Request): string {
  return new URL(request.url).origin;
}


function parseIntOr(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
