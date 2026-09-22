// 系统更新弹窗测试保护 Docker 页面内更新的 pending restart 状态流和 Cloudflare/source 禁用分支。
import rootPackageJson from "../../../../package.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError, apiFetch } from "@/lib/api-client";
import { systemRestartBrowser, SystemUpdateDialog, SystemVersionBadge } from "./system-update-dialog";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiFetch: mocks.apiFetch,
  };
});

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        "common.close": "关闭",
        "system.badgeUpdate": "可更新到 v{version}",
        "system.badgeVersion": "v{version}",
        "system.buildType": "构建类型",
        "system.checking": "正在检查版本...",
        "system.checkDeferredDescription": "当前显示的是本机版本；请稍后重新检查。",
        "system.checkDeferredTitle": "暂时无法检查更新",
        "system.checkFailedDescription": "请稍后重试，或打开 GitHub Release 手动查看。",
        "system.checkFailedTitle": "版本检查失败",
        "system.commitLink": "提交",
        "system.currentVersion": "当前版本",
        "system.latestVersion": "最新版本",
        "system.noUpdateTitle": "已是最新版本",
        "system.openUpdateDialog": "打开系统更新",
        "system.cloudflareDeployGuide": "Cloudflare 部署说明",
        "system.recheck": "重新检查",
        "system.releaseLink": "发布页",
        "system.restartNow": "立即重启",
        "system.restartRequired": "请重启服务以应用更新",
        "system.restarting": "正在重启...",
        "system.retry": "重试",
        "system.runtime": "运行面",
        "system.runtime.docker": "Docker",
        "system.runtime.cloudflare": "Cloudflare",
        "system.runtime.source": "源码/手动部署",
        "system.unsupportedDescription": "请使用原部署方式升级。",
        "system.unsupportedTitle": "当前部署不支持一键更新",
        "system.updateAvailableDescription": "可以更新到 v{version}。",
        "system.deployUpdateAvailableDescription": "可以更新到 v{version}。请通过部署流程升级。",
        "system.updateAvailableTitle": "发现新版本",
        "system.updateComplete": "更新完成",
        "system.updateFailedDescription": "更新失败，请稍后重试。",
        "system.updateFailedTitle": "更新失败",
        "system.updateNow": "立即更新",
        "system.updateTitle": "系统更新",
        "system.updateUnavailableTitle": "页面内更新不可用",
        "system.updating": "更新中...",
        "system.viewChangelog": "查看更新日志",
        "system.warningTitle": "检查提示",
        "rawErrorResponse.title": "错误响应详情",
        "rawErrorResponse.description": "接口返回的原始响应。",
        "rawErrorResponse.copy": "复制错误详情",
        "rawErrorResponse.copied": "已复制",
        "rawErrorResponse.copyFailed": "复制失败",
        "rawErrorResponse.open": "查看错误响应",
        "rawErrorResponse.responseUnavailable": "当前错误没有可回显的响应正文。",
      };
      let value = messages[key] ?? key;
      for (const [name, param] of Object.entries(params ?? {})) {
        value = value.split(`{${name}}`).join(String(param));
      }
      return value;
    },
  }),
}));

function versionFixture(overrides: Record<string, unknown> = {}) {
  return {
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    hasUpdate: true,
    checkSucceeded: true,
    deployment: "docker",
    updateMode: "in-app-binary",
    updateSupported: true,
    releaseInfo: {
      tagName: "v1.1.0",
      version: "1.1.0",
      name: "Renewlet 1.1.0",
      body: "更新日志",
      publishedAt: "2026-05-26T00:00:00Z",
      htmlUrl: "https://github.com/zhiyingzzhou/renewlet/releases/tag/v1.1.0",
      assets: [],
    },
    cached: false,
    build: {
      version: "1.0.0",
      commit: "abc",
      buildTime: "2026-05-26T00:00:00Z",
      buildType: "release",
    },
    ...overrides,
  };
}

function mockVersionEndpoint(overrides: Record<string, unknown> = {}) {
  mocks.apiFetch.mockImplementation((input: string) => {
    if (input.startsWith("/api/app/system/version")) return Promise.resolve(versionFixture(overrides));
    if (input === "/api/app/admin/system/update/status") return Promise.resolve({ operation: null });
    return Promise.reject(new Error(`Unexpected request ${input}`));
  });
}

function operationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "operation-1",
    status: "running",
    stage: "downloading",
    currentVersion: "1.0.0",
    targetVersion: "1.1.0",
    startedAt: "2026-08-14T01:00:00Z",
    updatedAt: "2026-08-14T01:00:01Z",
    finishedAt: null,
    needsRestart: false,
    error: null,
    ...overrides,
  };
}

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

function SystemUpdateHarness() {
  const [open, setOpen] = useState(false);
  return <SystemUpdateDialog open={open} onOpenChange={setOpen} canManageUpdates />;
}

describe("SystemUpdateDialog", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the version popover and refreshes with force=true", async () => {
    mockVersionEndpoint();

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    expect(await screen.findByText("可更新到 v1.1.0")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开系统更新" }));
    expect(await screen.findByText("当前版本")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新检查" }));

    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledWith(expect.stringContaining("force=true"), expect.anything(), expect.anything()));
  });

  it("shows the build version while the badge query is still pending", () => {
    mocks.apiFetch.mockImplementation((input: string) => {
      if (input.startsWith("/api/app/system/version")) return new Promise(() => {});
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    renderWithQuery(<SystemVersionBadge />);

    expect(screen.getByText(`v${rootPackageJson.version}`)).toBeInTheDocument();
    expect(screen.queryByText("v...")).not.toBeInTheDocument();
  });

  it("shows up-to-date state with a check mark and disables update action", async () => {
    mockVersionEndpoint({
      latestVersion: "1.0.0",
      hasUpdate: false,
      warning: undefined,
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));

    expect(await screen.findByText("已是最新版本")).toBeInTheDocument();
    expect(screen.getAllByText("已是最新版本")).toHaveLength(1);
    expect(screen.queryByText("无需操作。")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已是最新版本");
    expect(screen.queryByText("暂时无法检查更新")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();
  });

  it("shows checking state while the popover version query is pending", async () => {
    let resolveVersion: (value: ReturnType<typeof versionFixture>) => void = () => {};
    mocks.apiFetch.mockImplementation((input: string) => {
      if (input.startsWith("/api/app/system/version")) {
        return new Promise((resolve) => {
          resolveVersion = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(screen.getByRole("button", { name: "打开系统更新" }));

    expect(await screen.findByText("正在检查版本...")).toBeInTheDocument();

    resolveVersion(versionFixture());
  });

  it("updates release builds and then shows restart flow", async () => {
    let updateStarted = false;
    mocks.apiFetch.mockImplementation((input: string, _schema: unknown, init?: RequestInit) => {
      if (input.startsWith("/api/app/system/version")) return Promise.resolve(versionFixture());
      if (input === "/api/app/admin/system/update/status") {
        return Promise.resolve({
          operation: updateStarted ? operationFixture({
            status: "succeeded",
            stage: "restart-pending",
            updatedAt: "2026-08-14T01:00:02Z",
            finishedAt: "2026-08-14T01:00:02Z",
            needsRestart: true,
          }) : null,
        });
      }
      if (input === "/api/app/admin/system/update" && init?.method === "POST") {
        updateStarted = true;
        return Promise.resolve({ operation: operationFixture() });
      }
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));
    await user.click(await screen.findByRole("button", { name: "立即更新" }));

    expect(await screen.findByText("更新完成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即重启" })).toBeInTheDocument();
  });

  it("stops polling while closed and restores the running task when reopened", async () => {
    let updateStarted = false;
    mocks.apiFetch.mockImplementation((input: string, _schema: unknown, init?: RequestInit) => {
      if (input.startsWith("/api/app/system/version")) return Promise.resolve(versionFixture());
      if (input === "/api/app/admin/system/update/status") {
        return Promise.resolve({ operation: updateStarted ? operationFixture() : null });
      }
      if (input === "/api/app/admin/system/update" && init?.method === "POST") {
        updateStarted = true;
        return Promise.resolve({ operation: operationFixture() });
      }
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);
    const trigger = await screen.findByRole("button", { name: "打开系统更新" });
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "立即更新" }));
    expect(await screen.findByRole("button", { name: "更新中..." })).toBeDisabled();

    await user.click(trigger);
    await waitFor(() => expect(screen.queryByText("当前版本")).not.toBeInTheDocument());
    const callsAfterClose = mocks.apiFetch.mock.calls.filter(([input]) => input === "/api/app/admin/system/update/status").length;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(mocks.apiFetch.mock.calls.filter(([input]) => input === "/api/app/admin/system/update/status")).toHaveLength(callsAfterClose);

    await user.click(trigger);
    expect(await screen.findByRole("button", { name: "更新中..." })).toBeDisabled();
    await waitFor(() => {
      expect(mocks.apiFetch.mock.calls.filter(([input]) => input === "/api/app/admin/system/update/status").length).toBeGreaterThan(callsAfterClose);
    });
  });

  it("keeps a background task failure inline until details are explicitly opened", async () => {
    let started = false;
    let postCount = 0;
    const retryControl: { finish?: () => void } = {};
    mocks.apiFetch.mockImplementation((input: string, _schema: unknown, init?: RequestInit) => {
      if (input.startsWith("/api/app/system/version")) return Promise.resolve(versionFixture());
      if (input === "/api/app/admin/system/update/status") {
        return Promise.resolve({
          operation: started ? operationFixture({
            status: "failed",
            finishedAt: "2026-08-14T01:00:02Z",
            updatedAt: "2026-08-14T01:00:02Z",
            error: {
              code: "SYSTEM_UPDATE_FAILED",
              message: "下载失败",
              details: { rawResponseText: "upstream unavailable" },
            },
          }) : null,
        });
      }
      if (input === "/api/app/admin/system/update" && init?.method === "POST") {
        started = true;
        postCount += 1;
        if (postCount === 2) {
          return new Promise((resolve) => {
            retryControl.finish = () => resolve({ operation: operationFixture({ id: "operation-2" }) });
          });
        }
        return Promise.resolve({ operation: operationFixture({ id: `operation-${postCount}` }) });
      }
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);
    const trigger = await screen.findByRole("button", { name: "打开系统更新" });
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "立即更新" }));

    expect(await screen.findByText("下载失败")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "错误响应详情" })).not.toBeInTheDocument();

    await user.click(trigger);
    await waitFor(() => expect(screen.queryByText("当前版本")).not.toBeInTheDocument());
    await user.click(trigger);
    expect(await screen.findByText("下载失败")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "错误响应详情" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看错误响应" }));
    const detailsDialog = await screen.findByRole("dialog", { name: "错误响应详情" });
    expect(detailsDialog).toHaveTextContent("upstream unavailable");
    await user.click(within(detailsDialog).getByRole("button", { name: "关闭" }));
    await user.click(await screen.findByRole("button", { name: "重试" }));
    expect(postCount).toBe(2);
    expect(await screen.findByRole("button", { name: "更新中..." })).toBeDisabled();
    await act(async () => {
      retryControl.finish?.();
      await Promise.resolve();
    });
  });

  it("shows a persisted failure after a fresh render without opening or inventing details", async () => {
    mocks.apiFetch.mockImplementation((input: string) => {
      if (input.startsWith("/api/app/system/version")) return Promise.resolve(versionFixture());
      if (input === "/api/app/admin/system/update/status") {
        return Promise.resolve({
          operation: operationFixture({
            status: "failed",
            finishedAt: "2026-08-14T01:00:02Z",
            updatedAt: "2026-08-14T01:00:02Z",
            error: { code: "SYSTEM_UPDATE_TIMEOUT", message: "更新下载超时", details: undefined },
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);
    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));

    expect(await screen.findByText("更新下载超时")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看错误响应" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "错误响应详情" })).not.toBeInTheDocument();
  });

  it("shows release asset unavailable state without update actions", async () => {
    mockVersionEndpoint({
      hasUpdate: true,
      updateSupported: false,
      unsupportedReason: "目标 Release 暂缺页面内更新所需附件：renewlet_1.1.0_linux_amd64.tar.gz。",
      releaseInfo: {
        tagName: "v1.1.0",
        version: "1.1.0",
        name: "Renewlet 1.1.0",
        body: "",
        publishedAt: "2026-05-26T00:00:00Z",
        htmlUrl: "https://github.com/zhiyingzzhou/renewlet/releases/tag/v1.1.0",
        assets: [],
      },
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));

    expect(await screen.findByText("页面内更新不可用")).toBeInTheDocument();
    expect(screen.getByText("目标 Release 暂缺页面内更新所需附件：renewlet_1.1.0_linux_amd64.tar.gz。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "发布页" })).toHaveAttribute("href", "https://github.com/zhiyingzzhou/renewlet/releases/tag/v1.1.0");
    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();
  });

  it("shows unsupported source builds without update actions", async () => {
    mockVersionEndpoint({
      hasUpdate: false,
      deployment: "source",
      updateMode: "source-manual",
      updateSupported: false,
      unsupportedReason: "源码构建不支持",
      releaseInfo: null,
      build: {
        version: "1.0.0",
        commit: "abc",
        buildTime: "2026-05-26T00:00:00Z",
        buildType: "source",
      },
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));

    expect(await screen.findByText("页面内更新不可用")).toBeInTheDocument();
    expect(screen.getByText("源码构建不支持")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();
    expect(screen.queryByText("源码构建")).not.toBeInTheDocument();
  });

  it("shows Cloudflare available release without in-app update actions", async () => {
    mockVersionEndpoint({
      latestVersion: "1.1.0",
      hasUpdate: true,
      checkSucceeded: true,
      deployment: "cloudflare",
      updateMode: "cloudflare-deploy",
      updateSupported: false,
      unsupportedReason: "Cloudflare 需要通过部署流程升级",
      releaseInfo: {
        tagName: "v1.1.0",
        version: "1.1.0",
        name: "Renewlet 1.1.0",
        body: "",
        publishedAt: "2026-05-26T00:00:00Z",
        htmlUrl: "https://github.com/zhiyingzzhou/renewlet/releases/tag/v1.1.0",
        assets: [],
      },
      build: {
        version: "1.0.0",
        commit: "abc",
        buildTime: "2026-05-26T00:00:00Z",
        buildType: "cloudflare",
      },
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));

    expect(await screen.findByText("发现新版本")).toBeInTheDocument();
    expect(screen.getByText("可以更新到 v1.1.0。请通过部署流程升级。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cloudflare 部署说明" })).toHaveAttribute("href", expect.stringContaining("docs/cloudflare-workers-deploy.md"));
    expect(screen.getByRole("link", { name: "发布页" })).toHaveAttribute("href", "https://github.com/zhiyingzzhou/renewlet/releases/tag/v1.1.0");
    expect(screen.queryByText("页面内更新不可用")).not.toBeInTheDocument();
    expect(screen.queryByText("源码构建")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();
  });

  it("shows Cloudflare deploy button stable versions without a dev suffix", async () => {
    mockVersionEndpoint({
      currentVersion: "0.1.1",
      latestVersion: "0.1.1",
      hasUpdate: false,
      checkSucceeded: true,
      deployment: "cloudflare",
      updateMode: "cloudflare-deploy",
      updateSupported: false,
      unsupportedReason: "Cloudflare 需要通过部署流程升级",
      releaseInfo: {
        tagName: "v0.1.1",
        version: "0.1.1",
        name: "Renewlet 0.1.1",
        body: "",
        publishedAt: "2026-06-09T00:00:00Z",
        htmlUrl: "https://github.com/zhiyingzzhou/renewlet/releases/tag/v0.1.1",
        assets: [],
      },
      build: {
        version: "0.1.1",
        commit: "",
        buildTime: "",
        buildType: "cloudflare",
      },
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));

    expect(await screen.findByText("已是最新版本")).toBeInTheDocument();
    expect(screen.getAllByText("v0.1.1").length).toBeGreaterThan(0);
    expect(screen.queryByText("v0.1.1-dev")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "发布页" })).toHaveAttribute("href", "https://github.com/zhiyingzzhou/renewlet/releases/tag/v0.1.1");
    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();
  });

  it("shows Cloudflare dev deploys as up to date with commit link", async () => {
    mockVersionEndpoint({
      currentVersion: "0.1.0-dev+504c168",
      latestVersion: "0.1.0",
      hasUpdate: false,
      checkSucceeded: true,
      deployment: "cloudflare",
      updateMode: "cloudflare-deploy",
      updateSupported: false,
      unsupportedReason: "Cloudflare 需要通过部署流程升级",
      releaseInfo: null,
      build: {
        version: "0.1.0-dev+504c168",
        commit: "504c1681822ac60f0caafdb0b1ba731853c9169d",
        buildTime: "2026-06-04T17:46:43Z",
        buildType: "cloudflare",
      },
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));

    expect(await screen.findByText("已是最新版本")).toBeInTheDocument();
    expect(screen.queryByText("无需操作。")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "提交" })).toHaveAttribute("href", "https://github.com/zhiyingzzhou/renewlet/commit/504c1681822ac60f0caafdb0b1ba731853c9169d");
    expect(screen.queryByText("页面内更新不可用")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Cloudflare 部署说明" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "发布页" })).not.toBeInTheDocument();
    expect(screen.queryByText("暂时无法检查更新")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();
  });

  it("keeps Cloudflare commit link when release checks are deferred", async () => {
    mockVersionEndpoint({
      currentVersion: "0.1.0-dev+504c168",
      latestVersion: "0.1.0-dev+504c168",
      hasUpdate: false,
      checkSucceeded: false,
      deployment: "cloudflare",
      updateMode: "cloudflare-deploy",
      updateSupported: false,
      warning: "GitHub Release 暂时不可用",
      releaseInfo: null,
      build: {
        version: "0.1.0-dev+504c168",
        commit: "504c1681822ac60f0caafdb0b1ba731853c9169d",
        buildTime: "2026-06-04T17:46:43Z",
        buildType: "cloudflare",
      },
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));

    expect(await screen.findByText("GitHub Release 暂时不可用")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "提交" })).toHaveAttribute("href", "https://github.com/zhiyingzzhou/renewlet/commit/504c1681822ac60f0caafdb0b1ba731853c9169d");
    expect(screen.queryByText("已是最新版本")).not.toBeInTheDocument();
    expect(screen.queryByText("页面内更新不可用")).not.toBeInTheDocument();
  });

  it("shows update error and retry button", async () => {
    mocks.apiFetch.mockImplementation((input: string, _schema: unknown, init?: RequestInit) => {
      if (input.startsWith("/api/app/system/version")) return Promise.resolve(versionFixture());
      if (input === "/api/app/admin/system/update/status") return Promise.resolve({ operation: null });
      if (input === "/api/app/admin/system/update" && init?.method === "POST") {
        return Promise.reject(new ApiError(
          "更新失败",
          400,
          undefined,
          "SYSTEM_UPDATE_FAILED",
          "outer API response",
        ));
      }
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));
    await user.click(await screen.findByRole("button", { name: "立即更新" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("更新失败");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看错误响应" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "错误响应详情" })).not.toBeInTheDocument();
  });

  it("keeps POST upstream details closed until the user opens them", async () => {
    mocks.apiFetch.mockImplementation((input: string, _schema: unknown, init?: RequestInit) => {
      if (input.startsWith("/api/app/system/version")) return Promise.resolve(versionFixture());
      if (input === "/api/app/admin/system/update/status") return Promise.resolve({ operation: null });
      if (input === "/api/app/admin/system/update" && init?.method === "POST") {
        return Promise.reject(new ApiError(
          "GitHub 下载失败",
          502,
          { rawResponseText: "upstream unavailable" },
          "SYSTEM_UPDATE_FAILED",
          "outer API response",
        ));
      }
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));
    await user.click(await screen.findByRole("button", { name: "立即更新" }));

    expect(await screen.findByText("GitHub 下载失败")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "错误响应详情" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看错误响应" }));
    const detailsDialog = await screen.findByRole("dialog", { name: "错误响应详情" });
    expect(detailsDialog).toHaveTextContent("upstream unavailable");
    expect(detailsDialog).not.toHaveTextContent("outer API response");
  });

  it("offers POST network diagnostics without opening them automatically", async () => {
    mocks.apiFetch.mockImplementation((input: string, _schema: unknown, init?: RequestInit) => {
      if (input.startsWith("/api/app/system/version")) return Promise.resolve(versionFixture());
      if (input === "/api/app/admin/system/update/status") return Promise.resolve({ operation: null });
      if (input === "/api/app/admin/system/update" && init?.method === "POST") {
        return Promise.reject(new ApiError("无法连接到 Renewlet 服务", 0, undefined, "network"));
      }
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));
    await user.click(await screen.findByRole("button", { name: "立即更新" }));

    expect(await screen.findByText("无法连接到 Renewlet 服务")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "错误响应详情" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看错误响应" }));
    expect(await screen.findByRole("dialog", { name: "错误响应详情" })).toHaveTextContent("无法连接到 Renewlet 服务");
  });

  it("keeps a retry POST failure separate from the stale operation error", async () => {
    mocks.apiFetch.mockImplementation((input: string, _schema: unknown, init?: RequestInit) => {
      if (input.startsWith("/api/app/system/version")) return Promise.resolve(versionFixture());
      if (input === "/api/app/admin/system/update/status") {
        return Promise.resolve({
          operation: operationFixture({
            status: "failed",
            error: {
              code: "SYSTEM_UPDATE_FAILED",
              message: "上一次下载失败",
              details: { rawResponseText: "old upstream response" },
            },
          }),
        });
      }
      if (input === "/api/app/admin/system/update" && init?.method === "POST") {
        return Promise.reject(new ApiError("本次重试无法连接服务", 0, undefined, "network"));
      }
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));
    expect(await screen.findByText("上一次下载失败")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("本次重试无法连接服务")).toBeInTheDocument();
    expect(screen.queryByText("上一次下载失败")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看错误响应" }));
    const detailsDialog = await screen.findByRole("dialog", { name: "错误响应详情" });
    expect(detailsDialog).toHaveTextContent("本次重试无法连接服务");
    expect(detailsDialog).not.toHaveTextContent("old upstream response");
  });

  it("restarts and reloads after health check recovers", async () => {
    const reload = vi.fn();
    vi.spyOn(systemRestartBrowser, "reload").mockImplementation(reload);
    const fetchMock = vi.spyOn(window, "fetch").mockResolvedValue({ ok: true } as Response);
    let updateStarted = false;
    mocks.apiFetch.mockImplementation((input: string, _schema: unknown, init?: RequestInit) => {
      if (input.startsWith("/api/app/system/version")) return Promise.resolve(versionFixture());
      if (input === "/api/app/admin/system/update/status") {
        return Promise.resolve({
          operation: updateStarted ? operationFixture({
            status: "succeeded",
            stage: "restart-pending",
            updatedAt: "2026-08-14T01:00:02Z",
            finishedAt: "2026-08-14T01:00:02Z",
            needsRestart: true,
          }) : null,
        });
      }
      if (input === "/api/app/admin/system/update" && init?.method === "POST") {
        updateStarted = true;
        return Promise.resolve({ operation: operationFixture() });
      }
      if (input === "/api/app/admin/system/restart" && init?.method === "POST") return Promise.resolve({});
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));
    await user.click(await screen.findByRole("button", { name: "立即更新" }));
    const restartButton = await screen.findByRole("button", { name: "立即重启" });

    vi.useFakeTimers();
    fireEvent.click(restartButton);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: /正在重启/ })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/app/health", { cache: "no-cache" });
    expect(reload).toHaveBeenCalled();
  });

  it("shows a deferred check state without claiming the deployment is current", async () => {
    mockVersionEndpoint({
      latestVersion: "1.0.0",
      hasUpdate: false,
      checkSucceeded: false,
      releaseInfo: null,
      warning: "暂时无法获取 GitHub Release，请稍后重试。",
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));

    await screen.findByText("暂时无法获取 GitHub Release，请稍后重试。");
    expect(screen.getAllByText("暂时无法检查更新")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("暂时无法检查更新");
    expect(screen.getByText("暂时无法获取 GitHub Release，请稍后重试。")).toBeInTheDocument();
    expect(screen.queryByText("已是最新版本")).not.toBeInTheDocument();
  });

  it("shows check failed state when the version response is invalid", async () => {
    mocks.apiFetch.mockImplementation((input: string) => {
      if (input.startsWith("/api/app/system/version")) return Promise.reject(new Error("invalid_response"));
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });

    const user = userEvent.setup();
    renderWithQuery(<SystemUpdateHarness />);

    await user.click(await screen.findByRole("button", { name: "打开系统更新" }));

    expect(await screen.findByText("版本检查失败")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("版本检查失败");
  });
});

describe("SystemVersionBadge", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
  });

  it("shows available update version", async () => {
    mocks.apiFetch.mockResolvedValueOnce(versionFixture());

    renderWithQuery(<SystemVersionBadge />);

    expect(await screen.findByText("可更新到 v1.1.0")).toBeInTheDocument();
  });
});
