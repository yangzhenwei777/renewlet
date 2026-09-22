import { useCallback, useEffect, useRef, useState } from "react";
import { useBuiltInIconIndexStatus, useCheckBuiltInIconIndexProvider, useRefreshBuiltInIconIndexProvider } from "@/hooks/use-built-in-icon-index";
import { toast } from "@/components/ui/sonner";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { createRawErrorResponseDetails, type RawErrorResponseDetails } from "@/lib/raw-error-response";
import type { BuiltInIconIndexStatus, BuiltInIconRefreshJob } from "@/lib/api/schemas/media";
import { useI18n } from "@/i18n/I18nProvider";
import { BUILT_IN_ICON_PROVIDERS, type BuiltInIconProvider } from "@renewlet/shared/built-in-icons";
import { toSettingsReadState, type SettingsReadState } from "./settings-read-state";

export interface SettingsBuiltInIconIndexController {
  canManage: boolean;
  status: SettingsReadState<BuiltInIconIndexStatus>;
  checkingProviders: BuiltInIconProvider[];
  refreshingProvider: BuiltInIconProvider | null;
  errorDetails: RawErrorResponseDetails | null;
  errorDetailsOpen: boolean;
  setErrorDetailsOpen: (open: boolean) => void;
  checkAllProviders: () => Promise<void>;
  checkProvider: (provider: BuiltInIconProvider) => Promise<void>;
  refreshProvider: (provider: BuiltInIconProvider) => Promise<void>;
}

// 内置图标索引是管理员级全局状态，不能和 settings 表单草稿混在一起，否则会制造未保存提示和普通用户可见状态。
export function useSettingsBuiltInIconIndexController(canManage: boolean): SettingsBuiltInIconIndexController {
  const { t } = useI18n();
  const status = useBuiltInIconIndexStatus(canManage);
  const checkProvider = useCheckBuiltInIconIndexProvider();
  const refreshProvider = useRefreshBuiltInIconIndexProvider();
  const [checkingProviders, setCheckingProviders] = useState<BuiltInIconProvider[]>([]);
  const [refreshingProvider, setRefreshingProvider] = useState<BuiltInIconProvider | null>(null);
  const [errorDetails, setErrorDetails] = useState<RawErrorResponseDetails | null>(null);
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);
  const batchCheckInFlightRef = useRef(false);
  const trackedRefreshJobsRef = useRef(new Map<string, BuiltInIconProvider>());
  const providerStatuses = status.data?.providers;

  useEffect(() => {
    if (!canManage || !status.data || trackedRefreshJobsRef.current.size === 0) return;
    for (const providerStatus of status.data.providers) {
      const job = providerStatus.job;
      if (!job || isRefreshJobActive(job)) continue;
      const provider = trackedRefreshJobsRef.current.get(job.id);
      if (provider !== providerStatus.provider) continue;
      // 只接管当前标签页主动触发的后台任务；历史终态 job 仍留在弹层详情里，不能打开页面就乱弹 toast。
      // 先删除再 toast，防止 React StrictMode 或查询缓存重复通知把同一个 job 提示两次。
      trackedRefreshJobsRef.current.delete(job.id);
      const source = t(`settings.builtInIconSourceShort.${provider}`);
      if (job.status === "succeeded") {
        toast.success(t("settings.builtInIconIndexUpdated", {
            source,
            count: providerStatus.iconCount,
          }));
      } else if (job.status === "failed") {
        toast.error(t("settings.builtInIconIndexRefreshFailed"), {
          description: job.error ?? t("settings.builtInIconIndexRefreshFailedDescription", { source }),
        });
      }
    }
  }, [canManage, status.data, t]);

  const runProviderCheck = useCallback(async (provider: BuiltInIconProvider) => {
    setCheckingProviders((current) => current.includes(provider) ? current : [...current, provider]);
    try {
      await checkProvider.mutateAsync(provider);
    } catch (error) {
      // check 失败仍 refetch 后端状态，因为 GitHub 限流/上游错误会被记录为 provider 级摘要。
      const details = createRawErrorResponseDetails(error);
      setErrorDetails(details);
      setErrorDetailsOpen(true);
      await status.refetch();
    } finally {
      setCheckingProviders((current) => current.filter((item) => item !== provider));
    }
  }, [checkProvider, status]);

  const handleCheckProvider = useCallback(async (provider: BuiltInIconProvider) => {
    if (!canManage || checkProvider.isPending) return;
    await runProviderCheck(provider);
  }, [canManage, checkProvider.isPending, runProviderCheck]);

  const handleCheckAllProviders = useCallback(async () => {
    if (!canManage || checkProvider.isPending || batchCheckInFlightRef.current) return;
    batchCheckInFlightRef.current = true;
    const providers = BUILT_IN_ICON_PROVIDERS.filter((provider) => {
      const providerStatus = providerStatuses?.find((item) => item.provider === provider);
      return refreshingProvider !== provider && !providerStatus?.refreshing;
    });
    setCheckingProviders((current) => Array.from(new Set([...current, ...providers])));
    try {
      // 弹层级检查要串行访问 GitHub feed；并发会放大共享出口 403/429，还会让 badge 状态乱跳。
      for (const provider of providers) {
        await runProviderCheck(provider);
      }
    } finally {
      batchCheckInFlightRef.current = false;
    }
  }, [canManage, checkProvider.isPending, providerStatuses, refreshingProvider, runProviderCheck]);

  const handleRefreshProvider = useCallback(async (provider: BuiltInIconProvider) => {
    if (!canManage || refreshProvider.isPending) return;
    setRefreshingProvider(provider);
    try {
      const response = await refreshProvider.mutateAsync(provider);
      if (response.job.status === "succeeded") {
        toast.success(t("settings.builtInIconIndexUpdated", {
            source: t(`settings.builtInIconSourceShort.${provider}`),
            count: response.provider.iconCount,
          }));
      } else if (isRefreshJobActive(response.job)) {
        // Cloudflare 返回 queued/running 时只说明已入队；真正成功/失败要等轮询看到同一个 job.id 的终态。
        trackedRefreshJobsRef.current.set(response.job.id, provider);
        toast.success(t("settings.builtInIconIndexUpdateQueued", {
            source: t(`settings.builtInIconSourceShort.${provider}`),
          }));
      }
    } catch (error) {
      const details = createRawErrorResponseDetails(error);
      setErrorDetails(details);
      setErrorDetailsOpen(true);
      await status.refetch();
      toast.error(t("settings.builtInIconIndexRefreshFailed"), {
        description: getDisplayErrorMessage(error, t("settings.builtInIconIndexRefreshFailedDescription", {
          source: t(`settings.builtInIconSourceShort.${provider}`),
        })),
      });
    } finally {
      setRefreshingProvider((current) => current === provider ? null : current);
    }
  }, [canManage, refreshProvider, status, t]);

  return {
    canManage,
    status: toSettingsReadState(status),
    checkingProviders,
    refreshingProvider,
    errorDetails,
    errorDetailsOpen,
    setErrorDetailsOpen,
    checkAllProviders: handleCheckAllProviders,
    checkProvider: handleCheckProvider,
    refreshProvider: handleRefreshProvider,
  };
}

function isRefreshJobActive(job: BuiltInIconRefreshJob): boolean {
  return job.status === "queued" || job.status === "running";
}
