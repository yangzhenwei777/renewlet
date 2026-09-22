package main

// AI 识别端到端单测保护 Go provider runner、SSE contract、multipart 输入和 diagnostics 脱敏。
// 测试里的 fake model 只模拟第三方 SDK 边界，不替代 shared schema 与 Cloudflare Worker 的契约覆盖。
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/zendev-sh/goai"
	"github.com/zendev-sh/goai/provider"
)

func TestAIRecognitionProviderOptions(t *testing.T) {
	budget := 4096
	budgetTokens := 8192
	tests := []struct {
		name              string
		providerType      string
		transportProtocol string
		control           *aiThinkingControl
		want              map[string]any
	}{
		{
			name:              "openai chat completion with reasoning effort",
			providerType:      aiProviderTypeOpenAI,
			transportProtocol: aiProtocolOpenAIChat,
			control:           &aiThinkingControl{Provider: "openai", Effort: "high"},
			want:              map[string]any{"useResponsesAPI": false, "reasoning_effort": "high"},
		},
		{
			name:              "openai chat completion without thinking",
			providerType:      aiProviderTypeOpenAI,
			transportProtocol: aiProtocolOpenAIChat,
			want:              map[string]any{"useResponsesAPI": false},
		},
		{
			name:              "compatible openai chat does not receive official openai options",
			providerType:      aiProviderTypeOpenAICompatible,
			transportProtocol: aiProtocolOpenAIChat,
			control:           &aiThinkingControl{Provider: "openai", Effort: "high"},
			want:              nil,
		},
		{
			name:              "gemini off thinking budget",
			providerType:      aiProviderTypeGemini,
			transportProtocol: aiProtocolGeminiGenerateContent,
			control:           &aiThinkingControl{Provider: "gemini", Mode: "off"},
			want:              map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": 0}}},
		},
		{
			name:              "gemini fixed thinking budget",
			providerType:      aiProviderTypeGemini,
			transportProtocol: aiProtocolGeminiGenerateContent,
			control:           &aiThinkingControl{Provider: "gemini", Mode: "budget", Budget: &budget},
			want:              map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": 4096}}},
		},
		{
			name:              "anthropic effort",
			providerType:      aiProviderTypeAnthropic,
			transportProtocol: aiProtocolAnthropicMessages,
			control:           &aiThinkingControl{Provider: "anthropic", Mode: "effort", Effort: "xhigh"},
			want:              map[string]any{"effort": "xhigh"},
		},
		{
			name:              "anthropic legacy budget tokens",
			providerType:      aiProviderTypeAnthropic,
			transportProtocol: aiProtocolAnthropicMessages,
			control:           &aiThinkingControl{Provider: "anthropic", Mode: "budget", BudgetTokens: &budgetTokens},
			want:              map[string]any{"thinking": map[string]any{"type": "enabled", "budgetTokens": 8192}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := aiRecognitionProviderOptions(tt.providerType, tt.transportProtocol, tt.control)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("provider options mismatch: got %#v want %#v", got, tt.want)
			}
		})
	}
}

func TestAIRecognitionConnectionUsesMinimalTextGeneration(t *testing.T) {
	fake := &aiConnectionTestModel{
		err: &goai.APIError{
			Message:         "rate limited",
			StatusCode:      http.StatusTooManyRequests,
			IsRetryable:     true,
			ResponseBody:    `{"error":"invalid sk-test-secret"}`,
			ResponseHeaders: map[string]string{"retry-after": "5"},
		},
	}
	previousModelFactory := newAIRecognitionModelForConnection
	newAIRecognitionModelForConnection = func(settings aiRecognitionSettings) (provider.LanguageModel, error) {
		return fake, nil
	}
	t.Cleanup(func() {
		newAIRecognitionModelForConnection = previousModelFactory
	})

	err := testAIRecognitionConnection(context.Background(), aiRecognitionSettings{
		ProviderType:           aiProviderTypeOpenAI,
		TransportProtocol:      aiProtocolOpenAIChat,
		Model:                  "gpt-5.1",
		APIKey:                 "sk-test",
		DefaultThinkingControl: &aiThinkingControl{Provider: "openai", Effort: "high"},
	})
	var apiErr *goai.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected raw API error from zero-retry connection test, got %#v", err)
	}
	providerResponse := aiProviderResponseFromError(err)
	if providerResponse == nil || providerResponse.Body == nil || *providerResponse.Body != `{"error":"invalid [redacted]"}` {
		t.Fatalf("provider response body not captured: %#v", providerResponse)
	}
	if providerResponse.Status == nil || *providerResponse.Status != http.StatusTooManyRequests {
		t.Fatalf("provider response status not captured: %#v", providerResponse)
	}
	if providerResponse.Headers["retry-after"] != "5" {
		t.Fatalf("provider response headers not captured: %#v", providerResponse.Headers)
	}
	if fake.calls != 1 {
		t.Fatalf("connection test should disable retries, got %d model calls", fake.calls)
	}
	if fake.params.MaxOutputTokens != aiRecognitionTestProviderTokens || fake.params.ResponseFormat != nil || len(fake.params.Tools) != 0 {
		t.Fatalf("connection test should be a small text-only call, got %#v", fake.params)
	}
	if !reflect.DeepEqual(fake.params.ProviderOptions, map[string]any{"useResponsesAPI": false}) {
		t.Fatalf("OpenAI connection test must stay on Chat Completions, got %#v", fake.params.ProviderOptions)
	}
	if len(fake.params.Messages) != 1 || len(fake.params.Messages[0].Content) != 1 || fake.params.Messages[0].Content[0].Text != aiRecognitionTestPrompt {
		t.Fatalf("connection test prompt mismatch: %#v", fake.params.Messages)
	}
}

func TestAIProviderResponseFromWrappedAPIError(t *testing.T) {
	err := fmt.Errorf("stream result: %w", &goai.APIError{
		Message:         "provider failed",
		StatusCode:      http.StatusUnauthorized,
		ResponseBody:    `{"code":"INVALID_API_KEY","message":"bad key"}`,
		ResponseHeaders: map[string]string{"content-type": "application/json"},
	})
	providerResponse := aiProviderResponseFromError(err)
	if providerResponse == nil || providerResponse.Body == nil || *providerResponse.Body != `{"code":"INVALID_API_KEY","message":"bad key"}` {
		t.Fatalf("wrapped provider body not captured: %#v", providerResponse)
	}
	if providerResponse.Status == nil || *providerResponse.Status != http.StatusUnauthorized {
		t.Fatalf("wrapped provider status not captured: %#v", providerResponse)
	}
	if providerResponse.Headers["content-type"] != "application/json" {
		t.Fatalf("wrapped provider headers not captured: %#v", providerResponse.Headers)
	}
}

func TestGoAIRecognitionRunnerRepairsMissingNotes(t *testing.T) {
	restore := stubAIRecognitionGeneration(t, []aiGeneratedRecognizeResponse{
		aiGeneratedResponseForTest(aiGeneratedDraftForTest(
			"HostDZire CloudVPS",
			aiGeneratedNotesField{Value: nil, Source: "none"},
			[]string{"VPS", "云主机"},
		)),
		aiGeneratedResponseForTest(aiGeneratedDraftForTest(
			"HostDZire CloudVPS",
			aiGeneratedNotesField{Value: stringRef("HostDZire CloudVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。"), Source: "suggested"},
			[]string{"VPS", "云主机"},
		)),
	})
	defer restore()

	response, err := goaiRecognitionRunner{}.Recognize(
		context.Background(),
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIChat, Model: "gpt-5.1", APIKey: "sk-test"},
		aiRecognitionInput{Text: "HostDZire CloudVPS 15元 1个月", MaxOutputTokens: 12000},
		localeZhCN,
		"Asia/Shanghai",
		"CNY",
		aiRecognitionConfigContext{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if response.Subscriptions[0].Notes == nil || response.Subscriptions[0].Notes.Value != "HostDZire CloudVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。" {
		t.Fatalf("repair notes not preserved: %#v", response.Subscriptions[0].Notes)
	}
	if !strings.Contains(response.Diagnostics.Prompt.User.Value, "Repair task:") {
		t.Fatalf("diagnostics should describe repair prompt, got %s", response.Diagnostics.Prompt.User.Value)
	}
}

func TestGoAIRecognitionRunnerFallsBackWhenRepairStillMissesNotes(t *testing.T) {
	missing := aiGeneratedResponseForTest(aiGeneratedDraftForTest(
		"HostDZire CloudVPS",
		aiGeneratedNotesField{Value: nil, Source: "none"},
		[]string{"VPS", "云主机"},
	))
	restore := stubAIRecognitionGeneration(t, []aiGeneratedRecognizeResponse{missing, missing})
	defer restore()

	response, err := goaiRecognitionRunner{}.Recognize(
		context.Background(),
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIChat, Model: "gpt-5.1", APIKey: "sk-test"},
		aiRecognitionInput{Text: "HostDZire CloudVPS 15元 1个月", MaxOutputTokens: 12000},
		localeZhCN,
		"Asia/Shanghai",
		"CNY",
		aiRecognitionConfigContext{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if response.Subscriptions[0].Notes == nil || response.Subscriptions[0].Notes.Value != "HostDZire CloudVPS 是提供 VPS、云主机相关产品或服务的订阅服务。" {
		t.Fatalf("fallback notes not generated from dynamic fields: %#v", response.Subscriptions[0].Notes)
	}
	if slices.Contains(response.Subscriptions[0].Warnings, "AI_WARNING_NOTES_MISSING") {
		t.Fatalf("fallback should not expose missing-notes warning: %#v", response.Subscriptions[0].Warnings)
	}
}

func TestGoAIRecognitionRunnerRecoversRawJSONWhenStructuredObjectRejected(t *testing.T) {
	raw := aiGeneratedResponseForTest(aiGeneratedDraftForTest(
		"LocVPS",
		aiGeneratedNotesField{Value: stringRef("LocVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。"), Source: "suggested"},
		[]string{"VPS", "云主机"},
	))
	raw.Subscriptions[0].Website = &aiGeneratedSuggestedTextField{Value: nil, Source: "suggested"}
	previous := generateAIRecognitionObjectForRunner
	generateAIRecognitionObjectForRunner = func(context.Context, provider.LanguageModel, aiRecognitionInput, string, string) (aiRecognitionGeneration, error) {
		return aiRecognitionGeneration{
			capture: aiRecognitionCapture{
				rawModelText: "```json\n" + resultStringFromAIObject(raw) + "\n```",
				finishReason: "stop",
			},
		}, errors.New("No object generated: response did not match schema.")
	}
	defer func() {
		generateAIRecognitionObjectForRunner = previous
	}()

	response, err := goaiRecognitionRunner{}.Recognize(
		context.Background(),
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIChat, Model: "gpt-5.1", APIKey: "sk-test"},
		aiRecognitionInput{Text: "locvps 20元 1个月", MaxOutputTokens: 12000},
		localeZhCN,
		"Asia/Shanghai",
		"CNY",
		aiRecognitionConfigContext{},
	)
	if err != nil {
		t.Fatal(err)
	}
	draft := response.Subscriptions[0]
	if draft.Name != "LocVPS" || draft.Website != nil {
		t.Fatalf("raw JSON recovery should keep draft and clean nullable website: %#v", draft)
	}
	if response.Diagnostics.Output.RawModelText == nil || !strings.Contains(response.Diagnostics.Output.RawModelText.Value, "LocVPS") {
		t.Fatalf("diagnostics should keep sanitized raw text for recovered object: %#v", response.Diagnostics.Output.RawModelText)
	}
}

func TestGoAIRecognitionRunnerStreamsProgressPartialAndFinal(t *testing.T) {
	restore := stubAIRecognitionStreamGeneration(t, []aiGeneratedRecognizeResponse{
		aiGeneratedResponseForTest(aiGeneratedDraftForTest(
			"HostDZire CloudVPS",
			aiGeneratedNotesField{Value: stringRef("HostDZire CloudVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。"), Source: "suggested"},
			[]string{"VPS", "云主机"},
		)),
	})
	defer restore()
	sink := &recordingAIRecognitionStreamSink{}

	err := goaiRecognitionRunner{}.Stream(
		context.Background(),
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIChat, Model: "gpt-5.1", APIKey: "sk-test"},
		aiRecognitionInput{Text: "HostDZire CloudVPS 15元 1个月", MaxOutputTokens: 12000},
		localeZhCN,
		"Asia/Shanghai",
		"CNY",
		aiRecognitionConfigContext{},
		sink,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sink.progress, []string{
		aiRecognitionStreamStageModelStart,
		aiRecognitionStreamStageModelStream,
		aiRecognitionStreamStageValidating,
		aiRecognitionStreamStageFinalizing,
	}) {
		t.Fatalf("stream progress mismatch: %#v", sink.progress)
	}
	if !reflect.DeepEqual(sink.partials, []aiRecognitionStreamPartialEvent{{Type: "recognition/partial", SubscriptionsSeen: 1, WarningsSeen: 0}}) {
		t.Fatalf("stream partials mismatch: %#v", sink.partials)
	}
	if sink.final == nil || sink.final.Subscriptions[0].Name != "HostDZire CloudVPS" {
		t.Fatalf("stream final response missing: %#v", sink.final)
	}
}

func TestGoAIRecognitionRunnerStreamsRecoveredRawJSONFinal(t *testing.T) {
	raw := aiGeneratedResponseForTest(aiGeneratedDraftForTest(
		"LocVPS",
		aiGeneratedNotesField{Value: stringRef("LocVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。"), Source: "suggested"},
		[]string{"VPS", "云主机"},
	))
	raw.Subscriptions[0].Website = &aiGeneratedSuggestedTextField{Value: nil, Source: "suggested"}
	previous := streamAIRecognitionObjectForRunner
	streamAIRecognitionObjectForRunner = func(context.Context, provider.LanguageModel, aiRecognitionInput, string, string, aiRecognitionStreamSink) (aiRecognitionGeneration, error) {
		return aiRecognitionGeneration{
			capture: aiRecognitionCapture{
				rawModelText: resultStringFromAIObject(raw),
				finishReason: "stop",
			},
		}, errors.New("No object generated: response did not match schema.")
	}
	defer func() {
		streamAIRecognitionObjectForRunner = previous
	}()
	sink := &recordingAIRecognitionStreamSink{}

	err := goaiRecognitionRunner{}.Stream(
		context.Background(),
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIChat, Model: "gpt-5.1", APIKey: "sk-test"},
		aiRecognitionInput{Text: "locvps 20元 1个月", MaxOutputTokens: 12000},
		localeZhCN,
		"Asia/Shanghai",
		"CNY",
		aiRecognitionConfigContext{},
		sink,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sink.progress, []string{
		aiRecognitionStreamStageModelStart,
		aiRecognitionStreamStageValidating,
		aiRecognitionStreamStageFinalizing,
	}) {
		t.Fatalf("recovered stream progress mismatch: %#v", sink.progress)
	}
	if sink.final == nil || sink.final.Subscriptions[0].Website != nil {
		t.Fatalf("recovered stream final should clean nullable website: %#v", sink.final)
	}
}

func TestAIRecognitionPartialProgressDedupe(t *testing.T) {
	sink := &recordingAIRecognitionStreamSink{}
	last := aiRecognitionStreamPartialEvent{}
	for _, item := range []aiRecognitionStreamPartialEvent{
		{SubscriptionsSeen: 0, WarningsSeen: 0},
		{SubscriptionsSeen: 1, WarningsSeen: 0},
		{SubscriptionsSeen: 1, WarningsSeen: 0},
		{SubscriptionsSeen: 1, WarningsSeen: 1},
	} {
		if err := emitAIRecognitionPartialIfChanged(sink, &last, item.SubscriptionsSeen, item.WarningsSeen); err != nil {
			t.Fatal(err)
		}
	}
	want := []aiRecognitionStreamPartialEvent{
		{Type: "recognition/partial", SubscriptionsSeen: 1, WarningsSeen: 0},
		{Type: "recognition/partial", SubscriptionsSeen: 1, WarningsSeen: 1},
	}
	if !reflect.DeepEqual(sink.partials, want) {
		t.Fatalf("partial dedupe mismatch: %#v", sink.partials)
	}
}

func TestAIRecognitionSSEWriterHeadersEventsAndSanitizedError(t *testing.T) {
	recorder := httptest.NewRecorder()
	writer := aiRecognitionSSEWriter{
		response:   recorder,
		controller: http.NewResponseController(recorder),
	}
	writer.prepareHeaders()
	if err := writer.Progress(aiRecognitionStreamStageInputRead); err != nil {
		t.Fatal(err)
	}
	if err := writer.Partial(2, 1); err != nil {
		t.Fatal(err)
	}
	if err := writer.Comment("keep-alive"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Final(aiRecognizeResponse{
		ProviderType:      aiProviderTypeOpenAI,
		TransportProtocol: aiProtocolOpenAIChat,
		Model:             "gpt-5.1",
		Subscriptions:     []aiRecognizedSubscriptionDraft{{Name: "dmit", Confidence: "high"}},
		Warnings:          []string{},
		Diagnostics:       testAIRecognitionDiagnostics(),
	}); err != nil {
		t.Fatal(err)
	}
	streamErr := aiRecognitionStreamErrorForError(localeZhCN, &aiRecognitionRunError{
		cause:       errors.New("provider failed sk-stream-secret123"),
		diagnostics: testAIRecognitionDiagnostics(),
	})
	if err := writer.Error(streamErr); err != nil {
		t.Fatal(err)
	}

	if contentType := recorder.Header().Get("content-type"); !strings.Contains(contentType, "text/event-stream") {
		t.Fatalf("content-type should be SSE, got %q", contentType)
	}
	if recorder.Header().Get("x-content-type-options") != "nosniff" || recorder.Header().Get("cache-control") != "no-store" {
		t.Fatalf("SSE safety headers missing: %#v", recorder.Header())
	}
	body := recorder.Body.String()
	for _, want := range []string{
		"event: recognition/progress",
		`"stage":"input-read"`,
		"event: recognition/partial",
		`"subscriptionsSeen":2`,
		": keep-alive",
		"event: recognition/final",
		"event: recognition/error",
		"[redacted]",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("SSE body missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "sk-stream-secret123") {
		t.Fatalf("SSE error leaked provider secret:\n%s", body)
	}
}

func TestAIRecognitionStreamErrorCodeForTimeout(t *testing.T) {
	streamErr := aiRecognitionStreamErrorForError(localeZhCN, context.DeadlineExceeded)
	if streamErr.Code != "AI_RECOGNITION_TIMEOUT" {
		t.Fatalf("timeout code mismatch: %#v", streamErr)
	}
}

func TestAIRecognitionStreamErrorIncludesRawResponseText(t *testing.T) {
	streamErr := aiRecognitionStreamErrorForError(localeZhCN, &aiRecognitionRunError{
		cause: fmt.Errorf("stream result: %w", &goai.APIError{
			Message:         "provider failed",
			StatusCode:      http.StatusUnauthorized,
			ResponseBody:    `{"code":"INVALID_API_KEY","message":"bad sk-testsecret123"}`,
			ResponseHeaders: map[string]string{"content-type": "application/json"},
		}),
		diagnostics: testAIRecognitionDiagnostics(),
	})
	if streamErr.Details == nil || streamErr.Details.RawResponseText == nil {
		t.Fatalf("stream error should include raw response text: %#v", streamErr)
	}
	if *streamErr.Details.RawResponseText != `{"code":"INVALID_API_KEY","message":"bad [redacted]"}` {
		t.Fatalf("raw response mismatch: %#v", streamErr.Details.RawResponseText)
	}
}

func TestReadAIRecognitionMultipartThinkingControl(t *testing.T) {
	missing := readAIRecognitionMultipartForTest(t, map[string]string{"text": "dmit 15元 1个月"})
	if missing.ThinkingControl != nil {
		t.Fatalf("missing thinkingControl field should not apply defaults, got %#v", missing.ThinkingControl)
	}

	explicitNull := readAIRecognitionMultipartForTest(t, map[string]string{
		"text":            "dmit 15元 1个月",
		"thinkingControl": "null",
	})
	if explicitNull.ThinkingControl != nil {
		t.Fatalf("explicit null thinkingControl should stay nil, got %#v", explicitNull.ThinkingControl)
	}

	explicitControl := readAIRecognitionMultipartForTest(t, map[string]string{
		"text":            "dmit 15元 1个月",
		"thinkingControl": `{"provider":"openai","effort":"high"}`,
	})
	if explicitControl.ThinkingControl == nil || explicitControl.ThinkingControl.Provider != "openai" || explicitControl.ThinkingControl.Effort != "high" {
		t.Fatalf("explicit thinkingControl was not parsed: %#v", explicitControl.ThinkingControl)
	}
}

func TestReadAIRecognitionMultipartImageLimit(t *testing.T) {
	fiveImages, err := readAIRecognitionMultipartImagesForTest(5)
	if err != nil {
		t.Fatal(err)
	}
	if len(fiveImages.Images) != 5 {
		t.Fatalf("expected five images, got %#v", fiveImages.Images)
	}

	if _, err := readAIRecognitionMultipartImagesForTest(6); !errors.Is(err, errAIRecognitionBodyTooLarge) {
		t.Fatalf("expected body too large for sixth image, got %v", err)
	}
}

func TestSanitizeAIRecognitionSettingsModelInputMode(t *testing.T) {
	if got := sanitizeAIRecognitionSettings(aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIChat, ModelInputMode: ""}).ModelInputMode; got != "select" {
		t.Fatalf("empty model input mode should default to select, got %q", got)
	}
	if got := sanitizeAIRecognitionSettings(aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIChat, ModelInputMode: "manual"}).ModelInputMode; got != "manual" {
		t.Fatalf("manual model input mode should be preserved, got %q", got)
	}
	if got := sanitizeAIRecognitionSettings(aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIChat, ModelInputMode: "unknown"}).ModelInputMode; got != "select" {
		t.Fatalf("invalid model input mode should fall back to select, got %q", got)
	}
}

func TestSanitizeAIRecognitionSettingsCanonicalizesProtocol(t *testing.T) {
	settings := sanitizeAIRecognitionSettings(aiRecognitionSettings{
		ProviderType:      aiProviderTypeOpenAICompatible,
		TransportProtocol: aiProtocolAnthropicMessages,
		ModelInputMode:    "manual",
		DefaultThinkingControl: &aiThinkingControl{
			Provider: aiProviderTypeAnthropic,
			Mode:     "effort",
			Effort:   "high",
		},
	})
	if settings.TransportProtocol != aiProtocolOpenAIChat {
		t.Fatalf("compatible provider should use openai chat, got %q", settings.TransportProtocol)
	}
	if settings.DefaultThinkingControl != nil {
		t.Fatalf("mismatched thinking control should be cleared: %#v", settings.DefaultThinkingControl)
	}
}

func TestSafeAIRecognitionErrorRedactsSecrets(t *testing.T) {
	err := safeAIRecognitionError(errors.New("provider failed sk-testsecret123 AIza123456789 sk-ant-secret123 Bearer abc.def.ghi eyJabc.def.ghi authorization: secret-token-12345"))
	message := err.Error()
	for _, secret := range []string{"sk-testsecret123", "AIza123456789", "sk-ant-secret123", "Bearer abc.def.ghi", "eyJabc.def.ghi", "secret-token-12345"} {
		if strings.Contains(message, secret) {
			t.Fatalf("secret %q leaked in %q", secret, message)
		}
	}
	if got := strings.Count(message, "[redacted]"); got != 6 {
		t.Fatalf("redaction count mismatch: got %d in %q", got, message)
	}
}

func TestAIRecognitionPromptUsesSharedJSONContract(t *testing.T) {
	systemPrompt := buildAIRecognitionSystemPrompt()
	configContext := aiRecognitionConfigContext{
		Categories: []aiRecognitionConfigOption{{
			Value: "hosting_domains",
			Label: "域名与托管",
			ZhCN:  "域名与托管",
			EnUS:  "Domains & Hosting",
		}},
		PaymentMethods: []aiRecognitionConfigOption{{
			Value: "crypto",
			Label: "加密货币",
			ZhCN:  "加密货币",
			EnUS:  "Crypto",
		}},
		Tags: []string{"VPS", "云服务器"},
	}
	userPrompt := buildAIRecognitionUserPrompt("sample service 15元 1个月", "Asia/Shanghai", "CNY", 2, localeZhCN, configContext)
	for _, want := range []string{
		"Return exactly one valid JSON object parseable by JSON.parse",
		"no Markdown",
		"no explanations",
		"output null and add a warning code",
		"Never invent price, currency, billing cycle, dates, status, payment method, or reminder fields",
		"Do generate useful service and website metadata",
		"Examples show output shape and decision patterns only",
		"do not copy example natural-language output when it conflicts with User locale",
	} {
		if !strings.Contains(systemPrompt, want) {
			t.Fatalf("system prompt missing %q:\n%s", want, systemPrompt)
		}
	}
	for _, want := range []string{
		`Top-level JSON must be exactly {"subscriptions": [], "warnings": []}.`,
		"Runtime context:",
		"- Attached image count: 2",
		"- User locale: zh-CN",
		"User context:",
		"Task:",
		"Examples:",
		"<<<renewlet-user-input",
		"Existing user tags:",
		"- VPS",
		"value=hosting_domains",
		"value=crypto",
		"provided category values exactly",
		"website with the canonical https URL",
		"output website: null",
		`never output {"value": null, "source": "suggested"}`,
		"notes must always be an object",
		"notes.value must be non-null for describable services",
		"dynamic evidence from this request",
		"Generated user-facing metadata must follow User locale",
		"use English for en-US and Simplified Chinese for zh-CN",
		"Do not translate source=input text, Existing user tags",
		"Prefer Existing user tags when they fit.",
		"stable and reusable across multiple subscriptions",
		"Do not use one-off order attributes as tags",
		"Example Cloud Backup",
		"Team Docs Workspace",
		`"price": 12`,
		`"currency": "USD"`,
		`"billingCycle": "annual"`,
		`"value": "https://backup.example.com"`,
		`"source": "none"`,
	} {
		if !strings.Contains(userPrompt, want) {
			t.Fatalf("user prompt missing %q:\n%s", want, userPrompt)
		}
	}
	for _, forbidden := range []string{
		"apple 50刀 1年",
		"youtube 15刀 1年",
		"locvps 15元 1个月",
		"dmit 15元 1个月",
		"https://www.apple.com/",
		"YouTube 是 Google 旗下的视频分享和流媒体平台。",
		"LOCVPS 是面向 VPS、云服务器和服务器托管的主机服务商。",
		"DMIT 是提供 VPS、云服务器和网络线路服务的主机商。",
	} {
		if strings.Contains(userPrompt, forbidden) {
			t.Fatalf("user prompt should not contain brand mapping example %q:\n%s", forbidden, userPrompt)
		}
	}
}

func TestAIRecognitionGeneratedSchemaRequiresCompleteDraftFields(t *testing.T) {
	var schema struct {
		Properties map[string]struct {
			Items struct {
				Required   []string `json:"required"`
				Properties map[string]struct {
					Description string   `json:"description"`
					Type        any      `json:"type"`
					Enum        []string `json:"enum"`
					MaxItems    int      `json:"maxItems"`
					Properties  map[string]struct {
						Description string   `json:"description"`
						Type        any      `json:"type"`
						Enum        []string `json:"enum"`
					} `json:"properties"`
				} `json:"properties"`
			} `json:"items"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(aiRecognitionGeneratedSchema, &schema); err != nil {
		t.Fatal(err)
	}
	subscriptionRequired := schema.Properties["subscriptions"].Items.Required
	for _, field := range []string{"name", "price", "currency", "billingCycle", "website", "notes", "tags", "confidence", "warnings"} {
		if !slices.Contains(subscriptionRequired, field) {
			t.Fatalf("generated subscription schema should require %q, got %#v", field, subscriptionRequired)
		}
	}
	if !slices.Contains(schema.Required, "warnings") {
		t.Fatalf("top-level schema should require warnings, got %#v", schema.Required)
	}
	tagsSchema := schema.Properties["subscriptions"].Items.Properties["tags"]
	if tagsSchema.MaxItems != 3 || !strings.Contains(tagsSchema.Description, "reusable organization tags") {
		t.Fatalf("generated tags schema should describe reusable tags and cap at 3, got %#v", tagsSchema)
	}
	notesSchema := schema.Properties["subscriptions"].Items.Properties["notes"]
	notesType, _ := json.Marshal(notesSchema.Type)
	if strings.Contains(string(notesType), "null") {
		t.Fatalf("generated notes object should not be nullable, got %s", notesType)
	}
	if !slices.Contains(notesSchema.Properties["source"].Enum, "none") {
		t.Fatalf("generated notes source should include none, got %#v", notesSchema.Properties["source"].Enum)
	}
	websiteValueType, _ := json.Marshal(schema.Properties["subscriptions"].Items.Properties["website"].Properties["value"].Type)
	if !strings.Contains(string(websiteValueType), "null") {
		t.Fatalf("generated website value should allow null at generation boundary, got %s", websiteValueType)
	}
	for field, want := range map[string]string{
		"website":       "Official or user-provided website",
		"notes":         "service/site description",
		"category":      "Renewlet category value",
		"paymentMethod": "Renewlet payment method value",
		"confidence":    "directly confirmed",
		"warnings":      "Stable warning codes",
	} {
		if !strings.Contains(schema.Properties["subscriptions"].Items.Properties[field].Description, want) {
			t.Fatalf("generated %s schema should describe %q, got %#v", field, want, schema.Properties["subscriptions"].Items.Properties[field])
		}
	}
}

func TestAIRecognitionExistingTagsForUser(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "ai-tags")
	other, _ := createRouteTestUser(t, app, "ai-tags-other")
	saveSubscriptionRecord(t, app, user.Id, []string{" VPS ", "云服务器", "vps"}, "Host")
	saveSubscriptionRecord(t, app, other.Id, []string{"Other"}, "Other Host")

	tags, err := aiRecognitionExistingTagsForUser(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tags, []string{"VPS", "云服务器"}) {
		t.Fatalf("expected current user tags with case-insensitive prompt dedupe, got %#v", tags)
	}
}

func TestAIRecognitionDiagnosticsRedactsSecretsAndImageData(t *testing.T) {
	diagnostics := buildAIRecognitionDiagnostics(
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIChat, Model: "gpt-5.1"},
		aiRecognitionInput{
			Text: "dmit 15元 1个月 sk-testsecret123",
			Images: []aiRecognitionImage{{
				MediaType: "image/png",
				DataURL:   "data:image/png;base64,SHOULD_NOT_LEAK",
				SizeBytes: 12,
			}},
			MaxOutputTokens: 12000,
		},
		"Return JSON only",
		"authorization: secret-token-12345",
		`{"subscriptions":[],"warnings":[],"apiKey":"sk-testsecret123"}`,
		map[string]any{"subscriptions": []any{}, "warnings": []any{}},
		map[string]any{"inputTokens": 1},
		"stop",
		map[string]any{"openai": map[string]any{"authorization": "Bearer abc.def.ghi"}},
	)
	data, err := json.Marshal(diagnostics)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, leaked := range []string{"sk-testsecret123", "secret-token-12345", "Bearer abc.def.ghi", "SHOULD_NOT_LEAK", "data:image/png;base64"} {
		if strings.Contains(text, leaked) {
			t.Fatalf("diagnostics leaked %q in %s", leaked, text)
		}
	}
	if diagnostics.Request.Images[0].SizeBytes != 12 || diagnostics.Request.Images[0].MediaType != "image/png" {
		t.Fatalf("image metadata not preserved: %#v", diagnostics.Request.Images)
	}
	if diagnostics.Output.RawModelText == nil || !strings.Contains(diagnostics.Output.RawModelText.Value, "[redacted]") {
		t.Fatalf("raw model text was not redacted: %#v", diagnostics.Output.RawModelText)
	}
}
