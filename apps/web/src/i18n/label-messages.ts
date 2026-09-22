import { BUILT_IN_LABELS, type BuiltInLabelKey } from "@/i18n/built-in-labels";
import type { LocalizedLabels } from "@/i18n/locales";

/**
 * labelsFromCatalog 将产品内置标签从 Lingui catalog 固化成 LocalizedLabels。
 *
 * 只有产品预置选项走这里；用户自定义配置和导入来源原文仍保留持久化 labels() 数据形状。
 */
export function labelsFromCatalog(key: BuiltInLabelKey): LocalizedLabels {
  return BUILT_IN_LABELS[key];
}
