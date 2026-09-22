import { cleanBuiltInIconSourceSettingsPatch, mergeBuiltInIconSourceSettings } from "./built-in-icons";
import { moneyFromUnknown } from "./money";
import { cleanOnlineIconSourceSettingsPatch, mergeOnlineIconSourceSettings } from "./online-icon-sources";
import {
  appSettingsSchema,
  DINGTALK_CONTENT_TEMPLATE_MAX_LENGTH,
  DINGTALK_TITLE_TEMPLATE_MAX_LENGTH,
  persistedAppSettingsSchema,
  settingsUpdateBodySchema,
  type ApiAppSettings,
} from "./schemas/settings";
import type { z } from "zod";

export type ApiAppSettingsPatch = z.infer<typeof settingsUpdateBodySchema>;

export function normalizeStoredSettingsPatch(value: unknown): unknown {
  if (!isRecord(value)) return value;
  // 写入 API 仍严格拒绝非法值；这里仅修复历史/手改 settings JSON 的已知脏字段，避免单个坏字段拖垮整份设置。
  const telegramMessageFormat = value["telegramMessageFormat"];
  const dingtalkMessageType = value["dingtalkMessageType"];
  const dingtalkTitleTemplate = value["dingtalkTitleTemplate"];
  const dingtalkContentTemplate = value["dingtalkContentTemplate"];
  const subscriptionPriceReferenceCurrency = value["subscriptionPriceReferenceCurrency"];
  const monthlyBudget = moneyFromUnknown(value["monthlyBudget"]);
  return {
    ...value,
    ...(monthlyBudget ? { monthlyBudget } : {}),
    ...(
      subscriptionPriceReferenceCurrency === undefined
      || subscriptionPriceReferenceCurrency === "default"
      || (typeof subscriptionPriceReferenceCurrency === "string" && /^[A-Z]{3}$/.test(subscriptionPriceReferenceCurrency))
        ? {}
        : { subscriptionPriceReferenceCurrency: "default" }
    ),
    ...(
      telegramMessageFormat === undefined || telegramMessageFormat === "plain" || telegramMessageFormat === "html"
        ? {}
        : { telegramMessageFormat: "plain" }
    ),
    ...(
      dingtalkMessageType === undefined || dingtalkMessageType === "markdown" || dingtalkMessageType === "text"
        ? {}
        : { dingtalkMessageType: "markdown" }
    ),
    ...(
      typeof dingtalkTitleTemplate === "string" && codePointLength(dingtalkTitleTemplate) <= DINGTALK_TITLE_TEMPLATE_MAX_LENGTH
        ? {}
        : { dingtalkTitleTemplate: "" }
    ),
    ...(
      typeof dingtalkContentTemplate === "string" && codePointLength(dingtalkContentTemplate) <= DINGTALK_CONTENT_TEMPLATE_MAX_LENGTH
        ? {}
        : { dingtalkContentTemplate: "" }
    ),
  };
}

/** settings_json 的 nested 字段必须在同一处合并；调用方不能用浅拷贝覆盖来源开关或 AI 凭据对象。 */
export function mergeAppSettingsPatch(current: ApiAppSettings, patch: ApiAppSettingsPatch): ApiAppSettings {
  const cleanPatch = cleanSettingsPatch(patch);
  return appSettingsSchema.parse({
    ...current,
    ...cleanPatch,
    aiRecognition: {
      ...current.aiRecognition,
      ...(isRecord(cleanPatch.aiRecognition) ? cleanRecord(cleanPatch.aiRecognition) : {}),
    },
    builtInIconSources: mergeBuiltInIconSourceSettings(
      current.builtInIconSources,
      cleanBuiltInIconSourceSettingsPatch(cleanPatch.builtInIconSources),
    ),
    onlineIconSources: mergeOnlineIconSourceSettings(
      current.onlineIconSources,
      cleanOnlineIconSourceSettingsPatch(cleanPatch.onlineIconSources),
    ),
  });
}

export function normalizeSettingsValue(value: unknown, defaults: ApiAppSettings): ApiAppSettings {
  const patch = persistedAppSettingsSchema.parse(normalizeStoredSettingsPatch(value));
  // 持久化读取包含 write-only secret，不能复用浏览器 PATCH schema；嵌套来源配置仍按同一合并规则补历史默认值。
  return appSettingsSchema.parse({
    ...defaults,
    ...patch,
    aiRecognition: {
      ...defaults.aiRecognition,
      ...(patch.aiRecognition ?? {}),
    },
    builtInIconSources: mergeBuiltInIconSourceSettings(
      defaults.builtInIconSources,
      cleanBuiltInIconSourceSettingsPatch(patch.builtInIconSources),
    ),
    onlineIconSources: mergeOnlineIconSourceSettings(
      defaults.onlineIconSources,
      cleanOnlineIconSourceSettingsPatch(patch.onlineIconSources),
    ),
  });
}

function cleanSettingsPatch(patch: ApiAppSettingsPatch): ApiAppSettingsPatch {
  return cleanRecord(patch) as ApiAppSettingsPatch;
}

function cleanRecord<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
