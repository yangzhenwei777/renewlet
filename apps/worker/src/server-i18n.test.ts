import { describe, expect, it } from "vitest";
import localeFixtures from "../../../packages/shared/src/contract-fixtures/server-locale-resolution.json";
import { accountContentLocale, requestLocale } from "./server-i18n";

function localeRequest(headers: HeadersInit = {}): Request {
  return new Request("https://renewlet.example/api/app/example", { headers });
}

describe("server locale resolution", () => {
  it("prefers a valid explicit locale over Accept-Language", () => {
    expect(requestLocale(localeRequest({
      "X-Renewlet-Locale": "en-US",
      "Accept-Language": "zh-CN,zh;q=0.9",
    }))).toBe("en-US");
  });

  it.each(["fr-FR", "zh-Hant", "zh-CN, en-US", "zh-$$$"])(
    "falls back to English for invalid explicit locale %j without consulting Accept-Language",
    (explicitLocale) => {
      expect(requestLocale(localeRequest({
        "X-Renewlet-Locale": explicitLocale,
        "Accept-Language": "zh-CN",
      }))).toBe("en-US");
    },
  );

  it.each(localeFixtures)("resolves Accept-Language $name", ({ header, expected }) => {
    expect(requestLocale(localeRequest({ "Accept-Language": header }))).toBe(expected);
  });

  it("uses explicit account preferences and English for auto background content", () => {
    expect(accountContentLocale("zh-CN")).toBe("zh-CN");
    expect(accountContentLocale("en-US")).toBe("en-US");
    expect(accountContentLocale("ru-RU")).toBe("ru-RU");
    expect(accountContentLocale("auto")).toBe("en-US");
  });
});
