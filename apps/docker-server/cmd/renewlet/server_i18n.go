package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/text/language"
)

// Go catalog 与 Worker catalog 由 shared JSON 同源生成；前端错误展示只共享 code，不共享服务端翻译文本。
//
//go:embed i18n/active.*.json
var serverI18nFS embed.FS

var (
	serverI18nCatalogs = mustLoadServerI18nCatalogs()
	acceptLanguageQRe  = regexp.MustCompile(`^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$`)
)

func mustLoadServerI18nCatalogs() map[appLocale]map[string]string {
	catalogs := map[appLocale]map[string]string{}
	for _, locale := range supportedAppLocales {
		data, err := serverI18nFS.ReadFile("i18n/active." + string(locale) + ".json")
		if err != nil {
			panic(err)
		}
		var catalog map[string]string
		if err := json.Unmarshal(data, &catalog); err != nil {
			panic(err)
		}
		catalogs[locale] = catalog
	}
	if _, ok := catalogs[defaultAppLocale]; !ok {
		panic(fmt.Sprintf("missing default server i18n catalog %s", defaultAppLocale))
	}
	return catalogs
}

// matchAppLocale 只允许完整标签或基础语言命中，避免 Go 的语言相似度 matcher 把白俄罗斯语等推断成俄语；
// 该边界与 Worker matchServerLocale 共用同一组夹具，跨运行面不能依赖各自运行库的相似语言启发式。
func matchAppLocale(value string) (appLocale, bool) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "_", "-"))
	if value == "" {
		return defaultAppLocale, false
	}
	tag, err := language.Parse(value)
	if err != nil {
		return defaultAppLocale, false
	}
	normalized := strings.ToLower(tag.String())
	for _, locale := range supportedAppLocales {
		if normalized == strings.ToLower(string(locale)) {
			return locale, true
		}
	}
	baseLanguage := normalized
	if separator := strings.IndexByte(baseLanguage, '-'); separator >= 0 {
		baseLanguage = baseLanguage[:separator]
	}
	for _, locale := range supportedAppLocales {
		localeTag := strings.ToLower(string(locale))
		if separator := strings.IndexByte(localeTag, '-'); separator >= 0 {
			localeTag = localeTag[:separator]
		}
		if baseLanguage == localeTag {
			return locale, true
		}
	}
	return defaultAppLocale, false
}

func normalizeAppLocale(value string) appLocale {
	if locale, ok := matchAppLocale(value); ok {
		return locale
	}
	return defaultAppLocale
}

func isSupportedAppLocale(value string) bool {
	for _, locale := range supportedAppLocales {
		if value == string(locale) {
			return true
		}
	}
	return false
}

// Accept-Language 只服务无显式偏好请求；按 q 权重和原始顺序选择，忽略非法项，无匹配或通配符回退英文。
// 解析规则必须与 Worker requestLocale 的夹具保持一致，避免 Docker/Cloudflare 返回不同语言。
func matchAcceptLanguage(header string) appLocale {
	type preference struct {
		tag   string
		q     float64
		index int
	}
	preferences := []preference{}
	for index, rawPart := range strings.Split(header, ",") {
		parts := strings.Split(rawPart, ";")
		tag := strings.TrimSpace(parts[0])
		if tag == "" {
			continue
		}
		quality := 1.0
		valid := true
		for _, rawParameter := range parts[1:] {
			parameter := strings.TrimSpace(rawParameter)
			if len(parameter) < 2 || !strings.EqualFold(parameter[:2], "q=") {
				continue
			}
			value := strings.TrimSpace(parameter[2:])
			if !acceptLanguageQRe.MatchString(value) {
				valid = false
				break
			}
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil || parsed <= 0 {
				valid = false
				break
			}
			quality = parsed
			break
		}
		if valid {
			preferences = append(preferences, preference{tag: tag, q: quality, index: index})
		}
	}
	sort.SliceStable(preferences, func(i, j int) bool {
		if preferences[i].q == preferences[j].q {
			return preferences[i].index < preferences[j].index
		}
		return preferences[i].q > preferences[j].q
	})
	for _, candidate := range preferences {
		if strings.TrimSpace(candidate.tag) == "*" {
			return defaultAppLocale
		}
		if matched, ok := matchAppLocale(candidate.tag); ok {
			return matched
		}
	}
	return defaultAppLocale
}

// 缺少目标语言或 key 时统一回退英文 catalog；最终返回 key 让缺失构件在测试和日志中可见。
func serverText(locale appLocale, key string) string {
	if catalog, ok := serverI18nCatalogs[locale]; ok {
		if message, ok := catalog[key]; ok {
			return message
		}
	}
	if message, ok := serverI18nCatalogs[defaultAppLocale][key]; ok {
		return message
	}
	return key
}

func serverFormat(locale appLocale, key string, params map[string]interface{}) string {
	return serverFormatMessage(serverText(locale, key), params)
}

func serverFormatMessage(message string, params map[string]interface{}) string {
	for name, value := range params {
		message = strings.ReplaceAll(message, "{"+name+"}", fmt.Sprint(value))
	}
	return message
}

func localizedDisabledBanReason(locale appLocale) string {
	return serverText(locale, "auth.accountDisabledByAdmin")
}
