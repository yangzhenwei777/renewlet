package main

// ai_recognition.go 定义 Docker/Go 运行面的 AI 识别 API 边界。
//
// 路由只返回结构化草稿和脱敏 diagnostics，不直接写 subscriptions；前端必须继续走 import preview/apply，
// 让冲突处理、Logo 分配和服务端持久层校验复用同一条导入链路。
import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	aiRecognitionMaxTextChars        = 30000
	aiRecognitionMaxImages           = 5
	aiRecognitionMaxImageBytes       = 5 * 1024 * 1024
	aiRecognitionMaxSubscriptions    = 100
	aiRecognitionMultipartOverhead   = 1 << 20
	aiRecognitionThinkingControlMax  = 8 << 10
	aiRecognitionProviderTimeout     = 90 * time.Second
	aiRecognitionMaxProviderResponse = 12000
	aiRecognitionTestProviderTokens  = 16
	aiRecognitionTestPrompt          = "Reply with OK."
	aiRecognitionMaxPromptTags       = 200
	aiRecognitionPromptTagPageSize   = 200
)

var (
	errAIRecognitionBodyTooLarge    = errors.New("AI_RECOGNITION_BODY_TOO_LARGE")
	errAIRecognitionInputEmpty      = errors.New("AI_RECOGNITION_INPUT_EMPTY")
	errAIRecognitionNoSubscriptions = errors.New("AI_RECOGNITION_NO_SUBSCRIPTIONS")
	errAIRecognitionProviderInvalid = errors.New("AI_PROVIDER_INVALID")
	errAIRecognitionEmptyObject     = errors.New("AI_RECOGNITION_EMPTY_OBJECT")
)

type aiRecognitionSettings struct {
	ProviderType           string             `json:"providerType"`
	TransportProtocol      string             `json:"transportProtocol"`
	Model                  string             `json:"model"`
	ModelInputMode         string             `json:"modelInputMode"`
	BaseURL                string             `json:"baseUrl"`
	APIKey                 string             `json:"apiKey"`
	DefaultThinkingControl *aiThinkingControl `json:"defaultThinkingControl"`
}

type aiThinkingControl struct {
	Provider     string `json:"provider"`
	Effort       string `json:"effort,omitempty"`
	Mode         string `json:"mode,omitempty"`
	Budget       *int   `json:"budget,omitempty"`
	Level        string `json:"level,omitempty"`
	BudgetTokens *int   `json:"budgetTokens,omitempty"`
}

type aiRecognitionInput struct {
	Text            string
	Images          []aiRecognitionImage
	ThinkingControl *aiThinkingControl
	MaxOutputTokens int
}

type aiRecognitionImage struct {
	MediaType string
	DataURL   string
	SizeBytes int
}

type aiRecognizeResponse struct {
	ProviderType      string                          `json:"providerType"`
	TransportProtocol string                          `json:"transportProtocol"`
	Model             string                          `json:"model"`
	Subscriptions     []aiRecognizedSubscriptionDraft `json:"subscriptions"`
	Warnings          []string                        `json:"warnings"`
	Diagnostics       aiRecognitionDiagnostics        `json:"diagnostics"`
}

type aiRecognizedSubscriptionDraft struct {
	Name                         string                `json:"name"`
	Price                        *string               `json:"price"`
	Currency                     *string               `json:"currency"`
	BillingCycle                 *string               `json:"billingCycle"`
	CustomDays                   *int                  `json:"customDays"`
	CustomCycleUnit              *string               `json:"customCycleUnit"`
	OneTimeTermCount             *int                  `json:"oneTimeTermCount"`
	OneTimeTermUnit              *string               `json:"oneTimeTermUnit"`
	Category                     *string               `json:"category"`
	Status                       *string               `json:"status"`
	PaymentMethod                *string               `json:"paymentMethod"`
	StartDate                    *string               `json:"startDate"`
	NextBillingDate              *string               `json:"nextBillingDate"`
	AutoCalculateNextBillingDate *bool                 `json:"autoCalculateNextBillingDate"`
	TrialEndDate                 *string               `json:"trialEndDate"`
	Website                      *aiSuggestedTextField `json:"website"`
	Notes                        *aiSuggestedTextField `json:"notes"`
	Tags                         []string              `json:"tags"`
	ReminderDays                 *int                  `json:"reminderDays"`
	RepeatReminderEnabled        *bool                 `json:"repeatReminderEnabled"`
	RepeatReminderInterval       *string               `json:"repeatReminderInterval"`
	RepeatReminderWindow         *string               `json:"repeatReminderWindow"`
	Confidence                   string                `json:"confidence"`
	Warnings                     []string              `json:"warnings"`
}

type aiSuggestedTextField struct {
	Value  string `json:"value"`
	Source string `json:"source"`
}

type aiRecognitionPublicSettings struct {
	ProviderType           string             `json:"providerType"`
	TransportProtocol      string             `json:"transportProtocol"`
	Model                  string             `json:"model"`
	ModelInputMode         string             `json:"modelInputMode"`
	BaseURL                string             `json:"baseUrl"`
	DefaultThinkingControl *aiThinkingControl `json:"defaultThinkingControl"`
}

type aiRecognitionTestRequest struct {
	Settings aiRecognitionPublicSettings `json:"settings"`
	APIKey   settingsSecretMutation      `json:"apiKey"`
}

func (r *aiRecognitionTestRequest) Validate(locale appLocale) error {
	r.Settings.ProviderType = strings.TrimSpace(r.Settings.ProviderType)
	if !isValidAIRecognitionProviderType(r.Settings.ProviderType) {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.Settings.BaseURL != "" && sanitizeAIRecognitionBaseURL(r.Settings.BaseURL) == "" {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.Settings.DefaultThinkingControl != nil {
		if err := validateAIThinkingControl(r.Settings.DefaultThinkingControl); err != nil {
			return err
		}
	}
	return r.APIKey.Validate(locale)
}

type aiRecognitionTestResponse struct {
	ProviderType      string `json:"providerType"`
	TransportProtocol string `json:"transportProtocol"`
	Model             string `json:"model"`
}

type aiRecognitionErrorDetails struct {
	RawResponseText *string `json:"rawResponseText,omitempty"`
}

type aiRecognitionRunner interface {
	Recognize(ctx context.Context, settings aiRecognitionSettings, input aiRecognitionInput, locale appLocale, timezone string, defaultCurrency string, configContext aiRecognitionConfigContext) (aiRecognizeResponse, error)
	Stream(ctx context.Context, settings aiRecognitionSettings, input aiRecognitionInput, locale appLocale, timezone string, defaultCurrency string, configContext aiRecognitionConfigContext, sink aiRecognitionStreamSink) error
}

type goaiRecognitionRunner struct{}

var defaultAIRecognitionRunner aiRecognitionRunner = goaiRecognitionRunner{}

type aiRecognitionRunContext struct {
	Locale        appLocale
	Settings      appSettings
	AISettings    aiRecognitionSettings
	Input         aiRecognitionInput
	ConfigContext aiRecognitionConfigContext
}

func prepareAIRecognitionRunContext(app core.App, e *core.RequestEvent) (aiRecognitionRunContext, error) {
	locale := requestLocale(e.Request)
	if e.Auth == nil {
		return aiRecognitionRunContext{}, e.UnauthorizedError(serverText(locale, "auth.loginRequired"), nil)
	}
	if err := demoModePolicy.RejectExternalSideEffect(e); err != nil {
		return aiRecognitionRunContext{}, err
	}
	settings, err := currentUserSettings(app, e.Auth)
	if err != nil {
		return aiRecognitionRunContext{}, e.BadRequestError(validationErrorMessage(locale, "notification.settingsInvalid", err), err)
	}
	input, err := readAIRecognitionMultipart(e, locale)
	if err != nil {
		if errors.Is(err, errAIRecognitionBodyTooLarge) {
			return aiRecognitionRunContext{}, apiErrorJSON(e, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE", serverText(locale, "common.requestBodyTooLarge"), nil)
		}
		if errors.Is(err, errAIRecognitionInputEmpty) {
			return aiRecognitionRunContext{}, e.BadRequestError(serverText(locale, "aiRecognition.inputRequired"), err)
		}
		if strings.Contains(err.Error(), "AI_RECOGNITION_IMAGE_TYPE_INVALID") {
			return aiRecognitionRunContext{}, e.BadRequestError(serverText(locale, "aiRecognition.imageTypeInvalid"), err)
		}
		return aiRecognitionRunContext{}, e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	aiSettings := sanitizeAIRecognitionSettings(settings.AIRecognition)
	if input.ThinkingControl != nil && !aiThinkingControlMatchesSettings(aiSettings, input.ThinkingControl) {
		// thinking control 绑定 provider；切换模型后旧 control 不能继续沿用，否则第三方会拒绝请求。
		return aiRecognitionRunContext{}, e.BadRequestError(serverText(locale, "aiRecognition.thinkingProviderMismatch"), nil)
	}
	if err := validateAIRecognitionSettings(aiSettings, locale); err != nil {
		return aiRecognitionRunContext{}, e.BadRequestError(err.Error(), err)
	}
	// 配置项只作为模型上下文和响应归一化依据；新增分类/支付方式仍必须走 import preview/apply 用户确认链路。
	configContext, err := aiRecognitionConfigContextForUser(app, e.Auth.Id, locale)
	if err != nil {
		return aiRecognitionRunContext{}, e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return aiRecognitionRunContext{Locale: locale, Settings: settings, AISettings: aiSettings, Input: input, ConfigContext: configContext}, nil
}

func handleAIRecognizeSubscriptions(app core.App, e *core.RequestEvent) error {
	runContext, err := prepareAIRecognitionRunContext(app, e)
	if err != nil {
		return err
	}
	response, err := defaultAIRecognitionRunner.Recognize(
		e.Request.Context(),
		runContext.AISettings,
		runContext.Input,
		runContext.Locale,
		runContext.Settings.Timezone,
		runContext.Settings.DefaultCurrency,
		runContext.ConfigContext,
	)
	if err != nil {
		if diagnostics := aiRecognitionDiagnosticsFromError(err); diagnostics != nil {
			// 错误响应只回显 provider raw 文本；成功态 diagnostics 仍由正常响应返回，不混入错误详情。
			if errors.Is(err, errAIRecognitionNoSubscriptions) {
				return aiRecognitionJSONError(e, http.StatusBadRequest, serverText(runContext.Locale, "aiRecognition.noSubscriptions"), "AI_RECOGNITION_EMPTY", "empty", nil, diagnostics)
			}
			if isAIRecognitionSchemaMismatchError(err) {
				return aiRecognitionJSONError(e, http.StatusBadRequest, serverText(runContext.Locale, "aiRecognition.schemaMismatch"), "AI_RECOGNITION_SCHEMA_MISMATCH", "schema_mismatch", aiRecognitionCauseError(err), diagnostics)
			}
			return aiRecognitionJSONError(e, http.StatusBadRequest, serverText(runContext.Locale, "aiRecognition.failed"), "AI_RECOGNITION_FAILED", "provider_failed", aiRecognitionCauseError(err), diagnostics)
		}
		if errors.Is(err, errAIRecognitionNoSubscriptions) {
			return e.BadRequestError(serverText(runContext.Locale, "aiRecognition.noSubscriptions"), nil)
		}
		if isAIRecognitionSchemaMismatchError(err) {
			return e.BadRequestError(serverText(runContext.Locale, "aiRecognition.schemaMismatch"), nil)
		}
		if providerResponse := aiProviderResponseFromError(err); providerResponse != nil {
			return aiRecognitionProviderResponseJSONError(e, http.StatusBadRequest, serverText(runContext.Locale, "aiRecognition.failed"), "AI_RECOGNITION_FAILED", "provider_failed", err, providerResponse)
		}
		return e.BadRequestError(serverText(runContext.Locale, "aiRecognition.failed"), safeAIRecognitionError(err))
	}
	return apiSuccessJSON(e, http.StatusOK, response)
}

func handleAIRecognitionTestConnection(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if e.Auth == nil {
		return e.UnauthorizedError(serverText(locale, "auth.loginRequired"), nil)
	}
	if err := demoModePolicy.RejectExternalSideEffect(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[aiRecognitionTestRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := body.Validate(locale); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidPayload", err), err)
	}
	current, err := currentUserSettings(app, e.Auth)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	apiKey, err := resolveSettingsSecretMutation(body.APIKey, current.AIRecognition.APIKey, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	settings := sanitizeAIRecognitionSettings(aiRecognitionSettings{
		ProviderType:           body.Settings.ProviderType,
		TransportProtocol:      body.Settings.TransportProtocol,
		Model:                  body.Settings.Model,
		ModelInputMode:         body.Settings.ModelInputMode,
		BaseURL:                body.Settings.BaseURL,
		APIKey:                 apiKey,
		DefaultThinkingControl: body.Settings.DefaultThinkingControl,
	})
	if err := validateAIRecognitionSettings(settings, locale); err != nil {
		return e.BadRequestError(err.Error(), err)
	}
	err = testAIRecognitionConnection(e.Request.Context(), settings)
	if err != nil {
		// 连接测试只做一次最小文本生成；SDK 暴露的 provider body 只进入本次错误响应的 rawResponseText。
		return aiRecognitionProviderResponseJSONError(e, http.StatusBadRequest, serverText(locale, "aiRecognition.testFailed"), "AI_RECOGNITION_TEST_FAILED", "provider_failed", err, aiProviderResponseFromError(err))
	}
	return apiSuccessJSON(e, http.StatusOK, aiRecognitionTestResponse{ProviderType: settings.ProviderType, TransportProtocol: settings.TransportProtocol, Model: settings.Model})
}

func aiRecognitionConfigContextForUser(app core.App, userID string, locale appLocale) (aiRecognitionConfigContext, error) {
	tags, err := aiRecognitionExistingTagsForUser(app, userID)
	if err != nil {
		return aiRecognitionConfigContext{}, err
	}
	record, err := app.FindFirstRecordByFilter("custom_configs", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return aiRecognitionConfigContext{Tags: tags}, nil
		}
		return aiRecognitionConfigContext{}, err
	}
	if record == nil {
		return aiRecognitionConfigContext{Tags: tags}, nil
	}
	config, err := customConfigFromValue(record.Get("config"))
	if err != nil {
		return aiRecognitionConfigContext{}, err
	}
	if err := normalizeCustomConfigPayload(&config); err != nil {
		return aiRecognitionConfigContext{}, err
	}
	return aiRecognitionConfigContext{
		Categories:     aiRecognitionConfigOptions(config.Categories, locale),
		PaymentMethods: aiRecognitionConfigOptions(config.PaymentMethods, locale),
		Tags:           tags,
	}, nil
}

func aiRecognitionExistingTagsForUser(app core.App, userID string) ([]string, error) {
	// 这些标签名会进入第三方 AI prompt；只传用户已经持久化的标签文本，不带历史订阅名称、金额或备注。
	tags := []string{}
	seen := map[string]bool{}
	for offset := 0; len(tags) < aiRecognitionMaxPromptTags; offset += aiRecognitionPromptTagPageSize {
		rows, err := app.FindRecordsByFilter("subscriptions", "user = {:user}", "-created", aiRecognitionPromptTagPageSize, offset, dbx.Params{"user": userID})
		if err != nil {
			return nil, err
		}
		for _, record := range rows {
			values, err := normalizeTags(record.Get("tags"))
			if err != nil {
				continue
			}
			for _, tag := range values {
				key := strings.ToLower(strings.TrimSpace(tag))
				if key == "" || seen[key] {
					continue
				}
				seen[key] = true
				tags = append(tags, tag)
				if len(tags) >= aiRecognitionMaxPromptTags {
					return tags, nil
				}
			}
		}
		if len(rows) < aiRecognitionPromptTagPageSize {
			break
		}
	}
	return tags, nil
}

func aiRecognitionConfigOptions(items []customConfigItem, locale appLocale) []aiRecognitionConfigOption {
	out := make([]aiRecognitionConfigOption, 0, len(items))
	for _, item := range items {
		out = append(out, aiRecognitionConfigOption{
			Value: item.Value,
			Label: localizedAIRecognitionConfigLabel(item.Labels, locale),
			ZhCN:  item.Labels.ZhCN,
			EnUS:  item.Labels.EnUS,
		})
	}
	return out
}

func localizedAIRecognitionConfigLabel(labels customConfigLabels, locale appLocale) string {
	if locale == localeEnUS && labels.EnUS != "" {
		return labels.EnUS
	}
	if labels.ZhCN != "" {
		return labels.ZhCN
	}
	return labels.EnUS
}

func aiRecognitionJSONError(e *core.RequestEvent, status int, message string, code string, reason string, err error, _ *aiRecognitionDiagnostics) error {
	return apiErrorJSON(e, status, code, message, aiRecognitionErrorDetails{
		RawResponseText: optionalUpstreamBody(firstNonBlank(upstreamRawResponseTextFromError(err), aiProviderResponseBody(aiProviderResponseFromError(err)), optionalStringValue(safeAIRecognitionProviderMessage(err)), reason)),
	})
}

func aiRecognitionProviderResponseJSONError(e *core.RequestEvent, status int, message string, code string, reason string, err error, providerResponse *aiProviderResponse) error {
	return apiErrorJSON(e, status, code, message, map[string]interface{}{
		"rawResponseText": firstNonBlank(upstreamRawResponseTextFromError(err), aiProviderResponseBody(providerResponse), optionalStringValue(safeAIRecognitionProviderMessage(err)), reason),
	})
}
