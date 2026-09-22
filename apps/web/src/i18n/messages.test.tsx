// messages 测试保护 Lingui 动态 catalog 加载和静态 fallback，避免翻译 key 缺失时破坏同步 formatter。
import { describe, expect, it } from "vitest";
import { I18nProvider, useI18n } from "@/i18n/I18nProvider";
import { translate } from "@/i18n/messages";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nProvider>{children}</I18nProvider>
      </QueryClientProvider>
    );
  };
}

describe("Lingui compiled catalogs", () => {
  it("interpolates ICU parameters through non-React translate", () => {
    expect(translate("zh-CN", "subscriptions.count", { count: 3 })).toBe("共 3 个订阅");
    expect(translate("zh-CN", "dashboard.realTimeRates", { currency: "CNY" })).toBe("实时汇率换算 (CNY)");
    expect(translate("zh-CN", "subscription.reminderInherit", { days: 5 })).toBe("默认值从设置中获取（提前 5 天）");
  });

  it("formats date-only values through the provider helper", () => {
    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    expect(result.current.formatDateOnly("2026-05-25", "full")).toBe("2026年5月25日");
  });
});
