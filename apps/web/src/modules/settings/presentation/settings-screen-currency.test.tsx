// SettingsScreen 货币测试保护选择器顺序跟随货币管理持久配置，而不是页面层临时重排。
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import {
  createControllerState,
  createUploadedAssetsManagerState,
  mocks,
  renderSettingsScreen,
} from "./settings-screen.test-utils";

const managerOrderCurrencies = [
  {
    id: "PHP",
    value: "PHP",
    labels: { "zh-CN": "₱ 菲律宾比索 (PHP)", "en-US": "₱ Philippine Peso (PHP)" },
    enabled: true,
  },
  {
    id: "AED",
    value: "AED",
    labels: { "zh-CN": "AED 阿联酋迪拉姆", "en-US": "AED United Arab Emirates Dirham" },
    enabled: true,
  },
  {
    id: "USD",
    value: "USD",
    labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" },
    enabled: true,
  },
  {
    id: "CNY",
    value: "CNY",
    labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" },
    enabled: true,
  },
];

function expectOptionValues(element: HTMLElement, values: string[]) {
  expect(element).toHaveAttribute("data-option-values", values.join("|"));
}

describe("SettingsScreen currency selectors", () => {
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
  });

  it("uses the persisted currency manager order for the reporting currency selector", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      settings: {
        defaultCurrency: "USD",
      },
      customConfig: {
        ...DEFAULT_CUSTOM_CONFIG,
        currencies: managerOrderCurrencies,
      },
      publicStatusPage: {
        pageUrl: "https://example.test/status/public-token",
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    const reportingCurrencySelect = screen.getByRole("combobox", { name: "统计货币" });
    expectOptionValues(reportingCurrencySelect, ["PHP", "AED", "USD", "CNY"]);
    await user.click(reportingCurrencySelect);

    expect(controller.handleDefaultCurrencyChange).toHaveBeenCalledWith("PHP");
  });

  it("keeps settings currency selectors aligned while preserving their sentinel options", () => {
    const controller = createControllerState({
      settings: {
        defaultCurrency: "USD",
        publicStatusCurrency: "inherit",
        subscriptionPriceReferenceCurrency: "default",
      },
      customConfig: {
        ...DEFAULT_CUSTOM_CONFIG,
        currencies: managerOrderCurrencies,
      },
      publicStatusPage: {
        pageUrl: "https://example.test/status/public-token",
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    expectOptionValues(screen.getByRole("combobox", { name: "统计货币" }), ["PHP", "AED", "USD", "CNY"]);
    expectOptionValues(screen.getByRole("combobox", { name: "公开页统计货币" }), ["inherit", "PHP", "AED", "USD", "CNY"]);
    expectOptionValues(screen.getByRole("combobox", { name: "单订阅参考货币" }), ["default", "PHP", "AED", "USD", "CNY"]);
  });

  it("keeps subscription price reference hidden by default and applies a local preference explicitly", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", {
      languages: ["en-US"],
      language: "en-US",
    });
    const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    const resolvedOptionsSpy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
      return {
        ...originalResolvedOptions.call(this),
        timeZone: "America/New_York",
      };
    });
    const controller = createControllerState({
      settings: {
        defaultCurrency: "CNY",
        subscriptionPriceReferenceEnabled: false,
        subscriptionPriceReferenceCurrency: "default",
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    try {
      renderSettingsScreen();

      expect(screen.getByText("Hidden by default. Turn it on to follow the reporting currency or pin a reference currency.")).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Per-subscription reference price" })).not.toBeChecked();
      expect(screen.getByRole("combobox", { name: "Per-subscription reference currency" })).toBeDisabled();
      expect(screen.getByRole("combobox", { name: "Per-subscription reference currency" })).toHaveTextContent("Follow reporting currency (CNY)");

      await user.click(screen.getByRole("button", { name: "Use local preference (USD)" }));

      expect(controller.updateSetting).toHaveBeenCalledWith("subscriptionPriceReferenceEnabled", true);
      expect(controller.updateSetting).toHaveBeenCalledWith("subscriptionPriceReferenceCurrency", "USD");
    } finally {
      resolvedOptionsSpy.mockRestore();
    }
  });

  it("lets users keep default or explicit subscription reference currency with disabled-current echo", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      settings: {
        defaultCurrency: "CNY",
        subscriptionPriceReferenceEnabled: true,
        subscriptionPriceReferenceCurrency: "USD",
      },
      customConfig: {
        ...DEFAULT_CUSTOM_CONFIG,
        currencies: [
          {
            id: "CNY",
            value: "CNY",
            labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" },
            enabled: true,
          },
          {
            id: "USD",
            value: "USD",
            labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" },
            enabled: false,
          },
        ],
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    expect(screen.getByText("在订阅卡片和详情价格下方显示折算到 USD 的小字参考价。")).toBeInTheDocument();
    const referenceCurrencySelect = screen.getByRole("combobox", { name: "单订阅参考货币" });
    expect(referenceCurrencySelect).toHaveTextContent("$ 美元 (USD)");

    await user.click(referenceCurrencySelect);

    expect(controller.updateSetting).toHaveBeenCalledWith("subscriptionPriceReferenceCurrency", "default");
  });
});
