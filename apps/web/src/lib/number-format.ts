/**
 * 数值展示格式化工具（前端 UI 用）。
 *
 * 设计目标：
 * - “最多 N 位小数”：避免 `toFixed(0)` 丢失小数精度，也避免 `toFixed(N)` 强制补齐尾随 0
 * - 不做千分位分隔：与参考项目的展示风格保持一致（符号 + 纯数字字符串）
 *
 * 注意：
 * - 仅用于展示层；业务计算请使用原始 number，避免过早四舍五入导致累计误差。
 */

/**
 * 将数字格式化为“最多 maxFractionDigits 位小数”的字符串（会自动去掉尾随 0）。
 *
 * 示例：
 * - 12 -> "12"
 * - 12.3 -> "12.3"
 * - 12.3004 (max=3) -> "12.3"
 * - 12.3456 (max=3) -> "12.346"
 */
export function formatNumberMaxFractionDigits(value: number, maxFractionDigits = 3): string {
  if (!Number.isFinite(value)) return String(value);

  // `Number.prototype.toFixed` 只接受 0~20 的整数；这里做保护避免 UI 报错。
  const safeMax = Math.min(20, Math.max(0, Math.floor(maxFractionDigits)));
  const fixed = value.toFixed(safeMax);
  const trimmed = fixed.replace(/(?:\.0+|(\.\d+?)0+)$/, "$1");

  // 处理极小负数被四舍五入成 "-0" 的情况（例如 -0.0004 -> -0.000 -> "-0"）。
  return trimmed === "-0" ? "0" : trimmed;
}

