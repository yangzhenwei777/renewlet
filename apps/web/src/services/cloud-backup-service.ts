import { apiFetch, apiFetchBlob } from "@/lib/api-client";
import {
  cloudBackupConfigResponseSchema,
  cloudBackupCreateSnapshotResponseSchema,
  cloudBackupDeleteSnapshotResponseSchema,
  cloudBackupSnapshotsResponseSchema,
  cloudBackupTestResponseSchema,
  type CloudBackupConfig,
  type CloudBackupConfigUpdate,
  type CloudBackupCreateSnapshotRequest,
  type CloudBackupProvider,
  type CloudBackupSnapshot,
  type CloudBackupTestResponse,
} from "@/lib/api/schemas/cloud-backup";

/** 云备份服务层：所有响应都经过 shared schema，UI 不直接判断 Docker/Cloudflare 运行面。 */
export const cloudBackupService = {
  async getConfig(signal?: AbortSignal): Promise<CloudBackupConfig> {
    const data = await apiFetch(
      "/api/app/cloud-backup/config",
      cloudBackupConfigResponseSchema,
      signal ? { signal } : undefined,
    );
    return data.config;
  },

  async updateConfig(payload: CloudBackupConfigUpdate): Promise<CloudBackupConfig> {
    const data = await apiFetch("/api/app/cloud-backup/config", cloudBackupConfigResponseSchema, {
      method: "PUT",
      body: JSON.stringify(payload),
      timeoutMs: 60_000,
    });
    return data.config;
  },

  async test(payload: CloudBackupConfigUpdate): Promise<CloudBackupTestResponse> {
    return await apiFetch("/api/app/cloud-backup/test", cloudBackupTestResponseSchema, {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 60_000,
    });
  },

  async listSnapshots(provider: CloudBackupProvider, signal?: AbortSignal): Promise<CloudBackupSnapshot[]> {
    // 列表接口是 provider-scoped；前端不能再用“拉全部再过滤”遮住另一个目标的上游错误。
    const query = new URLSearchParams({ provider });
    const data = await apiFetch(`/api/app/cloud-backups?${query.toString()}`, cloudBackupSnapshotsResponseSchema, {
      timeoutMs: 60_000,
      ...(signal ? { signal } : {}),
    });
    return data.snapshots;
  },

  async createSnapshot(payload: CloudBackupCreateSnapshotRequest): Promise<CloudBackupSnapshot[]> {
    const data = await apiFetch("/api/app/cloud-backups", cloudBackupCreateSnapshotResponseSchema, {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 120_000,
    });
    return data.snapshots;
  },

  async downloadSnapshot(snapshot: CloudBackupSnapshot): Promise<Blob> {
    // 下载/删除都用 snapshot.provider 精确定位；缺 provider 的自动查找只保留给 curl 兼容路径。
    const query = new URLSearchParams({ provider: snapshot.provider });
    return await apiFetchBlob(`/api/app/cloud-backups/${encodeURIComponent(snapshot.id)}/download?${query.toString()}`, {
      timeoutMs: 120_000,
    });
  },

  async deleteSnapshot(snapshot: CloudBackupSnapshot): Promise<void> {
    const query = new URLSearchParams({ provider: snapshot.provider });
    await apiFetch(`/api/app/cloud-backups/${encodeURIComponent(snapshot.id)}?${query.toString()}`, cloudBackupDeleteSnapshotResponseSchema, {
      method: "DELETE",
      timeoutMs: 60_000,
    });
  },
};
