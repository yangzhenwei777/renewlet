package main

// locale.go 统一处理 API 文案的语言协商。
//
// 架构位置：
//   - 前端会发送 X-Renewlet-Locale，后端 route 和 Validate 使用 requestLocale 输出本地化错误。
//   - 没有显式 header 时回退到 Accept-Language，最后默认英文。
import (
	"net/http"
	"strings"
)

type appLocale string

// requestLocale 从请求头选择本地化语言。
// X-Renewlet-Locale 优先级高于 Accept-Language，确保前端设置页语言能控制 API 错误文案。
func requestLocale(req *http.Request) appLocale {
	if req == nil {
		return defaultAppLocale
	}
	if locale := strings.TrimSpace(req.Header.Get("X-Renewlet-Locale")); locale != "" {
		if isSupportedAppLocale(locale) {
			return appLocale(locale)
		}
		return defaultAppLocale
	}
	return acceptLanguageLocale(req.Header.Get("Accept-Language"))
}

func acceptLanguageLocale(header string) appLocale {
	return matchAcceptLanguage(header)
}

func isSupportedLocalePreference(value string) bool {
	if value == string(autoLocalePreference) {
		return true
	}
	return isSupportedAppLocale(value)
}

// 请求语言只控制当前交互；账号内容语言只读取持久化偏好，auto 在无设备上下文的后台统一回退英文。
func accountContentLocale(settings appSettings) appLocale {
	if settings.LocalePreference == string(autoLocalePreference) {
		return defaultAppLocale
	}
	if isSupportedAppLocale(settings.LocalePreference) {
		return appLocale(settings.LocalePreference)
	}
	return defaultAppLocale
}
