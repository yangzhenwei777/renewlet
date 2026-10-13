import type { ApiCustomConfig } from "@renewlet/shared/schemas/custom-config";
import type { ServerI18nKey } from "./server-i18n-catalog";
import { serverText, type AppLocale } from "./server-i18n";

type ConfigLabels = ApiCustomConfig["categories"][number]["labels"];

/**
 * labels 存储仍是中英双字段；第三语言只接受调用方按配置域和值解析出的内置 key，
 * 再核对官方双语原值，避免用户可编辑文本碰撞内置翻译。
 */
export function localizedConfigLabel(labels: ConfigLabels, locale: AppLocale, builtInKey?: ServerI18nKey): string {
  if (locale === "zh-CN") return labels["zh-CN"] || labels["en-US"];
  if (locale !== "en-US") {
    if (builtInKey
      && labels["zh-CN"] === serverText("zh-CN", builtInKey)
      && labels["en-US"] === serverText("en-US", builtInKey)) {
      return serverText(locale, builtInKey);
    }
  }
  return labels["en-US"] || labels["zh-CN"];
}
