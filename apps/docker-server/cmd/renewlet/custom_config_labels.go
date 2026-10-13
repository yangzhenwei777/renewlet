package main

// labels 存储仍是中英双字段；第三语言只接受调用方按配置域和值解析出的内置 key，
// 再核对官方双语原值，避免用户可编辑文本碰撞内置翻译。
func localizedCustomConfigLabel(labels customConfigLabels, locale appLocale, builtInKey string) string {
	if locale == localeZhCN {
		return firstNonBlank(labels.ZhCN, labels.EnUS)
	}
	if locale != localeEnUS {
		if builtInKey != "" && labels.ZhCN == serverText(localeZhCN, builtInKey) && labels.EnUS == serverText(localeEnUS, builtInKey) {
			return serverText(locale, builtInKey)
		}
	}
	return firstNonBlank(labels.EnUS, labels.ZhCN)
}
