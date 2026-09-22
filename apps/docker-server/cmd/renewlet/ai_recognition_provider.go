package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/zendev-sh/goai"
	"github.com/zendev-sh/goai/provider"
	"github.com/zendev-sh/goai/provider/anthropic"
	"github.com/zendev-sh/goai/provider/compat"
	"github.com/zendev-sh/goai/provider/google"
	"github.com/zendev-sh/goai/provider/openai"
)

type aiRecognitionGeneration struct {
	result  *goai.ObjectResult[aiGeneratedRecognizeResponse]
	capture aiRecognitionCapture
}

var generateAIRecognitionObjectForRunner = generateAIRecognitionObject
var streamAIRecognitionObjectForRunner = streamAIRecognitionObject
var newAIRecognitionModelForConnection = newAIRecognitionModel

func (goaiRecognitionRunner) Recognize(
	ctx context.Context,
	settings aiRecognitionSettings,
	input aiRecognitionInput,
	locale appLocale,
	timezone string,
	defaultCurrency string,
	configContext aiRecognitionConfigContext,
) (aiRecognizeResponse, error) {
	if err := validateAIRecognitionSettings(settings, locale); err != nil {
		return aiRecognizeResponse{}, err
	}
	model, err := newAIRecognitionModel(settings)
	if err != nil {
		return aiRecognizeResponse{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, aiRecognitionProviderTimeout)
	defer cancel()

	systemPrompt := buildAIRecognitionSystemPrompt()
	userPrompt := buildAIRecognitionUserPrompt(input.Text, timezone, defaultCurrency, len(input.Images), locale, configContext)
	generateForPrompt := func(nextUserPrompt string) (aiRecognitionGeneration, error) {
		return generateAIRecognitionObjectForRunner(ctx, model, input, systemPrompt, nextUserPrompt)
	}
	generation, err := generateForPrompt(userPrompt)
	if err != nil {
		if generation.capture.rawModelText == "" {
			generation.capture.rawModelText = aiRecognitionRawTextFromError(err)
		}
		if recovered, ok := recoverAIRecognitionGenerationFromRawText(generation.capture.rawModelText, generation.capture); ok {
			generation = recovered
		} else {
			diagnostics := buildAIRecognitionDiagnostics(settings, input, systemPrompt, userPrompt, generation.capture.rawModelText, nil, generation.capture.usage, generation.capture.finishReason, generation.capture.providerMetadata)
			return aiRecognizeResponse{}, &aiRecognitionRunError{cause: err, diagnostics: diagnostics}
		}
	}
	return finalizeAIRecognitionGeneration(settings, input, locale, configContext, systemPrompt, userPrompt, generation, nil, generateForPrompt)
}

func (goaiRecognitionRunner) Stream(
	ctx context.Context,
	settings aiRecognitionSettings,
	input aiRecognitionInput,
	locale appLocale,
	timezone string,
	defaultCurrency string,
	configContext aiRecognitionConfigContext,
	sink aiRecognitionStreamSink,
) error {
	if err := validateAIRecognitionSettings(settings, locale); err != nil {
		return err
	}
	model, err := newAIRecognitionModel(settings)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, aiRecognitionProviderTimeout)
	defer cancel()

	systemPrompt := buildAIRecognitionSystemPrompt()
	userPrompt := buildAIRecognitionUserPrompt(input.Text, timezone, defaultCurrency, len(input.Images), locale, configContext)
	if err := sink.Progress(aiRecognitionStreamStageModelStart); err != nil {
		return err
	}
	generateForPrompt := func(nextUserPrompt string) (aiRecognitionGeneration, error) {
		return streamAIRecognitionObjectForRunner(ctx, model, input, systemPrompt, nextUserPrompt, sink)
	}
	generation, err := generateForPrompt(userPrompt)
	if err != nil {
		if generation.capture.rawModelText == "" {
			generation.capture.rawModelText = aiRecognitionRawTextFromError(err)
		}
		if recovered, ok := recoverAIRecognitionGenerationFromRawText(generation.capture.rawModelText, generation.capture); ok {
			generation = recovered
		} else {
			diagnostics := buildAIRecognitionDiagnostics(settings, input, systemPrompt, userPrompt, generation.capture.rawModelText, nil, generation.capture.usage, generation.capture.finishReason, generation.capture.providerMetadata)
			return &aiRecognitionRunError{cause: err, diagnostics: diagnostics}
		}
	}
	response, err := finalizeAIRecognitionGeneration(settings, input, locale, configContext, systemPrompt, userPrompt, generation, sink.Progress, generateForPrompt)
	if err != nil {
		return err
	}
	return sink.Final(response)
}

func finalizeAIRecognitionGeneration(settings aiRecognitionSettings, input aiRecognitionInput, locale appLocale, configContext aiRecognitionConfigContext, systemPrompt string, userPrompt string, initialGeneration aiRecognitionGeneration, progress func(string) error, generateForPrompt func(string) (aiRecognitionGeneration, error)) (aiRecognizeResponse, error) {
	generation := initialGeneration
	if progress != nil {
		if err := progress(aiRecognitionStreamStageValidating); err != nil {
			return aiRecognizeResponse{}, err
		}
	}
	diagnostics := buildAIRecognitionDiagnosticsForGeneration(settings, input, systemPrompt, userPrompt, generation)
	response, err := normalizeAIGeneratedRecognizeResponse(generation.result.Object, settings.ProviderType, settings.TransportProtocol, settings.Model, diagnostics, configContext)
	if err != nil {
		return aiRecognizeResponse{}, &aiRecognitionRunError{cause: err, diagnostics: diagnostics}
	}
	if missingNames := missingDescribableAINoteNames(response.Subscriptions); len(missingNames) > 0 {
		if progress != nil {
			if err := progress(aiRecognitionStreamStageRepairStart); err != nil {
				return aiRecognizeResponse{}, err
			}
		}
		repairPrompt := buildAIRecognitionRepairUserPrompt(userPrompt, generation.result.Object, missingNames)
		if repairedGeneration, repairErr := generateForPrompt(repairPrompt); repairErr == nil {
			repairDiagnostics := buildAIRecognitionDiagnosticsForGeneration(settings, input, systemPrompt, repairPrompt, repairedGeneration)
			if repairedResponse, normalizeErr := normalizeAIGeneratedRecognizeResponse(repairedGeneration.result.Object, settings.ProviderType, settings.TransportProtocol, settings.Model, repairDiagnostics, configContext); normalizeErr == nil {
				diagnostics = repairDiagnostics
				response = repairedResponse
			}
		}
		response.Diagnostics = diagnostics
		response = fillMissingAINotesWithDynamicFallback(response, locale, configContext)
	}
	if progress != nil {
		if err := progress(aiRecognitionStreamStageFinalizing); err != nil {
			return aiRecognizeResponse{}, err
		}
	}
	return response, nil
}

func generateAIRecognitionObject(ctx context.Context, model provider.LanguageModel, input aiRecognitionInput, systemPrompt string, userPrompt string) (aiRecognitionGeneration, error) {
	capture := aiRecognitionCapture{}
	result, err := goai.GenerateObject[aiGeneratedRecognizeResponse](ctx, model, aiRecognitionObjectOptions(model, input, systemPrompt, userPrompt, &capture)...)
	if err == nil && result == nil {
		err = errAIRecognitionEmptyObject
	}
	return aiRecognitionGeneration{result: result, capture: capture}, err
}

func streamAIRecognitionObject(ctx context.Context, model provider.LanguageModel, input aiRecognitionInput, systemPrompt string, userPrompt string, sink aiRecognitionStreamSink) (aiRecognitionGeneration, error) {
	capture := aiRecognitionCapture{}
	stream, err := goai.StreamObject[aiGeneratedRecognizeResponse](ctx, model, aiRecognitionObjectOptions(model, input, systemPrompt, userPrompt, &capture)...)
	if err != nil {
		return aiRecognitionGeneration{capture: capture}, err
	}
	streamStarted := false
	lastPartial := aiRecognitionStreamPartialEvent{}
	for partial := range stream.PartialObjectStream() {
		if partial == nil {
			continue
		}
		if !streamStarted {
			streamStarted = true
			if err := sink.Progress(aiRecognitionStreamStageModelStream); err != nil {
				return aiRecognitionGeneration{capture: capture}, err
			}
		}
		subscriptionsSeen := len(partial.Subscriptions)
		warningsSeen := len(partial.Warnings)
		if err := emitAIRecognitionPartialIfChanged(sink, &lastPartial, subscriptionsSeen, warningsSeen); err != nil {
			return aiRecognitionGeneration{capture: capture}, err
		}
	}
	result, err := stream.Result()
	if err == nil && result == nil {
		err = errAIRecognitionEmptyObject
	}
	return aiRecognitionGeneration{result: result, capture: capture}, err
}

func emitAIRecognitionPartialIfChanged(sink aiRecognitionStreamSink, last *aiRecognitionStreamPartialEvent, subscriptionsSeen int, warningsSeen int) error {
	if subscriptionsSeen == 0 && warningsSeen == 0 {
		return nil
	}
	if last.SubscriptionsSeen == subscriptionsSeen && last.WarningsSeen == warningsSeen {
		return nil
	}
	// StreamObject 的 partial 只是进度提示，去重避免 UI 被半成品重复刷屏；最终草稿仍只从 Final 写出。
	last.SubscriptionsSeen = subscriptionsSeen
	last.WarningsSeen = warningsSeen
	return sink.Partial(subscriptionsSeen, warningsSeen)
}

func recoverAIRecognitionGenerationFromRawText(rawModelText string, capture aiRecognitionCapture) (aiRecognitionGeneration, bool) {
	jsonText := extractFirstAIRecognitionJSONObjectText(rawModelText)
	if jsonText == "" {
		return aiRecognitionGeneration{}, false
	}
	var object aiGeneratedRecognizeResponse
	decoder := json.NewDecoder(strings.NewReader(jsonText))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&object); err != nil {
		return aiRecognitionGeneration{}, false
	}
	capture.rawModelText = rawModelText
	// 生成侧恢复只把 AI SDK 拒收的完整 JSON 拉回 normalize；最终 response schema 仍是唯一可信边界。
	return aiRecognitionGeneration{result: &goai.ObjectResult[aiGeneratedRecognizeResponse]{Object: object}, capture: capture}, true
}

func extractFirstAIRecognitionJSONObjectText(text string) string {
	start := strings.IndexByte(text, '{')
	if start < 0 {
		return ""
	}
	depth := 0
	inString := false
	escaped := false
	for index := start; index < len(text); index++ {
		char := text[index]
		if inString {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				inString = false
			}
			continue
		}
		switch char {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return text[start : index+1]
			}
		}
	}
	return ""
}

func aiRecognitionObjectOptions(model provider.LanguageModel, input aiRecognitionInput, systemPrompt string, userPrompt string, capture *aiRecognitionCapture) []goai.Option {
	userParts := []provider.Part{{
		Type: provider.PartText,
		Text: userPrompt,
	}}
	for _, image := range input.Images {
		userParts = append(userParts, provider.Part{
			Type:      provider.PartImage,
			URL:       image.DataURL,
			MediaType: image.MediaType,
			Detail:    "high",
		})
	}
	options := []goai.Option{
		goai.WithSystem(systemPrompt),
		goai.WithMessages(provider.Message{Role: provider.RoleUser, Content: userParts}),
		goai.WithMaxOutputTokens(aiRecognitionOutputTokenLimit(input)),
		goai.WithExplicitSchema(aiRecognitionGeneratedSchema),
		goai.WithSchemaName(aiRecognitionPrompt.SchemaName),
		goai.WithOnStepFinish(func(step goai.StepResult) {
			if capture != nil {
				capture.rawModelText = step.Text
				capture.usage = step.Usage
				capture.finishReason = string(step.FinishReason)
				capture.providerMetadata = step.ProviderMetadata
			}
		}),
	}
	if providerOptions := aiRecognitionProviderOptions(modelProviderType(model), modelTransportProtocol(model), input.ThinkingControl); len(providerOptions) > 0 {
		options = append(options, goai.WithProviderOptions(providerOptions))
	}
	return options
}

func buildAIRecognitionDiagnosticsForGeneration(settings aiRecognitionSettings, input aiRecognitionInput, systemPrompt string, userPrompt string, generation aiRecognitionGeneration) aiRecognitionDiagnostics {
	usage := interface{}(generation.result.Usage)
	if generation.capture.usage != nil {
		usage = generation.capture.usage
	}
	finishReason := firstNonBlank(generation.capture.finishReason, string(generation.result.FinishReason))
	providerMetadata := interface{}(generation.result.ProviderMetadata)
	if generation.capture.providerMetadata != nil {
		providerMetadata = generation.capture.providerMetadata
	}
	return buildAIRecognitionDiagnostics(
		settings,
		input,
		systemPrompt,
		userPrompt,
		firstNonBlank(generation.capture.rawModelText, resultStringFromAIObject(generation.result.Object)),
		generation.result.Object,
		usage,
		finishReason,
		providerMetadata,
	)
}

var aiRecognitionGeneratedSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "subscriptions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "price": { "type": ["number", "string", "null"] },
          "currency": { "type": ["string", "null"] },
          "billingCycle": { "type": ["string", "null"] },
          "customDays": { "type": ["integer", "string", "null"] },
          "customCycleUnit": { "type": ["string", "null"] },
          "oneTimeTermCount": { "type": ["integer", "string", "null"] },
          "oneTimeTermUnit": { "type": ["string", "null"] },
          "category": {
            "type": ["string", "null"],
            "description": "Renewlet category value from provided options when possible; otherwise a concise user-facing category only when the service type is obvious."
          },
          "status": { "type": ["string", "null"] },
          "paymentMethod": {
            "type": ["string", "null"],
            "description": "Renewlet payment method value from provided options when possible; otherwise a concise user-facing payment method only when the input explicitly names one."
          },
          "startDate": { "type": ["string", "null"] },
          "nextBillingDate": { "type": ["string", "null"] },
          "autoCalculateNextBillingDate": { "type": ["boolean", "null"] },
          "trialEndDate": { "type": ["string", "null"] },
          "website": {
            "type": ["object", "null"],
            "description": "Official or user-provided website for the subscribed service. Use null for the entire website field when the official site is ambiguous or unknown.",
            "properties": {
              "value": { "type": ["string", "null"] },
              "source": { "type": "string", "enum": ["input", "suggested"] }
            },
            "required": ["value", "source"],
            "additionalProperties": false
          },
          "notes": {
            "type": "object",
            "description": "Required service/site description decision object. Use value=null and source=none only when the service purpose is truly unknowable from input, domain, service name, category, tags, or high-confidence public knowledge.",
            "properties": {
              "value": {
                "type": ["string", "null"],
                "description": "Concise neutral service/site description. Must be non-null for describable services; not a category, import advice, confirmation reminder, or AI process note."
              },
              "source": { "type": "string", "enum": ["input", "suggested", "none"] }
            },
            "required": ["value", "source"],
            "additionalProperties": false
          },
          "tags": {
            "type": "array",
            "description": "User-facing reusable organization tags. Prefer existing user tags from prompt context; if none fit, generate only stable reusable service/product/domain tags, not one-off order attributes.",
            "items": { "type": "string" },
            "maxItems": 3
          },
          "reminderDays": { "type": ["integer", "string", "null"] },
          "repeatReminderEnabled": { "type": ["boolean", "null"] },
          "repeatReminderInterval": { "type": ["string", "null"] },
          "repeatReminderWindow": { "type": ["string", "null"] },
          "confidence": {
            "type": "string",
            "description": "Use high only when the extracted row can be directly confirmed; use low for ambiguous, partial, or inferred records.",
            "enum": ["high", "low"]
          },
          "warnings": {
            "type": "array",
            "description": "Stable warning codes for uncertain or invalid fields; keep uncertainty out of notes.",
            "items": { "type": "string" }
          }
        },
        "required": [
          "name",
          "price",
          "currency",
          "billingCycle",
          "customDays",
          "customCycleUnit",
          "oneTimeTermCount",
          "oneTimeTermUnit",
          "category",
          "status",
          "paymentMethod",
          "startDate",
          "nextBillingDate",
          "autoCalculateNextBillingDate",
          "trialEndDate",
          "website",
          "notes",
          "tags",
          "reminderDays",
          "repeatReminderEnabled",
          "repeatReminderInterval",
          "repeatReminderWindow",
          "confidence",
          "warnings"
        ],
        "additionalProperties": false
      }
    },
    "warnings": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["subscriptions", "warnings"],
  "additionalProperties": false
}`)

func newAIRecognitionModel(settings aiRecognitionSettings) (provider.LanguageModel, error) {
	settings = sanitizeAIRecognitionSettings(settings)
	endpoint := resolveAIProviderEndpoint(settings)
	switch settings.TransportProtocol {
	case aiProtocolOpenAIChat:
		httpClient := aiProviderRuntimeHTTPClient(endpoint, "")
		if settings.ProviderType != aiProviderTypeOpenAI {
			options := []compat.Option{compat.WithBaseURL(endpoint.RuntimeBaseURL), compat.WithHTTPClient(httpClient)}
			if settings.APIKey != "" {
				options = append(options, compat.WithAPIKey(settings.APIKey))
			}
			return aiRecognitionRuntimeModel{LanguageModel: compat.Chat(settings.Model, options...), providerType: settings.ProviderType, transportProtocol: settings.TransportProtocol}, nil
		}
		options := []openai.Option{openai.WithAPIKey(settings.APIKey), openai.WithHTTPClient(httpClient)}
		if endpoint.RuntimeBaseURL != "" {
			options = append(options, openai.WithBaseURL(endpoint.RuntimeBaseURL))
		}
		return aiRecognitionRuntimeModel{LanguageModel: openai.Chat(settings.Model, options...), providerType: settings.ProviderType, transportProtocol: settings.TransportProtocol}, nil
	case aiProtocolGeminiGenerateContent:
		options := []google.Option{google.WithAPIKey(settings.APIKey), google.WithHTTPClient(aiProviderRuntimeHTTPClient(endpoint, "v1beta"))}
		if baseURL := goAIBaseURLForEndpoint(endpoint); baseURL != "" {
			options = append(options, google.WithBaseURL(baseURL))
		}
		return aiRecognitionRuntimeModel{LanguageModel: google.Chat(settings.Model, options...), providerType: settings.ProviderType, transportProtocol: settings.TransportProtocol}, nil
	case aiProtocolAnthropicMessages:
		options := []anthropic.Option{anthropic.WithAPIKey(settings.APIKey), anthropic.WithHTTPClient(aiProviderRuntimeHTTPClient(endpoint, "v1"))}
		if baseURL := goAIBaseURLForEndpoint(endpoint); baseURL != "" {
			options = append(options, anthropic.WithBaseURL(baseURL))
		}
		return aiRecognitionRuntimeModel{LanguageModel: anthropic.Chat(settings.Model, options...), providerType: settings.ProviderType, transportProtocol: settings.TransportProtocol}, nil
	default:
		return nil, errAIRecognitionProviderInvalid
	}
}

func testAIRecognitionConnection(ctx context.Context, settings aiRecognitionSettings) error {
	settings = sanitizeAIRecognitionSettings(settings)
	model, err := newAIRecognitionModelForConnection(settings)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, aiRecognitionProviderTimeout)
	defer cancel()
	options := []goai.Option{
		goai.WithPrompt(aiRecognitionTestPrompt),
		goai.WithMaxOutputTokens(aiRecognitionTestProviderTokens),
		goai.WithMaxRetries(0),
	}
	if providerOptions := aiRecognitionProviderOptions(settings.ProviderType, settings.TransportProtocol, nil); len(providerOptions) > 0 {
		options = append(options, goai.WithProviderOptions(providerOptions))
	}
	_, err = goai.GenerateText(ctx, model, options...)
	return err
}

type aiRecognitionRuntimeModel struct {
	provider.LanguageModel
	providerType      string
	transportProtocol string
}

func (model aiRecognitionRuntimeModel) ProviderType() string {
	return model.providerType
}

func (model aiRecognitionRuntimeModel) TransportProtocol() string {
	return model.transportProtocol
}

func modelProviderType(model provider.LanguageModel) string {
	if typed, ok := model.(interface{ ProviderType() string }); ok {
		return typed.ProviderType()
	}
	return ""
}

func modelTransportProtocol(model provider.LanguageModel) string {
	if typed, ok := model.(interface{ TransportProtocol() string }); ok {
		return typed.TransportProtocol()
	}
	return ""
}

func aiRecognitionProviderOptions(providerType string, transportProtocol string, control *aiThinkingControl) map[string]any {
	var options map[string]any
	if providerType == aiProviderTypeOpenAI && transportProtocol == aiProtocolOpenAIChat {
		options = map[string]any{"useResponsesAPI": false}
	}
	if control == nil {
		return options
	}
	switch control.Provider {
	case "openai":
		if providerType != aiProviderTypeOpenAI || transportProtocol != aiProtocolOpenAIChat {
			return options
		}
		if options == nil {
			options = map[string]any{}
		}
		options["reasoning_effort"] = control.Effort
		return options
	case "gemini":
		if providerType != aiProviderTypeGemini || transportProtocol != aiProtocolGeminiGenerateContent {
			return options
		}
		switch control.Mode {
		case "off":
			return map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": 0}}}
		case "dynamic":
			return map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": -1}}}
		case "budget":
			return map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": *control.Budget}}}
		case "level":
			return map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingLevel": control.Level}}}
		}
	case "anthropic":
		if providerType != aiProviderTypeAnthropic || transportProtocol != aiProtocolAnthropicMessages {
			return options
		}
		if control.Mode == "effort" {
			return map[string]any{"effort": control.Effort}
		}
		if control.Mode == "budget" {
			return map[string]any{"thinking": map[string]any{"type": "enabled", "budgetTokens": *control.BudgetTokens}}
		}
	}
	return options
}

func goAIBaseURLForEndpoint(endpoint aiProviderEndpoint) string {
	if endpoint.TransportProtocol == aiProtocolAnthropicMessages || endpoint.TransportProtocol == aiProtocolGeminiGenerateContent {
		// GoAI 的 Anthropic/Gemini provider 会自己插入版本段；shared/Worker runtimeBaseURL 保留官方版本段，Docker 侧必须在 SDK 边界去掉。
		if endpoint.AutoVersionDisabled {
			return endpoint.RuntimeBaseURL
		}
		return aiProviderTrailingVersionSegmentPattern.ReplaceAllString(endpoint.RuntimeBaseURL, "")
	}
	return endpoint.RuntimeBaseURL
}

func aiProviderRuntimeHTTPClient(endpoint aiProviderEndpoint, version string) *http.Client {
	// GoAI provider 内部负责组装协议请求；这里仅替换网络边界，让模型调用共享环境代理、TLS 下限和脱敏诊断。
	return &http.Client{Timeout: aiRecognitionProviderTimeout, Transport: aiProviderRuntimeTransport{
		baseURL:                endpoint.RuntimeBaseURL,
		provider:               endpoint.ProviderType + " provider",
		version:                version,
		rewriteInsertedVersion: endpoint.AutoVersionDisabled,
		inner:                  defaultUpstreamHTTPTransport(),
	}}
}

type aiProviderRuntimeTransport struct {
	baseURL                string
	provider               string
	version                string
	rewriteInsertedVersion bool
	inner                  http.RoundTripper
}

func (transport aiProviderRuntimeTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	inner := transport.inner
	if inner == nil {
		inner = http.DefaultTransport
	}
	if !transport.rewriteInsertedVersion || strings.TrimSpace(transport.version) == "" {
		return transport.roundTripWithDiagnostics(inner, request)
	}
	parsed, err := url.Parse(transport.baseURL)
	if err != nil {
		return transport.roundTripWithDiagnostics(inner, request)
	}
	prefix := strings.TrimRight(parsed.Path, "/")
	insertedVersionPath := prefix + "/" + transport.version
	if strings.HasPrefix(request.URL.Path, insertedVersionPath+"/") || request.URL.Path == insertedVersionPath {
		// GoAI 对部分 provider 会再次插入版本段；只在 SDK 边界修正 URL，避免 shared endpoint 契约为 Docker 分叉。
		clone := request.Clone(request.Context())
		nextURL := *request.URL
		nextURL.Path = prefix + strings.TrimPrefix(request.URL.Path, insertedVersionPath)
		if nextURL.Path == "" {
			nextURL.Path = "/"
		}
		clone.URL = &nextURL
		return transport.roundTripWithDiagnostics(inner, clone)
	}
	return transport.roundTripWithDiagnostics(inner, request)
}

func (transport aiProviderRuntimeTransport) roundTripWithDiagnostics(inner http.RoundTripper, request *http.Request) (*http.Response, error) {
	response, err := inner.RoundTrip(request)
	if err == nil {
		return response, nil
	}
	provider := strings.TrimSpace(transport.provider)
	if provider == "" {
		provider = "AI provider"
	}
	timedOut := upstreamNetErrorTimedOut(err) || errors.Is(request.Context().Err(), context.DeadlineExceeded)
	return response, newUpstreamTransportError(upstreamTransportDiagnosticMessage(request, upstreamHTTPRequestOptions{
		Provider: provider,
		Timeout:  aiRecognitionProviderTimeout,
	}, err, aiRecognitionProviderTimeout, timedOut), timedOut)
}

func aiRecognitionOutputTokenLimit(input aiRecognitionInput) int {
	if input.MaxOutputTokens > 0 {
		return input.MaxOutputTokens
	}
	return aiRecognitionMaxProviderResponse
}

func resultStringFromAIObject(value interface{}) string {
	data, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(data)
}
