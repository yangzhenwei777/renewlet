import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { ExchangeRatesSection, type ExchangeRatesSectionProps } from "./exchange-rates-section";

function props(overrides: Partial<ExchangeRatesSectionProps> = {}): ExchangeRatesSectionProps {
  return {
    settings: {
      defaultCurrency: "CNY",
      exchangeRateProvider: "frankfurter",
      subscriptionPriceReferenceEnabled: false,
      subscriptionPriceReferenceCurrency: "USD",
    },
    customConfig: DEFAULT_CUSTOM_CONFIG,
    rates: { USD: 1, CNY: 7 },
    activeRateProvider: "frankfurter",
    ratesRefreshPending: false,
    ratesError: null,
    ratesErrorDetails: null,
    ratesWarning: null,
    reportBasisStatus: {
      month: "2026-08",
      locked: true,
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T00:00:00.000Z",
    },
    lastUpdated: new Date("2026-08-06T00:00:00.000Z"),
    defaultCurrencyOptions: [{ value: "CNY", label: "¥ 人民币 (CNY)" }],
    subscriptionPriceReferenceCurrencyOptions: [{ value: "USD", label: "$ 美元 (USD)" }],
    effectiveSubscriptionPriceReferenceCurrency: "USD",
    subscriptionPriceReferenceCurrencyLocalPreference: null,
    handleRefreshRates: vi.fn(),
    handleDefaultCurrencyChange: vi.fn(),
    handleSubscriptionPriceReferenceEnabledChange: vi.fn(),
    handleSubscriptionPriceReferenceCurrencyChange: vi.fn(),
    handleExchangeRateProviderChange: vi.fn(),
    ...overrides,
  };
}

function renderSection(overrides: Partial<ExchangeRatesSectionProps> = {}) {
  return render(
    <TooltipProvider>
      <ExchangeRatesSection {...props(overrides)} />
    </TooltipProvider>,
  );
}

describe("ExchangeRatesSection refresh feedback", () => {
  it("disables the refresh action and exposes busy state while settings remain available", () => {
    renderSection({ ratesRefreshPending: true });

    const button = screen.getByRole("button", { name: "刷新中..." });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("combobox", { name: "汇率来源" })).toBeInTheDocument();
  });

  it("shows one persistent failure and opens raw response details", async () => {
    const user = userEvent.setup();
    renderSection({
      ratesError: "网络请求失败",
      ratesErrorDetails: {
        message: "Too Many Requests",
        responseText: "<html>rate limited</html>",
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("汇率获取失败，当前使用备用汇率。网络请求失败");
    await user.click(screen.getByRole("button", { name: "查看错误响应" }));
    expect(screen.getByTestId("exchange-rates-raw-error-response-dialog")).toHaveTextContent("rate limited");
  });
});
