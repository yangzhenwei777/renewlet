// 内置图标索引状态测试单独成文件，避免设置页主装配测试被 provider fixture 撑过行数守卫。
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BuiltInIconProvider } from "@renewlet/shared/built-in-icons";
import type {
  BuiltInIconIndexProviderStatus,
  BuiltInIconIndexStatus,
  BuiltInIconProviderVersion,
  BuiltInIconRefreshJob,
  BuiltInIconRefreshJobStatus,
} from "@/lib/api/schemas/media";
import {
  createControllerState,
  createSettingsReadState,
  mocks,
  renderSettingsScreen,
} from "./settings-screen.test-utils";

function providerVersion(label: string): BuiltInIconProviderVersion {
  const commitSha = `${label}1234567890abcdef1234567890abcdef`;
  return {
    sourceRef: commitSha,
    displayVersion: label,
    commitSha,
    commitShortSha: label,
    commitDate: "2026-06-11T00:00:00.000Z",
    releaseTag: null,
    releasePublishedAt: null,
  };
}

function refreshJob(status: BuiltInIconRefreshJobStatus): BuiltInIconRefreshJob {
  return {
    id: `job_${status}`,
    provider: "thesvg",
    status,
    queuedAt: "2026-06-11T00:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-06-11T00:00:01.000Z",
    finishedAt: status === "queued" || status === "running" ? null : "2026-06-11T00:00:02.000Z",
    attempts: status === "queued" ? 0 : 5,
    error: status === "failed" ? "checksum mismatch" : null,
    indexHash: status === "succeeded" ? "a".repeat(64) : null,
  };
}

function providerStatus(
  provider: BuiltInIconProvider,
  overrides: Partial<BuiltInIconIndexProviderStatus> = {},
): BuiltInIconIndexProviderStatus {
  return {
    provider,
    current: null,
    latest: null,
    iconCount: provider === "thesvg" ? 120 : provider === "selfhst" ? 100 : 101,
    checkedAt: null,
    refreshedAt: null,
    lastError: null,
    refreshing: false,
    updateAvailable: false,
    ...overrides,
  };
}

function statusWithTheSvg(provider: BuiltInIconIndexProviderStatus): BuiltInIconIndexStatus {
  return {
    source: "runtime",
    hash: "runtime-hash",
    iconCount: 321,
    providerCounts: { thesvg: 120, selfhst: 100, dashboardIcons: 101 },
    checkedAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    refreshing: false,
    providers: [
      provider,
      providerStatus("selfhst"),
      providerStatus("dashboardIcons"),
    ],
  };
}

function failedJobProviderStatus(overrides: Partial<BuiltInIconIndexProviderStatus> = {}) {
  return providerStatus("thesvg", {
    checkedAt: "2026-06-11T00:00:00.000Z",
    job: refreshJob("failed"),
    ...overrides,
  });
}

function setElementSize(element: Element, data: { scrollWidth: number; clientWidth: number; scrollHeight?: number; clientHeight?: number }) {
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, value: data.scrollWidth },
    clientWidth: { configurable: true, value: data.clientWidth },
    scrollHeight: { configurable: true, value: data.scrollHeight ?? 20 },
    clientHeight: { configurable: true, value: data.clientHeight ?? 20 },
  });
}

describe("SettingsScreen built-in icon index controls", () => {
  it("does not report an unavailable icon index when the first status read fails", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const controller = createControllerState();
    controller.builtInIconIndex.status = createSettingsReadState<BuiltInIconIndexStatus>(undefined, {
      error: new Error("icon index unavailable"),
      retry,
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));
    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });
    await user.click(within(dialog).getByRole("button", { name: "查看 TheSVG 图标索引状态：检查失败" }));

    expect(within(screen.getByRole("alert")).getByText("加载失败")).toBeInTheDocument();
    expect(screen.queryByText("暂时无法读取索引状态。")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("lets admins inspect and refresh an icon provider from a compact status badge", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      builtInIconIndex: {
        status: statusWithTheSvg(providerStatus("thesvg", {
          current: providerVersion("oldsha1"),
          latest: providerVersion("newsha1"),
          checkedAt: "2026-06-11T00:00:00.000Z",
          refreshedAt: "2026-06-10T00:00:00.000Z",
          updateAvailable: true,
        })),
      },
    });
    const checkAllProviders = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const check = vi.fn<(provider: BuiltInIconProvider) => Promise<void>>().mockResolvedValue(undefined);
    const refresh = vi.fn<(provider: BuiltInIconProvider) => Promise<void>>().mockResolvedValue(undefined);
    controller.builtInIconIndex.checkAllProviders = checkAllProviders;
    controller.builtInIconIndex.checkProvider = check;
    controller.builtInIconIndex.refreshProvider = refresh;
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));

    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });
    expect(dialog).toHaveClass("gap-0");
    expect(within(dialog).queryByText("120 个图标")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/当前：/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/最新：/)).not.toBeInTheDocument();
    const statusBadge = within(dialog).getByRole("button", { name: "查看 TheSVG 图标索引状态：有更新" });
    expect(statusBadge).toHaveTextContent("有更新");
    expect(checkAllProviders).toHaveBeenCalledTimes(1);

    const updateSettingCallsBeforeRefresh = controller.updateSetting.mock.calls.length;
    await user.click(statusBadge);

    expect(check).not.toHaveBeenCalled();
    expect(await screen.findByText("图标数量")).toBeInTheDocument();
    expect(screen.getByText("图标数量").closest("[data-mobile-overlay-portal]")).toBeNull();
    expect(screen.getByText("图标数量").closest("[data-vaul-drawer]")).toBeNull();
    expect(screen.getByText("120 个图标")).toBeInTheDocument();
    expect(screen.getByText("当前版本")).toBeInTheDocument();
    expect(screen.getByText("最新版本")).toBeInTheDocument();
    expect(screen.getByText(/oldsha1/)).toBeInTheDocument();
    expect(screen.queryByText("手动更新")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "检查 TheSVG 最新版本" }));
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("thesvg");

    await user.click(screen.getByRole("button", { name: "更新" }));

    expect(refresh).toHaveBeenCalledWith("thesvg");
    expect(controller.updateSetting).toHaveBeenCalledTimes(updateSettingCallsBeforeRefresh);
    expect(screen.queryByText("有未保存更改")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存更改" })).not.toBeInTheDocument();
  });

  it("shows full provider version values in a tooltip when truncated", async () => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      builtInIconIndex: {
        status: statusWithTheSvg(providerStatus("thesvg", {
          current: providerVersion("oldsha1"),
          latest: providerVersion("newsha1"),
          checkedAt: "2026-06-11T00:00:00.000Z",
          refreshedAt: "2026-06-10T00:00:00.000Z",
          updateAvailable: true,
        })),
      },
    }));

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));

    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });
    await user.click(within(dialog).getByRole("button", { name: "查看 TheSVG 图标索引状态：有更新" }));

    const currentVersionValue = await screen.findByText(/oldsha1/);
    const currentVersionText = currentVersionValue.textContent ?? "";
    expect(currentVersionText).toContain(" · oldsha1");
    expect(currentVersionValue).toHaveAttribute("data-slot", "truncated-tooltip-text");
    expect(currentVersionValue).toHaveClass("truncate", "max-w-full", "text-right");
    expect(currentVersionValue.closest("dd")).toHaveClass("max-w-40", "text-right", "font-medium");

    setElementSize(currentVersionValue, { scrollWidth: 320, clientWidth: 120 });
    await user.hover(currentVersionValue);

    expect(await screen.findByRole("tooltip")).toHaveTextContent(currentVersionText);
  });

  it("checks all providers when admins open the sources dialog", async () => {
    const user = userEvent.setup();
    const checkAllProviders = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const check = vi.fn<(provider: BuiltInIconProvider) => Promise<void>>().mockResolvedValue(undefined);
    const controller = createControllerState({
      builtInIconIndex: {
        checkAllProviders,
        checkProvider: check,
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));

    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });
    expect(checkAllProviders).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: "查看 Dashboard Icons 图标索引状态：未检查" }));

    expect(checkAllProviders).toHaveBeenCalledTimes(1);
    expect(check).not.toHaveBeenCalled();
    expect(controller.updateSetting).not.toHaveBeenCalled();
  });

  it("hides the icon index refresh panel from non-admin controllers", async () => {
    const user = userEvent.setup();
    const checkAllProviders = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      builtInIconIndex: {
        canManage: false,
        checkAllProviders,
      },
    }));

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));

    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });
    expect(within(dialog).queryByRole("button", { name: /图标索引状态/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "更新" })).not.toBeInTheDocument();
    expect(checkAllProviders).not.toHaveBeenCalled();
  });

  it("shows checking before stale up-to-date status while the dialog-level check is running", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      builtInIconIndex: {
        checkingProviders: ["thesvg"],
        status: {
          source: "runtime",
          hash: "runtime-hash",
          iconCount: 1,
          providerCounts: { thesvg: 1, selfhst: 0, dashboardIcons: 0 },
          checkedAt: "2026-06-11T00:00:00.000Z",
          updatedAt: "2026-06-11T00:00:00.000Z",
          refreshing: false,
          providers: [
            {
              provider: "thesvg",
              current: {
                sourceRef: "sha1234567890abcdef",
                displayVersion: "sha1234",
                commitSha: "sha1234567890abcdef",
                commitShortSha: "sha1234",
                commitDate: "2026-06-10T00:00:00.000Z",
                releaseTag: null,
                releasePublishedAt: null,
              },
              latest: {
                sourceRef: "sha1234567890abcdef",
                displayVersion: "sha1234",
                commitSha: "sha1234567890abcdef",
                commitShortSha: "sha1234",
                commitDate: "2026-06-10T00:00:00.000Z",
                releaseTag: null,
                releasePublishedAt: null,
              },
              iconCount: 1,
              checkedAt: "2026-06-11T00:00:00.000Z",
              refreshedAt: "2026-06-11T00:00:00.000Z",
              lastError: null,
              refreshing: false,
              updateAvailable: false,
            },
            {
              provider: "selfhst",
              current: null,
              latest: null,
              iconCount: 0,
              checkedAt: null,
              refreshedAt: null,
              lastError: null,
              refreshing: false,
              updateAvailable: false,
            },
            {
              provider: "dashboardIcons",
              current: null,
              latest: null,
              iconCount: 0,
              checkedAt: null,
              refreshedAt: null,
              lastError: null,
              refreshing: false,
              updateAvailable: false,
            },
          ],
        },
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));

    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });
    const statusBadge = within(dialog).getByRole("button", { name: "查看 TheSVG 图标索引状态：检查中" });
    expect(statusBadge).toHaveTextContent("检查中");
    expect(within(dialog).queryByRole("button", { name: "查看 TheSVG 图标索引状态：已最新" })).not.toBeInTheDocument();
  });

  it("shows unknown instead of source labels when current provider version has no commit metadata", async () => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      builtInIconIndex: {
        status: {
          source: "runtime",
          hash: "runtime-hash",
          iconCount: 1,
          providerCounts: { thesvg: 1, selfhst: 0, dashboardIcons: 0 },
          checkedAt: null,
          updatedAt: null,
          refreshing: false,
          providers: [
            {
              provider: "thesvg",
              current: {
                sourceRef: "runtime",
                displayVersion: "runtime",
                commitSha: null,
                commitShortSha: null,
                commitDate: null,
                releaseTag: null,
                releasePublishedAt: null,
              },
              latest: null,
              iconCount: 1,
              checkedAt: null,
              refreshedAt: null,
              lastError: null,
              refreshing: false,
              updateAvailable: false,
            },
            {
              provider: "selfhst",
              current: null,
              latest: null,
              iconCount: 0,
              checkedAt: null,
              refreshedAt: null,
              lastError: null,
              refreshing: false,
              updateAvailable: false,
            },
            {
              provider: "dashboardIcons",
              current: null,
              latest: null,
              iconCount: 0,
              checkedAt: null,
              refreshedAt: null,
              lastError: null,
              refreshing: false,
              updateAvailable: false,
            },
          ],
        },
      },
    }));

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));
    await user.click(await screen.findByRole("button", { name: "查看 TheSVG 图标索引状态：未检查" }));

    expect(screen.getByText("当前版本")).toBeInTheDocument();
    expect(screen.getAllByText("未知版本").length).toBeGreaterThan(0);
    expect(screen.queryByText("手动更新")).not.toBeInTheDocument();
  });

  it("disables provider index actions while refreshing", async () => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      builtInIconIndex: {
        status: statusWithTheSvg(providerStatus("thesvg", {
          refreshing: true,
          job: refreshJob("queued"),
        })),
      },
    }));

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));

    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });
    const statusBadge = within(dialog).getByRole("button", { name: "查看 TheSVG 图标索引状态：更新中" });
    expect(statusBadge).toHaveTextContent("更新中");

    await user.click(statusBadge);

    expect(await screen.findByText("后台任务")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查 TheSVG 最新版本" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "更新中..." })).toBeDisabled();
  });

  it.each([
    {
      name: "update available",
      badge: "有更新",
      provider: failedJobProviderStatus({
        current: providerVersion("oldsha1"),
        latest: providerVersion("newsha1"),
        refreshedAt: "2026-06-10T00:00:00.000Z",
        updateAvailable: true,
      }),
    },
    {
      name: "up to date",
      badge: "已最新",
      provider: failedJobProviderStatus({
        current: providerVersion("samesha"),
        latest: providerVersion("samesha"),
        refreshedAt: "2026-06-11T00:00:00.000Z",
      }),
    },
  ])("hides failed background refresh jobs when the compact badge is $name", async ({ badge, provider }) => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      builtInIconIndex: {
        status: statusWithTheSvg(provider),
      },
    }));

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));

    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });
    const statusBadge = within(dialog).getByRole("button", { name: `查看 TheSVG 图标索引状态：${badge}` });
    expect(statusBadge).toHaveTextContent(badge);
    expect(within(dialog).queryByRole("button", { name: "查看 TheSVG 图标索引状态：更新失败" })).not.toBeInTheDocument();

    await user.click(statusBadge);

    expect(await screen.findByText("图标数量")).toBeInTheDocument();
    expect(screen.queryByText("后台任务")).not.toBeInTheDocument();
    expect(screen.queryByText(/上次更新失败/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    {
      name: "without a latest version",
      badge: "检查失败",
      provider: providerStatus("thesvg", {
        checkedAt: "2026-06-11T00:00:00.000Z",
        lastError: "Registry offline",
      }),
    },
    {
      name: "with an available update",
      badge: "有更新",
      provider: providerStatus("thesvg", {
        current: providerVersion("oldsha1"),
        latest: providerVersion("newsha1"),
        checkedAt: "2026-06-11T00:00:00.000Z",
        refreshedAt: "2026-06-10T00:00:00.000Z",
        lastError: "Registry offline",
        updateAvailable: true,
      }),
    },
    {
      name: "with an up-to-date cached version",
      badge: "已最新",
      provider: providerStatus("thesvg", {
        current: providerVersion("samesha"),
        latest: providerVersion("samesha"),
        checkedAt: "2026-06-11T00:00:00.000Z",
        refreshedAt: "2026-06-11T00:00:00.000Z",
        lastError: "Registry offline",
      }),
    },
  ])("keeps transient provider check failures subordinate to the compact badge $name", async ({ badge, provider }) => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      builtInIconIndex: {
        status: statusWithTheSvg(provider),
      },
    }));

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));

    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });
    const statusBadge = within(dialog).getByRole("button", { name: `查看 TheSVG 图标索引状态：${badge}` });
    expect(statusBadge).toHaveTextContent(badge);

    await user.click(statusBadge);

    expect(await screen.findByText("图标数量")).toBeInTheDocument();
    if (badge === "检查失败") {
      expect(screen.getByRole("alert")).toHaveTextContent("最近检查失败：Registry offline");
      expect(screen.getByRole("button", { name: "更新" })).toBeEnabled();
    } else {
      expect(screen.queryByText(/最近检查失败/)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
  });
});
