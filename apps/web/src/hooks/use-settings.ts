/**
 * 设置页 React Query 数据层。
 *
 * 架构位置：
 * - settingsService 统一调用 Renewlet 产品 API，Docker/Cloudflare 只在后端适配存储。
 * - hook 负责缓存键、401 降级和前端类型归一。
 *
 * 注意： 未登录返回 DEFAULT_SETTINGS 是为了让公共页面/登录前 Provider 能安全渲染；
 * 受保护页面仍由 AuthSync 控制访问。
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
} from "@/types/subscription";
import { EMPTY_SETTINGS_SECRET_STATUS, normalizeSettings, settingsService } from "@/services/settings-service";
import type { SettingsReadModel } from "@/services/settings-service";
import type { SettingsSecretUpdates } from "@/lib/api/schemas/settings";
import { SETTINGS_QUERY_KEY } from "@/hooks/settings-query-key";
import { syncSubscriptionCollectionBoundary } from "@/hooks/subscription-query-cache";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";

export { normalizeSettings };

export function settingsQueryOptions() {
  return queryOptions({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: ({ signal }) => settingsService.get(signal),
    // settings 是用户级配置真相源；刷新只由保存、导入和认证切换显式触发，避免虚拟列表 item 挂载放大成网络风暴。
    staleTime: Infinity,
  });
}

export function useSettings() {
  return useQuery({ ...settingsQueryOptions(), select: (data) => data.settings });
}

export function useSettingsEnvelope() {
  return useQuery(settingsQueryOptions());
}

type SettingsMutationInput = Partial<AppSettings> | {
  patch: Partial<AppSettings>;
  secretUpdates: SettingsSecretUpdates;
};

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SettingsMutationInput) => {
      const current = queryClient.getQueryData<SettingsReadModel>(SETTINGS_QUERY_KEY) ?? {
        settings: DEFAULT_SETTINGS,
        secretStatus: EMPTY_SETTINGS_SECRET_STATUS,
      };
      const command = "patch" in input ? input : { patch: input, secretUpdates: {} };
      return await settingsService.update(current.settings, command.patch, command.secretUpdates);
    },
    onSuccess: (settings) => {
      const previousTimeZone = queryClient.getQueryData<SettingsReadModel>(SETTINGS_QUERY_KEY)?.settings.timezone;
      // 设置页保存后直接写缓存，避免等待 refetch 时 UI 回跳到旧值。
      queryClient.setQueryData(SETTINGS_QUERY_KEY, settings);
      if (previousTimeZone && previousTimeZone !== settings.settings.timezone) {
        // 时区会改变有效状态和 cursor 的 asOf；先提交新 boundary，再丢弃旧分页链，避免页面 effect 重复 reset。
        const nextBoundary = `${settings.settings.timezone}:${todayDateOnlyInTimeZone(new Date(), settings.settings.timezone)}`;
        void syncSubscriptionCollectionBoundary(queryClient, nextBoundary, { resetOnInitialize: true });
      }
    },
  });
}
