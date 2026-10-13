import { describe, expect, it } from "vitest";
import fixtures from "../../../packages/shared/src/contract-fixtures/config-label-locales.json";
import { aiRecognitionConfigContext } from "./ai-recognition-normalize";
import { localizedConfigLabel } from "./custom-config-labels";
import { SERVER_I18N_LOCALES, type ServerI18nKey } from "./server-i18n-catalog";

describe("config label locale contract", () => {
  it.each(fixtures)("preserves $name across UI and server locales", ({ labels, expected, key, value }) => {
    const stored = JSON.stringify(labels);
    const categoryItem = { id: "category", value, labels };
    const paymentItem = { id: "payment", value, labels };
    const isCategory = key?.startsWith("category.") || key === null;
    const builtInKey = key === null ? undefined : key as ServerI18nKey;
    for (const locale of SERVER_I18N_LOCALES) {
      expect(localizedConfigLabel(labels, locale, builtInKey)).toBe(expected[locale]);
      const config = {
        categories: isCategory ? [categoryItem] : [],
        paymentMethods: isCategory ? [] : [paymentItem],
        statuses: [],
        currencies: [],
      };
      const context = aiRecognitionConfigContext(config, locale);
      const option = isCategory ? context.categories[0] : context.paymentMethods[0];
      expect(option?.label).toBe(expected[locale]);
      expect(option?.zhCN).toBe(labels["zh-CN"]);
      expect(option?.enUS).toBe(labels["en-US"]);
      expect(JSON.stringify((isCategory ? categoryItem : paymentItem).labels)).toBe(stored);
    }
  });

  it("does not translate a custom category whose text equals the built-in Other label", () => {
    expect(localizedConfigLabel({ "zh-CN": "其他", "en-US": "Other" }, "ru-RU", undefined)).toBe("Other");
  });
});
