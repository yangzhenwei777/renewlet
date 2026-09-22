package main

// ai_recognition_notes.go 清洗 AI 识别草稿中的长期备注。
//
// 业务边界：AI 输出的 notes 会在导入确认后进入订阅长期记录，因此这里只允许保留服务/网站简介，
// 识别过程、低置信提醒、营销套话和“方便记录到 Renewlet”这类产品内视角都必须被剔除。
import (
	"net/url"
	"strings"
	"unicode"
)

var aiRecognitionProcessNoteFragments = []string{
	"ai根据",
	"ai建议",
	"ai未能",
	"ai无法",
	"ai生成",
	"ai猜测",
	"输入没有",
	"输入未",
	"用户输入",
	"原文",
	"图片未",
	"图像未",
	"表格未",
	"无法确定",
	"不能确定",
	"不确定",
	"未能确定",
	"未能高置信识别",
	"无法识别",
	"未明确",
	"未提供",
	"没有提供",
	"请确认",
	"需要确认",
	"确认后",
	"低置信",
	"高置信识别",
	"模型返回",
	"模型输出",
	"模型无法",
	"aigenerated",
	"aiguessed",
	"theinputdoesnot",
	"inputdoesnot",
	"inputdidnot",
	"notprovided",
	"notspecified",
	"uncertain",
	"cannotdetermine",
	"cantdetermine",
	"pleaseconfirm",
	"lowconfidence",
	"modeloutput",
	"modelreturned",
}

var aiRecognitionNoteDropClauseFragments = []string{
	"适合记录",
	"可用于记录",
	"用于记录",
	"便于记录",
	"方便记录",
	"订阅管理",
	"套餐订阅",
	"请确认",
	"需要确认",
	"导入",
	"renewlet",
	"suitableforrecording",
	"canbeusedtorecord",
	"usedtorecord",
	"subscriptionmanagement",
	"pleaseconfirm",
	"import",
}

var aiRecognitionNoteMarketingFragments = []string{
	"优质",
	"领先",
	"专业",
	"全方位",
	"一站式",
	"可靠",
	"高性能",
	"稳定",
	"premium",
	"leading",
	"professional",
	"comprehensive",
	"all-in-one",
}

// missingDescribableAINoteNames 找出需要 repair 的可描述订阅，限制数量是为了让单次 repair prompt 可控。
func missingDescribableAINoteNames(subscriptions []aiRecognizedSubscriptionDraft) []string {
	names := []string{}
	for _, draft := range subscriptions {
		if draft.Notes == nil && isDescribableForAINotes(draft) {
			names = append(names, draft.Name)
			if len(names) >= 20 {
				break
			}
		}
	}
	return names
}

func isDescribableForAINotes(draft aiRecognizedSubscriptionDraft) bool {
	return draft.Website != nil || draft.Category != nil || len(draft.Tags) > 0 || draft.Confidence == "high"
}

// fillMissingAINotesWithDynamicFallback 是 repair 失败后的兜底，不引入本地品牌表，只用本轮动态字段生成短备注。
func fillMissingAINotesWithDynamicFallback(response aiRecognizeResponse, locale appLocale, configContext aiRecognitionConfigContext) aiRecognizeResponse {
	for index := range response.Subscriptions {
		draft := &response.Subscriptions[index]
		if draft.Notes != nil || !isDescribableForAINotes(*draft) {
			continue
		}
		note := buildDynamicAIFallbackNote(*draft, locale, configContext)
		if note == "" {
			continue
		}
		draft.Notes = &aiSuggestedTextField{Value: note, Source: "suggested"}
		filtered := []string{}
		for _, warning := range draft.Warnings {
			if warning != "AI_WARNING_NOTES_MISSING" {
				filtered = append(filtered, warning)
			}
		}
		draft.Warnings = compactAIWarnings(filtered, 12)
	}
	return response
}

func buildDynamicAIFallbackNote(draft aiRecognizedSubscriptionDraft, locale appLocale, configContext aiRecognitionConfigContext) string {
	labels := dynamicAINoteLabels(draft, configContext)
	var raw string
	if len(labels) > 0 {
		raw = serverFormat(locale, "aiRecognition.fallbackNote.labels", map[string]interface{}{
			"name":   draft.Name,
			"labels": strings.Join(labels, serverText(locale, "aiRecognition.fallbackNote.labelSeparator")),
		})
	} else {
		raw = dynamicAIWebsiteFallbackNote(draft, locale)
	}
	field := normalizeAINotesField(&aiSuggestedTextField{Value: raw, Source: "suggested"}, 5000)
	if field == nil {
		return ""
	}
	return field.Value
}

func dynamicAINoteLabels(draft aiRecognizedSubscriptionDraft, configContext aiRecognitionConfigContext) []string {
	labels := []string{}
	seen := map[string]bool{}
	add := func(value string) {
		label := trimMax(value, 80)
		key := aiRecognitionConfigMatchKey(label)
		if label == "" || key == "" || key == aiRecognitionConfigMatchKey(draft.Name) || seen[key] {
			return
		}
		seen[key] = true
		labels = append(labels, label)
	}
	for _, tag := range draft.Tags {
		add(tag)
	}
	// 标签优先于分类，因为标签来自用户既有组织习惯；分类只作为更弱的动态上下文补充。
	if draft.Category != nil {
		if option := findAIRecognitionConfigOption(configContext.Categories, *draft.Category); option != nil {
			add(option.Label)
		} else {
			add(*draft.Category)
		}
	}
	if len(labels) > 3 {
		return labels[:3]
	}
	return labels
}

func dynamicAIWebsiteFallbackNote(draft aiRecognizedSubscriptionDraft, locale appLocale) string {
	if draft.Website == nil {
		return ""
	}
	host := aiRecognitionHostname(draft.Website.Value)
	if host == "" {
		return ""
	}
	return serverFormat(locale, "aiRecognition.fallbackNote.website", map[string]interface{}{
		"name":   draft.Name,
		"domain": host,
	})
}

func aiRecognitionHostname(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	if !strings.HasPrefix(text, "http://") && !strings.HasPrefix(text, "https://") {
		text = "https://" + text
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed.Hostname() == "" {
		return ""
	}
	return strings.TrimPrefix(parsed.Hostname(), "www.")
}

func normalizeAINotesField(field *aiSuggestedTextField, maxLen int) *aiSuggestedTextField {
	normalized := normalizeAISuggestedField(field, maxLen)
	if normalized == nil {
		return nil
	}
	// AI 备注会进入订阅长期备注；这里兜底清掉识别过程和产品内视角，保留真实服务/网站简介。
	if isAIRecognitionProcessNote(normalized.Value) {
		return nil
	}
	value := stripAIRecognitionAdviceClauses(normalized.Value)
	if value == "" || isAIRecognitionProcessNote(value) || isAIRecognitionMarketingNote(value) {
		return nil
	}
	normalized.Value = trimMax(cleanAIRecognitionServiceDescription(value), maxLen)
	if normalized.Value == "" {
		return nil
	}
	return normalized
}

func isAIRecognitionProcessNote(value string) bool {
	key := aiRecognitionNoteMatchKey(value)
	if key == "" {
		return false
	}
	for _, fragment := range aiRecognitionProcessNoteFragments {
		if strings.Contains(key, fragment) {
			return true
		}
	}
	return false
}

func aiRecognitionNoteMatchKey(value string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if unicode.IsSpace(r) {
			continue
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

func stripAIRecognitionAdviceClauses(value string) string {
	clauses := splitAIRecognitionNoteClauses(value)
	kept := []string{}
	dropped := false
	for _, clause := range clauses {
		text := strings.TrimSpace(clause)
		if text == "" || aiRecognitionNoteContainsFragment(text, aiRecognitionNoteDropClauseFragments) {
			if text != "" {
				dropped = true
			}
			continue
		}
		kept = append(kept, text)
	}
	if !dropped {
		return strings.TrimSpace(value)
	}
	return strings.TrimSpace(strings.Join(kept, "，"))
}

func splitAIRecognitionNoteClauses(value string) []string {
	clauses := []string{}
	var builder strings.Builder
	for _, r := range value {
		if strings.ContainsRune("，,。.!?！？；;", r) {
			clauses = append(clauses, builder.String())
			builder.Reset()
			continue
		}
		builder.WriteRune(r)
	}
	clauses = append(clauses, builder.String())
	return clauses
}

func isAIRecognitionMarketingNote(value string) bool {
	return aiRecognitionNoteContainsFragment(value, aiRecognitionNoteMarketingFragments)
}

func aiRecognitionNoteContainsFragment(value string, fragments []string) bool {
	key := aiRecognitionNoteMatchKey(value)
	if key == "" {
		return false
	}
	for _, fragment := range fragments {
		if strings.Contains(key, fragment) {
			return true
		}
	}
	return false
}

func cleanAIRecognitionServiceDescription(value string) string {
	text := strings.ReplaceAll(value, "相关服务", "服务")
	text = strings.ReplaceAll(text, "等服务服务", "等服务")
	text = strings.ReplaceAll(text, "服务服务", "服务")
	return strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
}
