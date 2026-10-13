package main

// 服务端 locale 测试保护 X-Renewlet-Locale 优先级和 catalog placeholder；通知/错误文案不能依赖前端 Lingui runtime。

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"
)

func TestRequestLocalePrefersExplicitHeader(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "/api/app/example", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	req.Header.Set("X-Renewlet-Locale", "en-US")

	if got := requestLocale(req); got != localeEnUS {
		t.Fatalf("expected en-US, got %s", got)
	}

	req.Header.Set("X-Renewlet-Locale", "en-GB")
	if got := requestLocale(req); got != localeEnUS {
		t.Fatalf("expected unsupported explicit header to fall back to en-US, got %s", got)
	}

	for _, invalid := range []string{"fr-FR", "zh-Hant", "zh-CN, en-US", "zh-$$$"} {
		req.Header.Set("X-Renewlet-Locale", invalid)
		if got := requestLocale(req); got != localeEnUS {
			t.Fatalf("expected invalid explicit header %q to fall back to default locale, got %s", invalid, got)
		}
	}
}

func TestAcceptLanguageLocaleUsesHighestQualitySupportedLanguage(t *testing.T) {
	data, err := os.ReadFile("../../../../packages/shared/src/contract-fixtures/server-locale-resolution.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name     string `json:"name"`
		Header   string `json:"header"`
		Expected string `json:"expected"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			if got := acceptLanguageLocale(fixture.Header); got != appLocale(fixture.Expected) {
				t.Fatalf("Accept-Language %q = %s, want %s", fixture.Header, got, fixture.Expected)
			}
		})
	}
}

func TestAccountContentLocaleUsesExplicitPreferenceOrEnglishFallback(t *testing.T) {
	settings := defaultAppSettings()
	if got := accountContentLocale(settings); got != localeEnUS {
		t.Fatalf("expected auto account content to fall back to en-US, got %s", got)
	}
	settings.LocalePreference = string(preferenceZhCN)
	if got := accountContentLocale(settings); got != localeZhCN {
		t.Fatalf("expected explicit zh-CN account preference, got %s", got)
	}
	settings.LocalePreference = "fr-FR"
	if got := accountContentLocale(settings); got != localeEnUS {
		t.Fatalf("expected invalid account preference to fall back to en-US, got %s", got)
	}
}

func TestServerI18nLocalizer(t *testing.T) {
	if got := normalizeAppLocale("en-GB"); got != localeEnUS {
		t.Fatalf("expected en-US, got %s", got)
	}
	if got := serverText(localeEnUS, "common.requestBodyTooLarge"); got != "Request body is too large" {
		t.Fatalf("unexpected localized text: %q", got)
	}
	if got := serverFormat(localeZhCN, "common.requiredField", map[string]interface{}{"label": "Webhook URL"}); got != "Webhook URL 不能为空" {
		t.Fatalf("unexpected formatted text: %q", got)
	}
	if got := serverFormat(localeEnUS, "notification.content.itemLine", map[string]interface{}{
		"name":       "Acme",
		"targetDate": "2026-05-17",
		"amount":     "18",
		"currency":   "USD",
		"extra":      "3 days before",
	}); got != "- Acme: 2026-05-17, 18 USD (3 days before)" {
		t.Fatalf("unexpected named placeholder output: %q", got)
	}
	if got := serverText(localeEnUS, "missing.key"); got != "missing.key" {
		t.Fatalf("expected missing key fallback, got %q", got)
	}
}
