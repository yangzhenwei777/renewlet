/**
 * 设置领域规则：货币配置策略。
 *
 * 架构位置：
 * - 不依赖 React、toast、API 或 localStorage，便于测试。
 * - application 层负责把这里的结果转换成 UI 提示和持久化调用。
 *
 * 注意： defaultCurrency 是首页/统计页的换算口径。允许禁用它会导致下拉不可选、
 * 图表仍引用旧币种、以及导出/展示口径不一致。
 */
import type { ConfigItem } from "@/types/config";

export type CurrencyConfigPolicyResult =
  | { ok: true; items: ConfigItem[] }
  | {
      ok: false;
      reason: "none-enabled" | "default-disabled";
      items?: ConfigItem[];
    };

/** 当前统计货币必须保持启用，否则首页/统计页会失去统一换算口径。 */
export function enforceCurrencyConfigPolicy(
  items: ConfigItem[],
  defaultCurrency: string,
): CurrencyConfigPolicyResult {
  const enabledCount = items.filter((item) => item.enabled !== false).length;
  if (enabledCount === 0) {
    return {
      ok: false,
      reason: "none-enabled",
    };
  }

  const defaultCurrencyItem = items.find((item) => item.value === defaultCurrency);
  if (defaultCurrencyItem?.enabled === false) {
    return {
      ok: false,
      reason: "default-disabled",
      items: items.map((item) => (item.value === defaultCurrency ? { ...item, enabled: true } : item)),
    };
  }

  return { ok: true, items };
}
