import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CostSharingCurrencyConverter } from "@renewlet/shared/cost-sharing";
import { toast } from "@/components/ui/sonner";
import type { Locale } from "@/i18n/locales";
import { localizedLabel } from "@/i18n/locales";
import { translate } from "@/i18n/messages";
import { todayDateOnlyInTimeZone, type DateOnly } from "@/lib/time/date-only";
import { downloadFile } from "@/shared/browser/download-file";
import { exchangeRateSnapshotService } from "@/services/exchange-rate-snapshot-service";
import { subscriptionService } from "@/services/subscription-service";
import type { CustomConfig } from "@/types/config";
import type { AppSettings, Subscription } from "@/types/subscription";

async function loadExchangeRateSnapshotsForExport(signal: AbortSignal) {
  try {
    return await exchangeRateSnapshotService.list({}, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    // 汇率快照是报表口径增强，不能因为读取失败阻断订阅/设置这份基础可恢复导出。
    console.warn("Failed to include exchange-rate snapshots in Renewlet export:", error);
    return [];
  }
}

type SelectSubscriptionsForExport = (subscriptions: readonly Subscription[]) => Subscription[];

/** 完整订阅只在用户显式导出时读取，列表轻量缓存不会被伪装成备份数据。 */
export function useSubscriptionExport(
  config: CustomConfig,
  settings: AppSettings,
  locale: Locale,
  selectSubscriptionsForExport: SelectSubscriptionsForExport,
  today: DateOnly = todayDateOnlyInTimeZone(new Date(), "UTC"),
  costSharingCurrencyConvert?: CostSharingCurrencyConverter | undefined,
) {
  const [exporting, setExporting] = useState(false);
  const exportAbortRef = useRef<AbortController | null>(null);
  const categoryLabelByValue = useMemo(
    () => new Map(config.categories.map((category) => [category.value, localizedLabel(category.labels, locale)])),
    [config.categories, locale],
  );
  const statusLabelByValue = useMemo(
    () => new Map(config.statuses.map((status) => [status.value, localizedLabel(status.labels, locale)])),
    [config.statuses, locale],
  );

  useEffect(() => () => exportAbortRef.current?.abort(), []);

  const runExport = useCallback(async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (exportAbortRef.current) return;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExporting(true);
    try {
      await operation(controller.signal);
    } catch {
      if (!controller.signal.aborted) {
        toast.error(translate(locale, "subscriptions.exportFailed"));
      }
    } finally {
      if (exportAbortRef.current === controller) {
        exportAbortRef.current = null;
        setExporting(false);
      }
    }
  }, [locale]);

  const exportBackup = useCallback((includeSecrets: boolean) => {
    void runExport(async (signal) => {
      // 序列化模块和两个读取互不依赖；显式导出时并行启动，避免代码拆分产生新的请求瀑布。
      const [exportModule, subscriptions, exchangeRateSnapshots] = await Promise.all([
        import("@/modules/import-export/domain/renewlet-export"),
        subscriptionService.exportAll(signal),
        loadExchangeRateSnapshotsForExport(signal),
      ]);
      await exportModule.exportRenewletBackup({
        subscriptions,
        settings,
        customConfig: config,
        includeSecrets,
        exchangeRateSnapshots,
      }, { signal });
    });
  }, [config, runExport, settings]);

  const exportToJSON = useCallback(() => {
    void exportBackup(false);
  }, [exportBackup]);

  const exportToJSONWithSecrets = useCallback(() => {
    void exportBackup(true);
  }, [exportBackup]);

  const exportToCSV = useCallback(() => {
    void runExport(async (signal) => {
      const [exportModule, subscriptions] = await Promise.all([
        import("../domain/subscription-export"),
        subscriptionService.exportAll(signal),
      ]);
      const csvSubscriptions = selectSubscriptionsForExport(subscriptions);
      const csvContent = exportModule.buildSubscriptionsCsv(csvSubscriptions, {
        categoryLabelByValue,
        statusLabelByValue,
        locale,
        today,
        costSharingCalculation: { convert: costSharingCurrencyConvert },
      });
      downloadFile(new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8" }), "subscriptions.csv");
    });
  }, [
    categoryLabelByValue,
    costSharingCurrencyConvert,
    locale,
    runExport,
    selectSubscriptionsForExport,
    statusLabelByValue,
    today,
  ]);

  return { exportToJSON, exportToJSONWithSecrets, exportToCSV, exporting };
}
