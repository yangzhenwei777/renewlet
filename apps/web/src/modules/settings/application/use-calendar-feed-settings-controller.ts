import { useMemo } from "react";
import type {
  CalendarFeedStatus,
  SubscriptionCalendarFeedListItem,
} from "@/lib/api/schemas/calendar-feed";
import {
  useCalendarFeedStatus,
  useCreateCalendarFeed,
  useDeleteCalendarFeed,
  useRotateCalendarFeed,
  useSubscriptionCalendarFeeds,
} from "@/hooks/use-calendar-feed";
import { toast } from "@/components/ui/sonner";
import { useI18n } from "@/i18n/I18nProvider";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { openValidatedWebcalUrl } from "@/shared/browser/calendar-links";
import { copyTextToClipboard, type ClipboardCopyTarget } from "@/shared/browser/clipboard";
import { calendarFeedTargetKey, type CalendarFeedTarget } from "@/services/calendar-feed-service";
import { toSettingsReadState, type SettingsReadState } from "./settings-read-state";

type CalendarFeedMutationKind = "create" | "rotate" | "revoke";

type SettingsGlobalCalendarFeedState = SettingsReadState<CalendarFeedStatus>;

interface SettingsSubscriptionCalendarFeedData {
  items: SubscriptionCalendarFeedListItem[];
  total: number;
  hasMore: boolean;
}

interface SettingsSubscriptionCalendarFeedState extends SettingsReadState<SettingsSubscriptionCalendarFeedData> {
  isLoadingMore: boolean;
  loadMore: () => Promise<void>;
}

export interface SettingsCalendarFeedController {
  global: SettingsGlobalCalendarFeedState;
  subscriptions: SettingsSubscriptionCalendarFeedState;
  pendingTargetKey: string | null;
  pendingKind: CalendarFeedMutationKind | null;
  create: (target: CalendarFeedTarget) => Promise<boolean>;
  rotate: (target: CalendarFeedTarget) => Promise<boolean>;
  revoke: (target: CalendarFeedTarget) => Promise<boolean>;
  copyUrl: (feedUrl: string, target?: ClipboardCopyTarget | null) => Promise<void>;
  openSystem: (feedUrl: string) => Promise<void>;
}

const GLOBAL_CALENDAR_FEED_TARGET: CalendarFeedTarget = { scope: "all" };

export function useCalendarFeedSettingsController(): SettingsCalendarFeedController {
  const { t } = useI18n();
  const globalFeed = useCalendarFeedStatus(GLOBAL_CALENDAR_FEED_TARGET);
  const subscriptionFeeds = useSubscriptionCalendarFeeds();
  const createFeed = useCreateCalendarFeed();
  const rotateFeed = useRotateCalendarFeed();
  const deleteFeed = useDeleteCalendarFeed();
  const subscriptionItems = useMemo(
    () => subscriptionFeeds.data?.pages.flatMap((page) => page.items) ?? [],
    [subscriptionFeeds.data?.pages],
  );
  const subscriptionData = useMemo<SettingsSubscriptionCalendarFeedData | undefined>(() => {
    if (!subscriptionFeeds.data) return undefined;
    return {
      items: subscriptionItems,
      total: subscriptionFeeds.data.pages[0]?.total ?? 0,
      hasMore: Boolean(subscriptionFeeds.hasNextPage),
    };
  }, [subscriptionFeeds.data, subscriptionFeeds.hasNextPage, subscriptionItems]);
  const activeMutation = createFeed.isPending
    ? { kind: "create" as const, target: createFeed.variables }
    : rotateFeed.isPending
      ? { kind: "rotate" as const, target: rotateFeed.variables }
      : deleteFeed.isPending
        ? { kind: "revoke" as const, target: deleteFeed.variables }
        : null;

  const create = async (target: CalendarFeedTarget) => {
    try {
      await createFeed.mutateAsync(target);
      toast.success(t("settings.calendarFeedGenerated"));
      return true;
    } catch (error) {
      toast.error(t("settings.calendarFeedCreateFailed"), {
        description: getDisplayErrorMessage(error, t("settings.calendarFeedOperationFailedDescription")),
      });
      return false;
    }
  };

  const rotate = async (target: CalendarFeedTarget) => {
    try {
      await rotateFeed.mutateAsync(target);
      toast.success(t("settings.calendarFeedRegenerated"));
      return true;
    } catch (error) {
      toast.error(t("settings.calendarFeedRotateFailed"), {
        description: getDisplayErrorMessage(error, t("settings.calendarFeedOperationFailedDescription")),
      });
      return false;
    }
  };

  const revoke = async (target: CalendarFeedTarget) => {
    try {
      await deleteFeed.mutateAsync(target);
      toast.success(t("settings.calendarFeedRevoked"));
      return true;
    } catch (error) {
      toast.error(t("settings.calendarFeedRevokeFailed"), {
        description: getDisplayErrorMessage(error, t("settings.calendarFeedOperationFailedDescription")),
      });
      return false;
    }
  };

  const copyUrl = async (feedUrl: string, target?: ClipboardCopyTarget | null) => {
    const result = await copyTextToClipboard(feedUrl, { target });
    if (result.ok) {
      toast.success(t("settings.calendarFeedCopied"));
    } else {
      toast.error(t("settings.calendarFeedCopyFailed"), {
        description: t("settings.calendarFeedCopyFailedDescription"),
      });
    }
  };

  const openSystem = async (feedUrl: string) => {
    try {
      await openValidatedWebcalUrl(feedUrl);
      toast.success(t("settings.calendarFeedOpenSystemResult"));
    } catch {
      toast.error(t("settings.calendarFeedOpenSystemFailed"), {
        description: t("settings.calendarFeedOpenSystemFailedDescription"),
      });
    }
  };

  return {
    global: toSettingsReadState(globalFeed),
    subscriptions: {
      ...toSettingsReadState({ ...subscriptionFeeds, data: subscriptionData }),
      isLoadingMore: subscriptionFeeds.isFetchingNextPage,
      loadMore: async () => {
        if (subscriptionFeeds.hasNextPage && !subscriptionFeeds.isFetchingNextPage) {
          await subscriptionFeeds.fetchNextPage();
        }
      },
    },
    pendingTargetKey: activeMutation?.target ? calendarFeedTargetKey(activeMutation.target) : null,
    pendingKind: activeMutation?.kind ?? null,
    create,
    rotate,
    revoke,
    copyUrl,
    openSystem,
  };
}
