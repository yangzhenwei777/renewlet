// 图标来源弹层测试单独成文件，避免设置页总装配测试继续挤压 800 行守卫。
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import {
  createControllerState,
  createUploadedAssetsManagerState,
  mocks,
  renderSettingsScreen,
} from "./settings-screen.test-utils";

describe("SettingsScreen icon source settings", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    mocks.useSettingsFormController.mockReturnValue(createControllerState());
    mocks.useUploadedAssetsManager.mockReturnValue(createUploadedAssetsManagerState());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("updates built-in icon source and variant settings without allowing all sources off", async () => {
    const user = userEvent.setup();
    const controller = createControllerState();
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    expect(screen.getByText("内置 3/3 · 在线已启用")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "切换 selfh.st icons 来源" })).not.toBeInTheDocument();

    const configureButton = screen.getByRole("button", { name: "配置" });
    await user.click(configureButton);

    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });
    expect(within(dialog).getByText("选择 Logo 和支付方式图标搜索可使用的来源；在线 App 图标只用于手动 Logo 搜索。")).toBeInTheDocument();
    expect(within(dialog).getByText("内置 SVG 图标库")).toBeInTheDocument();
    expect(within(dialog).getByText("在线 App 图标")).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "切换 TheSVG 来源" })).toBeEnabled();
    expect(within(dialog).getByRole("switch", { name: "切换 selfh.st icons 来源" })).toBeEnabled();
    expect(within(dialog).getByRole("switch", { name: "切换 Dashboard Icons 来源" })).toBeEnabled();
    expect(within(dialog).getByRole("switch", { name: "切换 App Store 来源" })).toBeEnabled();
    const appStoreHeading = within(dialog).getByTestId("online-icon-source-app-store-heading");
    expect(appStoreHeading).toHaveClass("grid", "grid-cols-[1.25rem_minmax(0,1fr)]", "gap-x-3", "gap-y-1");
    expect(within(appStoreHeading).getByText("App Store")).toHaveClass("leading-5");
    const appStoreIconFrame = within(appStoreHeading).getByTestId("online-icon-source-app-store-heading-icon-frame");
    expect(appStoreIconFrame).toHaveClass("flex", "h-5", "w-5", "items-center", "justify-center");
    const appStoreIcon = appStoreIconFrame.querySelector("svg");
    expect(appStoreIcon).toHaveClass("h-4", "w-4");
    expect(appStoreIcon).not.toHaveClass("mt-0.5");
    expect(within(dialog).getByText("App Store 地区")).toBeInTheDocument();
    expect(within(dialog).getByText("至少保留一个地区；关闭 App Store 来源请使用上方开关。")).toBeInTheDocument();
    expect(within(dialog).getByTestId("app-store-storefront-list")).toHaveClass("grid", "gap-3");
    expect(within(dialog).getByTestId("app-store-storefront-list")).not.toHaveClass("sm:grid-cols-2");
    const usStorefront = within(dialog).getByRole("checkbox", { name: "US" });
    const cnStorefront = within(dialog).getByRole("checkbox", { name: "CN" });
    expect(usStorefront).toBeChecked();
    expect(usStorefront).toBeDisabled();
    expect(cnStorefront).not.toBeChecked();
    expect(cnStorefront).toBeEnabled();

    await user.click(within(dialog).getByRole("switch", { name: "切换 selfh.st icons 来源" }));
    expect(controller.updateSetting).toHaveBeenLastCalledWith("builtInIconSources", {
      ...DEFAULT_SETTINGS.builtInIconSources,
      selfhst: { enabled: false, variantsEnabled: true },
    });

    await user.click(within(dialog).getByRole("switch", { name: "切换 Dashboard Icons 变体" }));
    expect(controller.updateSetting).toHaveBeenLastCalledWith("builtInIconSources", {
      ...DEFAULT_SETTINGS.builtInIconSources,
      dashboardIcons: { enabled: true, variantsEnabled: false },
    });

    await user.click(cnStorefront);
    expect(controller.updateSetting).toHaveBeenLastCalledWith("onlineIconSources", {
      ...DEFAULT_SETTINGS.onlineIconSources,
      appStore: { enabled: true, storefronts: ["us", "cn"] },
    });

    await user.click(within(dialog).getByRole("switch", { name: "切换 App Store 来源" }));
    expect(controller.updateSetting).toHaveBeenLastCalledWith("onlineIconSources", {
      ...DEFAULT_SETTINGS.onlineIconSources,
      appStore: { enabled: false, storefronts: ["us"] },
    });

    await user.click(within(dialog).getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog", { name: "配置图标来源" })).not.toBeInTheDocument();
    expect(configureButton).toHaveFocus();

    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        builtInIconSources: {
          thesvg: { enabled: true, variantsEnabled: true },
          selfhst: { enabled: false, variantsEnabled: true },
          dashboardIcons: { enabled: false, variantsEnabled: true },
        },
      },
    }));
    cleanup();
    renderSettingsScreen();

    expect(screen.getByText("内置 1/3 · 在线已启用")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "配置" }));
    expect(await screen.findByRole("switch", { name: "切换 TheSVG 来源" })).toBeDisabled();
  });

  it("keeps App Store storefront choices disabled when the online source is off", async () => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        onlineIconSources: {
          ...DEFAULT_SETTINGS.onlineIconSources,
          appStore: { enabled: false, storefronts: ["cn"] },
        },
      },
    }));

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));
    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });

    expect(within(dialog).getByRole("checkbox", { name: "US" })).toBeDisabled();
    expect(within(dialog).getByRole("checkbox", { name: "CN" })).toBeDisabled();
    expect(within(dialog).getByRole("checkbox", { name: "CN" })).toBeChecked();
  });

  it("does not allow clearing the final App Store storefront", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      settings: {
        onlineIconSources: {
          ...DEFAULT_SETTINGS.onlineIconSources,
          appStore: { enabled: true, storefronts: ["cn"] },
        },
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();
    await user.click(screen.getByRole("button", { name: "配置" }));
    const dialog = await screen.findByRole("dialog", { name: "配置图标来源" });
    const usStorefront = within(dialog).getByRole("checkbox", { name: "US" });
    const cnStorefront = within(dialog).getByRole("checkbox", { name: "CN" });

    expect(cnStorefront).toBeChecked();
    expect(cnStorefront).toBeDisabled();
    expect(usStorefront).toBeEnabled();

    await user.click(cnStorefront);
    expect(controller.updateSetting).not.toHaveBeenCalled();
  });
});
