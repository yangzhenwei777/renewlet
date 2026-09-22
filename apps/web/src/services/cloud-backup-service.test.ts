import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudBackupService } from "./cloud-backup-service";

// 服务层测试保护 provider 必须进入 HTTP query；只改 React Query key 不能隔离远端列表错误。
describe("cloudBackupService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists snapshots with the selected provider in the request", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(input instanceof Request ? input.url : input.toString());
      return new Response(JSON.stringify({ ok: true, data: { snapshots: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await expect(cloudBackupService.listSnapshots("webdav")).resolves.toEqual([]);
    await expect(cloudBackupService.listSnapshots("s3")).resolves.toEqual([]);

    expect(requestedUrls).toEqual([
      "/api/app/cloud-backups?provider=webdav",
      "/api/app/cloud-backups?provider=s3",
    ]);
  });
});
