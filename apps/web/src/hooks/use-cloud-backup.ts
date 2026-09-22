import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cloudBackupService } from "@/services/cloud-backup-service";
import type { Locale } from "@/i18n/locales";
import type { CloudBackupConfigUpdate, CloudBackupCreateSnapshotRequest, CloudBackupProvider } from "@/lib/api/schemas/cloud-backup";

export const CLOUD_BACKUP_CONFIG_QUERY_KEY = ["cloud-backup", "config"] as const;
export const CLOUD_BACKUP_SNAPSHOTS_QUERY_KEY = ["cloud-backup", "snapshots"] as const;
export const CLOUD_BACKUP_SNAPSHOTS_STALE_TIME_MS = 60_000;

export function useCloudBackupConfig() {
  return useQuery({
    queryKey: CLOUD_BACKUP_CONFIG_QUERY_KEY,
    queryFn: ({ signal }) => cloudBackupService.getConfig(signal),
  });
}

export function useCloudBackupSnapshots({
  enabled = true,
  provider,
  configUpdatedAt = null,
  locale,
}: {
  enabled?: boolean;
  provider: CloudBackupProvider;
  configUpdatedAt?: string | null;
  locale: Locale;
}) {
  return useQuery({
    // provider/locale 同时进入 queryKey：列表错误 message 按请求时 API locale 生成，保存语言后不能复用旧语言错误对象。
    queryKey: [...CLOUD_BACKUP_SNAPSHOTS_QUERY_KEY, provider, configUpdatedAt ?? "initial", locale] as const,
    queryFn: ({ signal }) => cloudBackupService.listSnapshots(provider, signal),
    enabled,
    // 远端 list 会打 WebDAV/S3 上游；刷新已有显式按钮，避免 StrictMode/remount/focus 把同一 provider 列表重复拉取。
    staleTime: CLOUD_BACKUP_SNAPSHOTS_STALE_TIME_MS,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateCloudBackupConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CloudBackupConfigUpdate) => cloudBackupService.updateConfig(payload),
    onSuccess: (config) => {
      queryClient.setQueryData(CLOUD_BACKUP_CONFIG_QUERY_KEY, config);
    },
  });
}

export function useTestCloudBackup() {
  return useMutation({
    mutationFn: (payload: CloudBackupConfigUpdate) => cloudBackupService.test(payload),
  });
}

export function useCreateCloudBackupSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CloudBackupCreateSnapshotRequest) => cloudBackupService.createSnapshot(payload),
    onSuccess: async () => {
      // 立即备份只写当前 provider，但状态和列表都可能变化，统一失效避免 UI 留住旧 lastStatus。
      await queryClient.invalidateQueries({ queryKey: CLOUD_BACKUP_CONFIG_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: CLOUD_BACKUP_SNAPSHOTS_QUERY_KEY });
    },
  });
}

export function useDownloadCloudBackupSnapshot() {
  return useMutation({
    mutationFn: (snapshot: Parameters<typeof cloudBackupService.downloadSnapshot>[0]) => cloudBackupService.downloadSnapshot(snapshot),
  });
}

export function useDeleteCloudBackupSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (snapshot: Parameters<typeof cloudBackupService.deleteSnapshot>[0]) => cloudBackupService.deleteSnapshot(snapshot),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CLOUD_BACKUP_SNAPSHOTS_QUERY_KEY });
    },
  });
}
