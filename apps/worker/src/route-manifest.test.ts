import { writeFileSync } from "node:fs";
import { subscriptionCollectionContractFixture } from "@renewlet/shared/contract-fixtures";
import { describe, expect, it, vi } from "vitest";

// 路由导出只验证 Hono 注册结果；隔离通知实现可防止 Node 测试进程加载 cloudflare:sockets，且不改变真实注册路径。
vi.mock("./notifications", () => ({
  notificationHistory: vi.fn(),
  notificationOverview: vi.fn(),
  notificationRun: vi.fn(),
  notificationTest: vi.fn(),
  runScheduledNotifications: vi.fn(),
}));

import { workerProductRouteManifest } from "./index";

describe("Worker product route manifest", () => {
  it("exports the registered Hono product routes", () => {
    const manifest = workerProductRouteManifest();
    expect(manifest).toEqual(expect.arrayContaining([
      { path: "/api/app/notifications/history", methods: ["GET"] },
      { path: "/api/app/notifications/overview", methods: ["GET"] },
      { path: "/api/app/subscriptions/calendar-feeds", methods: ["GET"] },
      ...subscriptionCollectionContractFixture.manifestRoutes,
    ]));
    expect(manifest).not.toContainEqual({ path: "/api/app/calendar-feeds", methods: ["GET"] });

    const outputPath = process.env["RENEWLET_WORKER_ROUTE_MANIFEST_OUTPUT"];
    if (outputPath) {
      writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    }
  });
});
