/**
 * Custom Config 数据 Provider 的 application hook。
 *
 * 架构位置：
 * - Context 只负责把这里的能力挂到 React 树。
 * - 这里统一处理远端 API、localStorage 启动快照和显式保存。
 * - 规范化规则来自 domain，避免把脏数据处理散落在 UI 组件中。
 *
 * 数据优先级：
 * ```
 * 首屏默认值 -> localStorage 启动快照 -> 已登录远端配置覆盖 -> Settings 草稿显式保存
 * ```
 *
 * 注意： PocketBase JSON 字段和 localStorage 都不是可信输入；进入状态前必须经过 domain normalize。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import { normalizeCustomConfig } from "../domain/normalize-custom-config";
import { customConfigService } from "@/services/custom-config-service";
import { reportClientError } from "@/lib/report-client-error";

const LOCAL_STORAGE_KEY = "renewlet_custom_config";
const CUSTOM_CONFIG_QUERY_KEY = ["custom-config"] as const;

/**
 * 管理自定义配置的数据来源、缓存和远端显式保存。
 *
 * Provider 只挂在已认证私有壳；localStorage 仅缩短远端配置返回前的空窗，远端响应仍是会话内事实源。
 * 保存前必须取消旧读取并按版本提交结果，避免晚返回的请求覆盖用户刚确认的设置。
 */
export function useCustomConfigController() {
  const [localSnapshot] = useState(readLocalCustomConfig);
  const [config, setConfig] = useState<CustomConfig>(localSnapshot.config);
  const queryClient = useQueryClient();
  const saveVersionRef = useRef(0);

  const { data: remoteConfig } = useQuery<CustomConfig | null>({
    queryKey: CUSTOM_CONFIG_QUERY_KEY,
    queryFn: ({ signal }) => customConfigService.get(signal),
    retry: false,
  });

  const { mutateAsync: saveRemoteConfig } = useMutation({
    mutationFn: (nextConfig: CustomConfig) => customConfigService.save(nextConfig),
  });

  useEffect(() => {
    if (localSnapshot.error) {
      reportClientError(localSnapshot.error, { source: "custom-config.load-local" });
    }
  }, [localSnapshot.error]);

  const rememberSavedConfig = useCallback((savedConfig: CustomConfig) => {
    queryClient.setQueryData(CUSTOM_CONFIG_QUERY_KEY, savedConfig);
  }, [queryClient]);

  useEffect(() => {
    if (!remoteConfig) return;
    setConfig(remoteConfig);
  }, [remoteConfig]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      reportClientError(e, { source: "custom-config.save-local" });
    }
  }, [config]);

  const saveConfig = useCallback(
    async (nextConfig: CustomConfig) => {
      const normalized = normalizeCustomConfig(nextConfig);
      const saveVersion = saveVersionRef.current + 1;
      saveVersionRef.current = saveVersion;
      // 保存前停止旧读取，避免晚返回的 custom-config GET 覆盖刚保存的货币管理顺序。
      await queryClient.cancelQueries({ queryKey: CUSTOM_CONFIG_QUERY_KEY });
      const savedConfig = await saveRemoteConfig(normalized);
      if (saveVersionRef.current === saveVersion) {
        setConfig(savedConfig);
        rememberSavedConfig(savedConfig);
      }
      return savedConfig;
    },
    [queryClient, rememberSavedConfig, saveRemoteConfig],
  );

  return {
    config,
    saveConfig,
  };
}

function readLocalCustomConfig(): { config: CustomConfig; error: unknown | null } {
  try {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    // localStorage 只是远端读取前的启动快照；手动修改或部分写入的数据必须先过同一套 domain normalize。
    return {
      config: saved ? normalizeCustomConfig(JSON.parse(saved)) : DEFAULT_CUSTOM_CONFIG,
      error: null,
    };
  } catch (error) {
    return { config: DEFAULT_CUSTOM_CONFIG, error };
  }
}
