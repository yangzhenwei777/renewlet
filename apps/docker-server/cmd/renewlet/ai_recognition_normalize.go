package main

// ai_recognition_normalize.go 是模型输出进入 import preview 之前的清洗层。
//
// 第三方模型输出不可信：这里把宽松生成 schema、raw JSON 恢复结果和结构化 SDK 对象统一收敛到 shared API 契约，
// 只保留可解释 warning，不把猜测或识别过程文本写进长期订阅字段。
import (
	"errors"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var (
	aiSecretPattern   = regexp.MustCompile(`(?i)(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:api[_-]?key|authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token)["'\s:=]+[A-Za-z0-9._~+/=-]{8,})`)
	aiCurrencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)
	aiNumberPattern   = regexp.MustCompile(`-?\d+(?:\.\d+)?`)
)

type aiGeneratedRecognizeResponse struct {
	Subscriptions []aiGeneratedSubscriptionDraft `json:"subscriptions"`
	Warnings      []string                       `json:"warnings"`
}

type aiGeneratedSubscriptionDraft struct {
	Name                         string                         `json:"name"`
	Price                        interface{}                    `json:"price"`
	Currency                     *string                        `json:"currency"`
	BillingCycle                 *string                        `json:"billingCycle"`
	CustomDays                   interface{}                    `json:"customDays"`
	CustomCycleUnit              *string                        `json:"customCycleUnit"`
	OneTimeTermCount             interface{}                    `json:"oneTimeTermCount"`
	OneTimeTermUnit              *string                        `json:"oneTimeTermUnit"`
	Category                     *string                        `json:"category"`
	Status                       *string                        `json:"status"`
	PaymentMethod                *string                        `json:"paymentMethod"`
	StartDate                    *string                        `json:"startDate"`
	NextBillingDate              *string                        `json:"nextBillingDate"`
	AutoCalculateNextBillingDate *bool                          `json:"autoCalculateNextBillingDate"`
	TrialEndDate                 *string                        `json:"trialEndDate"`
	Website                      *aiGeneratedSuggestedTextField `json:"website"`
	Notes                        *aiGeneratedNotesField         `json:"notes"`
	Tags                         []string                       `json:"tags"`
	ReminderDays                 interface{}                    `json:"reminderDays"`
	RepeatReminderEnabled        *bool                          `json:"repeatReminderEnabled"`
	RepeatReminderInterval       *string                        `json:"repeatReminderInterval"`
	RepeatReminderWindow         *string                        `json:"repeatReminderWindow"`
	Confidence                   string                         `json:"confidence"`
	Warnings                     []string                       `json:"warnings"`
}

type aiGeneratedSuggestedTextField struct {
	Value  *string `json:"value"`
	Source string  `json:"source"`
}

type aiGeneratedNotesField struct {
	Value  *string `json:"value"`
	Source string  `json:"source"`
}

func normalizeAIGeneratedRecognizeResponse(raw aiGeneratedRecognizeResponse, providerType string, transportProtocol string, model string, diagnostics aiRecognitionDiagnostics, configContext aiRecognitionConfigContext) (aiRecognizeResponse, error) {
	// generated schema 允许模型输出字符串数字和宽松枚举；进入前端前必须再走标准 RecognizeResponse 归一化。
	response := aiRecognizeResponse{
		Warnings:      raw.Warnings,
		Subscriptions: make([]aiRecognizedSubscriptionDraft, 0, len(raw.Subscriptions)),
		Diagnostics:   diagnostics,
	}
	for _, draft := range raw.Subscriptions {
		response.Subscriptions = append(response.Subscriptions, aiGeneratedDraftToRecognized(draft))
	}
	return normalizeAIRecognizeResponse(response, providerType, transportProtocol, model, configContext)
}

func aiGeneratedDraftToRecognized(draft aiGeneratedSubscriptionDraft) aiRecognizedSubscriptionDraft {
	warnings := append([]string{}, draft.Warnings...)
	recognized := aiRecognizedSubscriptionDraft{
		Name:                         draft.Name,
		Currency:                     normalizeAIGeneratedCurrency(draft.Currency),
		BillingCycle:                 normalizeAIGeneratedBillingCycle(draft.BillingCycle),
		CustomCycleUnit:              draft.CustomCycleUnit,
		OneTimeTermUnit:              draft.OneTimeTermUnit,
		Category:                     draft.Category,
		Status:                       draft.Status,
		PaymentMethod:                draft.PaymentMethod,
		StartDate:                    draft.StartDate,
		NextBillingDate:              draft.NextBillingDate,
		AutoCalculateNextBillingDate: draft.AutoCalculateNextBillingDate,
		TrialEndDate:                 draft.TrialEndDate,
		Website:                      aiGeneratedSuggestedToSuggestedField(draft.Website),
		Notes:                        aiGeneratedNotesToSuggestedField(draft.Notes),
		Tags:                         draft.Tags,
		RepeatReminderEnabled:        draft.RepeatReminderEnabled,
		RepeatReminderInterval:       draft.RepeatReminderInterval,
		RepeatReminderWindow:         draft.RepeatReminderWindow,
		Confidence:                   draft.Confidence,
		Warnings:                     warnings,
	}
	if price, ok, valid := parseAIGeneratedNumber(draft.Price); ok {
		amount, err := canonicalMoneyFromFloat(price)
		if err != nil {
			recognized.Warnings = append(recognized.Warnings, "AI_WARNING_PRICE_INVALID")
		} else {
			recognized.Price = &amount
		}
	} else if !valid {
		recognized.Warnings = append(recognized.Warnings, "AI_WARNING_PRICE_INVALID")
	}
	recognized.CustomDays = parseAIGeneratedPositiveInt(draft.CustomDays, maxReminderDays, "AI_WARNING_CUSTOM_DAYS_INVALID", &recognized.Warnings)
	recognized.OneTimeTermCount = parseAIGeneratedPositiveInt(draft.OneTimeTermCount, maxReminderDays, "AI_WARNING_ONE_TIME_TERM_COUNT_INVALID", &recognized.Warnings)
	recognized.ReminderDays = parseAIGeneratedBoundedInt(draft.ReminderDays, disabledReminderDays, maxReminderDays, "AI_WARNING_REMINDER_DAYS_INVALID", &recognized.Warnings)
	return recognized
}

func aiGeneratedSuggestedToSuggestedField(field *aiGeneratedSuggestedTextField) *aiSuggestedTextField {
	if field == nil || field.Value == nil {
		return nil
	}
	value := strings.TrimSpace(*field.Value)
	if value == "" {
		return nil
	}
	source := strings.TrimSpace(field.Source)
	if source != "input" && source != "suggested" {
		source = "suggested"
	}
	return &aiSuggestedTextField{Value: value, Source: source}
}

func aiGeneratedNotesToSuggestedField(field *aiGeneratedNotesField) *aiSuggestedTextField {
	if field == nil || field.Source == "none" || field.Value == nil {
		return nil
	}
	source := strings.TrimSpace(field.Source)
	if source != "input" && source != "suggested" {
		source = "suggested"
	}
	return &aiSuggestedTextField{Value: *field.Value, Source: source}
}

func normalizeAIRecognizeResponse(raw aiRecognizeResponse, providerType string, transportProtocol string, model string, configContext aiRecognitionConfigContext) (aiRecognizeResponse, error) {
	raw.ProviderType = providerType
	raw.TransportProtocol = transportProtocol
	raw.Model = model
	raw.Warnings = compactAIWarnings(raw.Warnings, 20)
	if len(raw.Subscriptions) > aiRecognitionMaxSubscriptions {
		// 截断发生在导入草稿边界；超过预算的模型输出不能让 preview/apply 处理无界列表。
		raw.Subscriptions = raw.Subscriptions[:aiRecognitionMaxSubscriptions]
		raw.Warnings = append(raw.Warnings, "AI_WARNING_TOO_MANY_SUBSCRIPTIONS_TRUNCATED")
	}
	subscriptions := make([]aiRecognizedSubscriptionDraft, 0, len(raw.Subscriptions))
	for _, draft := range raw.Subscriptions {
		normalized, ok := normalizeAISubscriptionDraft(draft, configContext)
		if ok {
			subscriptions = append(subscriptions, normalized)
		} else {
			raw.Warnings = append(raw.Warnings, "AI_WARNING_EMPTY_SUBSCRIPTION_SKIPPED")
		}
	}
	raw.Subscriptions = subscriptions
	raw.Warnings = compactAIWarnings(raw.Warnings, 20)
	if len(raw.Subscriptions) == 0 {
		return raw, errAIRecognitionNoSubscriptions
	}
	return raw, nil
}

func normalizeAISubscriptionDraft(draft aiRecognizedSubscriptionDraft, configContext aiRecognitionConfigContext) (aiRecognizedSubscriptionDraft, bool) {
	draft.Name = trimMax(draft.Name, 120)
	if draft.Name == "" {
		return draft, false
	}
	draft.Warnings = compactAIWarnings(draft.Warnings, 12)
	if draft.Price != nil {
		amount, err := canonicalMoneyString(*draft.Price)
		if err != nil {
			draft.Price = nil
			draft.Warnings = append(draft.Warnings, "AI_WARNING_PRICE_INVALID")
		} else {
			draft.Price = &amount
		}
	}
	draft.Currency = normalizeAIOptionalCurrency(draft.Currency, &draft.Warnings)
	draft.BillingCycle = normalizeAIOptionalEnum(draft.BillingCycle, isValidBillingCycle, "AI_WARNING_BILLING_CYCLE_INVALID", &draft.Warnings)
	draft.CustomCycleUnit = normalizeAIOptionalEnum(draft.CustomCycleUnit, isValidCustomCycleUnit, "AI_WARNING_CUSTOM_CYCLE_UNIT_INVALID", &draft.Warnings)
	draft.OneTimeTermUnit = normalizeAIOptionalEnum(draft.OneTimeTermUnit, isValidCustomCycleUnit, "AI_WARNING_ONE_TIME_TERM_UNIT_INVALID", &draft.Warnings)
	draft.Category = normalizeAIConfigValue(draft.Category, configContext.Categories)
	draft.Status = normalizeAIOptionalEnum(draft.Status, isValidSubscriptionStatus, "AI_WARNING_STATUS_INVALID", &draft.Warnings)
	draft.PaymentMethod = normalizeAIConfigValue(draft.PaymentMethod, configContext.PaymentMethods)
	draft.StartDate = normalizeAIOptionalDate(draft.StartDate, "startDate", &draft.Warnings)
	draft.NextBillingDate = normalizeAIOptionalDate(draft.NextBillingDate, "nextBillingDate", &draft.Warnings)
	draft.TrialEndDate = normalizeAIOptionalDate(draft.TrialEndDate, "trialEndDate", &draft.Warnings)
	draft.Website = normalizeAISuggestedField(draft.Website, 5000)
	draft.Notes = normalizeAINotesField(draft.Notes, 5000)
	draft.Tags = normalizeAITags(draft.Tags, draft.Name, configContext.Tags)
	if draft.ReminderDays != nil && (*draft.ReminderDays < disabledReminderDays || *draft.ReminderDays > maxReminderDays) {
		draft.ReminderDays = nil
		draft.Warnings = append(draft.Warnings, "AI_WARNING_REMINDER_DAYS_INVALID")
	}
	draft.RepeatReminderInterval = normalizeAIOptionalEnum(draft.RepeatReminderInterval, isValidRepeatReminderInterval, "AI_WARNING_REPEAT_INTERVAL_INVALID", &draft.Warnings)
	draft.RepeatReminderWindow = normalizeAIOptionalEnum(draft.RepeatReminderWindow, isValidRepeatReminderWindow, "AI_WARNING_REPEAT_WINDOW_INVALID", &draft.Warnings)
	if draft.Confidence != "high" {
		draft.Confidence = "low"
	}
	draft.Warnings = compactAIWarnings(draft.Warnings, 12)
	return draft, true
}

func normalizeAIOptionalEnum(value *string, valid func(string) bool, warning string, warnings *[]string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	if !valid(trimmed) {
		*warnings = append(*warnings, warning)
		return nil
	}
	return &trimmed
}

func normalizeAIOptionalCurrency(value *string, warnings *[]string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.ToUpper(strings.TrimSpace(*value))
	if trimmed == "" {
		return nil
	}
	switch trimmed {
	case "元", "人民币", "RMB", "YUAN", "￥", "¥":
		trimmed = "CNY"
	}
	if !aiCurrencyPattern.MatchString(trimmed) {
		*warnings = append(*warnings, "AI_WARNING_CURRENCY_INVALID")
		return nil
	}
	return &trimmed
}

func normalizeAIOptionalDate(value *string, field string, warnings *[]string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	if !isValidDateOnly(trimmed) {
		*warnings = append(*warnings, "AI_WARNING_DATE_INVALID:"+field)
		return nil
	}
	return &trimmed
}

func normalizeAISuggestedField(field *aiSuggestedTextField, maxLen int) *aiSuggestedTextField {
	if field == nil {
		return nil
	}
	value := trimMax(field.Value, maxLen)
	if value == "" {
		return nil
	}
	source := strings.TrimSpace(field.Source)
	if source != "input" && source != "suggested" {
		source = "suggested"
	}
	return &aiSuggestedTextField{Value: value, Source: source}
}

func normalizeAITags(tags []string, subscriptionName string, existingTags []string) []string {
	out := []string{}
	seen := map[string]bool{}
	existing := aiRecognitionExistingTagMap(existingTags)
	serviceKey := aiRecognitionTagMatchKey(subscriptionName)
	for _, tag := range tags {
		value := trimMax(tag, 40)
		key := aiRecognitionTagMatchKey(value)
		if value == "" || seen[key] {
			continue
		}
		if existingValue, ok := existing[key]; ok {
			value = existingValue
		} else if !isUsefulAIGeneratedTag(value, key, serviceKey) {
			continue
		}
		// AI 生成标签只允许稳定复用维度；价格、地区、套餐等一次性属性不能污染用户长期筛选。
		seen[key] = true
		out = append(out, value)
		if len(out) >= 3 {
			break
		}
	}
	return out
}

func aiRecognitionExistingTagMap(tags []string) map[string]string {
	out := map[string]string{}
	for _, tag := range tags {
		value := trimMax(tag, 40)
		key := aiRecognitionTagMatchKey(value)
		if key != "" {
			if _, exists := out[key]; !exists {
				out[key] = value
			}
		}
	}
	return out
}

func aiRecognitionTagMatchKey(value string) string {
	return aiRecognitionConfigMatchKey(value)
}

func isUsefulAIGeneratedTag(value string, key string, serviceKey string) bool {
	if key == "" || (serviceKey != "" && key == serviceKey) {
		return false
	}
	runeCount := len([]rune(value))
	if runeCount < 2 || runeCount > 20 {
		return false
	}
	lower := strings.ToLower(strings.TrimSpace(value))
	if strings.Contains(lower, "://") || strings.HasPrefix(lower, "www.") || strings.ContainsAny(value, "#()（）[]【】/\\|:：") {
		return false
	}
	if aiNumberPattern.MatchString(value) || aiRecognitionLooksLikeBillingTag(lower) || aiRecognitionLooksLikeOrderAttributeTag(lower) {
		return false
	}
	if aiRecognitionIsShortHanTag(value) {
		return false
	}
	return true
}

func aiRecognitionLooksLikeBillingTag(value string) bool {
	for _, fragment := range []string{"usd", "cny", "rmb", "eur", "gbp", "jpy", "¥", "￥", "$", "月", "年", "weekly", "monthly", "annual", "账单", "价格", "付款", "支付", "扣费", "续费"} {
		if strings.Contains(value, fragment) {
			return true
		}
	}
	return false
}

func aiRecognitionLooksLikeOrderAttributeTag(value string) bool {
	for _, fragment := range []string{"special", "promo", "promotion", "plan", "套餐", "促销", "机房", "节点", "区域", "地区", "线路", "location", "region", "datacenter"} {
		if strings.Contains(value, fragment) {
			return true
		}
	}
	return false
}

func aiRecognitionIsShortHanTag(value string) bool {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > 2 {
		return false
	}
	for _, r := range runes {
		if !unicode.Is(unicode.Han, r) {
			return false
		}
	}
	return len(runes) > 0
}

func compactAIWarnings(warnings []string, maxCount int) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, warning := range warnings {
		value := trimMax(warning, 240)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
		if len(out) >= maxCount {
			break
		}
	}
	return out
}

func trimOptionalString(value *string, maxLen int) *string {
	if value == nil {
		return nil
	}
	trimmed := trimMax(*value, maxLen)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func normalizeAIConfigValue(value *string, options []aiRecognitionConfigOption) *string {
	trimmed := trimOptionalString(value, 80)
	if trimmed == nil {
		return nil
	}
	if matched := findAIRecognitionConfigOption(options, *trimmed); matched != nil {
		value := matched.Value
		return &value
	}
	return trimmed
}

func findAIRecognitionConfigOption(options []aiRecognitionConfigOption, text string) *aiRecognitionConfigOption {
	key := aiRecognitionConfigMatchKey(text)
	if key == "" {
		return nil
	}
	for index := range options {
		option := &options[index]
		if aiRecognitionConfigMatchKey(option.Value) == key ||
			aiRecognitionConfigMatchKey(option.Label) == key ||
			aiRecognitionConfigMatchKey(option.ZhCN) == key ||
			aiRecognitionConfigMatchKey(option.EnUS) == key {
			return option
		}
	}
	return nil
}

func aiRecognitionConfigMatchKey(value string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if unicode.IsSpace(r) || strings.ContainsRune("_-—–/\\|&+，,、.。:：()（）[]【】", r) {
			continue
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

func trimMax(value string, maxLen int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > maxLen {
		runes = runes[:maxLen]
	}
	return string(runes)
}

func safeAIRecognitionError(err error) error {
	if err == nil {
		return nil
	}
	message := redactAIRecognitionSecrets(err.Error())
	if len([]rune(message)) > 500 {
		message = string([]rune(message)[:500])
	}
	return errors.New(message)
}

func safeAIRecognitionProviderMessage(err error) *string {
	if err == nil {
		return nil
	}
	message := safeAIRecognitionError(err).Error()
	return &message
}

func redactAIRecognitionSecrets(value string) string {
	return aiSecretPattern.ReplaceAllString(value, "[redacted]")
}

func normalizeAIGeneratedCurrency(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	upper := strings.ToUpper(trimmed)
	switch upper {
	case "元", "人民币", "RMB", "YUAN", "￥", "¥":
		upper = "CNY"
	}
	return &upper
}

func normalizeAIGeneratedBillingCycle(value *string) *string {
	if value == nil {
		return nil
	}
	text := strings.ToLower(strings.TrimSpace(*value))
	if text == "" || isValidBillingCycle(text) {
		if text == "" {
			return nil
		}
		return &text
	}
	compact := strings.Join(strings.Fields(text), "")
	var mapped string
	switch {
	case strings.Contains(compact, "week") || strings.Contains(compact, "周"):
		mapped = "weekly"
	case strings.Contains(compact, "quarter") || strings.Contains(compact, "季"):
		mapped = "quarterly"
	case strings.Contains(compact, "semi") || strings.Contains(compact, "half") || strings.Contains(compact, "半年"):
		mapped = "semi-annual"
	case strings.Contains(compact, "year") || strings.Contains(compact, "annual") || strings.Contains(compact, "年"):
		mapped = "annual"
	case strings.Contains(compact, "month") || strings.Contains(compact, "月"):
		mapped = "monthly"
	case strings.Contains(compact, "one-time") || strings.Contains(compact, "lifetime") || strings.Contains(compact, "一次") || strings.Contains(compact, "买断"):
		mapped = "one-time"
	}
	if mapped == "" {
		return value
	}
	return &mapped
}

func parseAIGeneratedPositiveInt(value interface{}, max int, warning string, warnings *[]string) *int {
	parsed, ok, valid := parseAIGeneratedInt(value)
	if !ok {
		if !valid {
			*warnings = append(*warnings, warning)
		}
		return nil
	}
	if parsed <= 0 || parsed > max {
		*warnings = append(*warnings, warning)
		return nil
	}
	return &parsed
}

func parseAIGeneratedBoundedInt(value interface{}, min int, max int, warning string, warnings *[]string) *int {
	parsed, ok, valid := parseAIGeneratedInt(value)
	if !ok {
		if !valid {
			*warnings = append(*warnings, warning)
		}
		return nil
	}
	if parsed < min || parsed > max {
		*warnings = append(*warnings, warning)
		return nil
	}
	return &parsed
}

func parseAIGeneratedInt(value interface{}) (int, bool, bool) {
	number, ok, valid := parseAIGeneratedNumber(value)
	if !ok {
		return 0, false, valid
	}
	return int(number), true, true
}

func parseAIGeneratedNumber(value interface{}) (float64, bool, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, false, true
	case float64:
		return typed, true, true
	case float32:
		return float64(typed), true, true
	case int:
		return float64(typed), true, true
	case int64:
		return float64(typed), true, true
	case string:
		text := strings.ReplaceAll(strings.TrimSpace(typed), ",", "")
		if text == "" {
			return 0, false, true
		}
		match := aiNumberPattern.FindString(text)
		if match == "" {
			return 0, false, false
		}
		parsed, err := strconv.ParseFloat(match, 64)
		if err != nil {
			return 0, false, false
		}
		return parsed, true, true
	default:
		return 0, false, false
	}
}

func isAIRecognitionSchemaMismatchError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(aiRecognitionCauseError(err).Error())
	return strings.Contains(message, "no object generated") ||
		strings.Contains(message, "did not match schema") ||
		strings.Contains(message, "schema validation") ||
		strings.Contains(message, "invalid object") ||
		strings.Contains(message, "parsing structured output") ||
		strings.Contains(message, "cannot unmarshal")
}
