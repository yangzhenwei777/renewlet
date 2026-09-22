package main

// AI 识别归一化测试保护模型宽松输出进入标准草稿契约前的清洗层。
// 重点覆盖 nullable website、备注去过程化、标签复用和 schema mismatch，避免 AI 文本直接污染长期订阅字段。
import (
	"errors"
	"reflect"
	"slices"
	"testing"
)

func TestNormalizeAIRecognizeResponse(t *testing.T) {
	price := "-1"
	currency := "usd"
	billingCycle := "bad"
	date := "2026-99-99"
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:            "  Netflix  ",
			Price:           &price,
			Currency:        &currency,
			BillingCycle:    &billingCycle,
			StartDate:       &date,
			NextBillingDate: &date,
			Confidence:      "unknown",
			Warnings:        []string{"", "manual warning", "manual warning"},
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIChat, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	draft := response.Subscriptions[0]
	if response.ProviderType != aiProviderTypeOpenAI || response.TransportProtocol != aiProtocolOpenAIChat || response.Model != "gpt-5.1" {
		t.Fatalf("provider/protocol/model not attached: %#v", response)
	}
	if draft.Name != "Netflix" || draft.Price != nil || draft.BillingCycle != nil || draft.Confidence != "low" {
		t.Fatalf("draft was not normalized: %#v", draft)
	}
	if draft.Currency == nil || *draft.Currency != "USD" {
		t.Fatalf("currency should normalize to USD: %#v", draft.Currency)
	}
	if !slices.Contains(draft.Warnings, "AI_WARNING_PRICE_INVALID") || !slices.Contains(draft.Warnings, "AI_WARNING_DATE_INVALID:startDate") {
		t.Fatalf("expected validation warnings, got %#v", draft.Warnings)
	}
}

func TestNormalizeAIGeneratedRecognizeResponse(t *testing.T) {
	currency := "元"
	billingCycle := "1个月"
	category := "数字服务"
	paymentMethod := "Crypto"
	websiteValue := "https://www.apple.com/"
	website := aiGeneratedSuggestedTextField{Value: &websiteValue, Source: "suggested"}
	notesValue := "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。"
	notes := aiGeneratedNotesField{Value: &notesValue, Source: "suggested"}
	configContext := aiRecognitionConfigContext{
		Categories: []aiRecognitionConfigOption{{
			Value: "digital_services",
			Label: "数字服务",
			ZhCN:  "数字服务",
			EnUS:  "Digital services",
		}},
		PaymentMethods: []aiRecognitionConfigOption{{
			Value: "crypto",
			Label: "加密货币",
			ZhCN:  "加密货币",
			EnUS:  "Crypto",
		}},
		Tags: []string{"数字服务", "云服务"},
	}
	response, err := normalizeAIGeneratedRecognizeResponse(aiGeneratedRecognizeResponse{
		Subscriptions: []aiGeneratedSubscriptionDraft{{
			Name:          "dmit",
			Price:         "15元",
			Currency:      &currency,
			BillingCycle:  &billingCycle,
			Category:      &category,
			PaymentMethod: &paymentMethod,
			Website:       &website,
			Notes:         &notes,
			Tags:          []string{"数字服务", "数字服务", "  云服务  "},
		}},
		Warnings: []string{},
	}, aiProviderTypeOpenAI, aiProtocolOpenAIChat, "gpt-5.1", testAIRecognitionDiagnostics(), configContext)
	if err != nil {
		t.Fatal(err)
	}
	draft := response.Subscriptions[0]
	if response.ProviderType != aiProviderTypeOpenAI || response.TransportProtocol != aiProtocolOpenAIChat || response.Model != "gpt-5.1" {
		t.Fatalf("provider/protocol/model not attached: %#v", response)
	}
	if draft.Name != "dmit" || draft.Price == nil || *draft.Price != "15" {
		t.Fatalf("generated draft price not normalized: %#v", draft)
	}
	if draft.Currency == nil || *draft.Currency != "CNY" {
		t.Fatalf("currency should normalize to CNY: %#v", draft.Currency)
	}
	if draft.BillingCycle == nil || *draft.BillingCycle != "monthly" {
		t.Fatalf("billing cycle should normalize to monthly: %#v", draft.BillingCycle)
	}
	if draft.Category == nil || *draft.Category != "digital_services" || draft.PaymentMethod == nil || *draft.PaymentMethod != "crypto" || draft.Website == nil || draft.Website.Source != "suggested" || draft.Notes == nil || draft.Notes.Source != "suggested" {
		t.Fatalf("suggested metadata should be preserved: %#v", draft)
	}
	if !reflect.DeepEqual(draft.Tags, []string{"数字服务", "云服务"}) {
		t.Fatalf("tags should be compacted: %#v", draft.Tags)
	}
}

func TestNormalizeAIGeneratedRecognizeResponseCleansNullableWebsiteValue(t *testing.T) {
	notesValue := "LocVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。"
	response, err := normalizeAIGeneratedRecognizeResponse(aiGeneratedRecognizeResponse{
		Subscriptions: []aiGeneratedSubscriptionDraft{{
			Name:       "LocVPS",
			Website:    &aiGeneratedSuggestedTextField{Value: nil, Source: "suggested"},
			Notes:      &aiGeneratedNotesField{Value: &notesValue, Source: "suggested"},
			Tags:       []string{"VPS"},
			Confidence: "high",
			Warnings:   []string{},
		}},
		Warnings: []string{},
	}, aiProviderTypeOpenAI, aiProtocolOpenAIChat, "gpt-5.1", testAIRecognitionDiagnostics(), aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	if response.Subscriptions[0].Website != nil {
		t.Fatalf("nullable generated website value should be normalized away: %#v", response.Subscriptions[0].Website)
	}
}

func TestNormalizeAITagsReusesExistingAndKeepsStableGeneratedTags(t *testing.T) {
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "HostDZire IN CloudVPS #5 (FAT32 Special)",
			Tags:       []string{"vps", "孟买", "Debian 12"},
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIChat, "gpt-5.1", aiRecognitionConfigContext{Tags: []string{"VPS", "云服务器"}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(response.Subscriptions[0].Tags, []string{"VPS"}) {
		t.Fatalf("expected existing tag reuse and one-off attribute filtering, got %#v", response.Subscriptions[0].Tags)
	}

	response, err = normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "DMIT",
			Tags:       []string{"VPS", "云服务器", "Debian 12"},
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIChat, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(response.Subscriptions[0].Tags, []string{"VPS", "云服务器"}) {
		t.Fatalf("expected stable generated tags to remain, got %#v", response.Subscriptions[0].Tags)
	}

	response, err = normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "HostDZire IN CloudVPS #5 (FAT32 Special)",
			Tags:       []string{"孟买", "Debian 12", "FAT32 Special"},
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIChat, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Subscriptions[0].Tags) != 0 {
		t.Fatalf("expected one-off generated attributes to be dropped, got %#v", response.Subscriptions[0].Tags)
	}
}

func TestNormalizeAINotesDropsRecognitionProcessText(t *testing.T) {
	notes := aiSuggestedTextField{Value: "输入没有提供官网或更多上下文，AI 未能高置信识别该服务。", Source: "suggested"}
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "unknown app",
			Notes:      &notes,
			Warnings:   []string{"AI_WARNING_WEBSITE_UNCERTAIN"},
			Confidence: "low",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIChat, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	draft := response.Subscriptions[0]
	if draft.Notes != nil {
		t.Fatalf("process note should be dropped: %#v", draft.Notes)
	}
	if !slices.Contains(draft.Warnings, "AI_WARNING_WEBSITE_UNCERTAIN") {
		t.Fatalf("warning should be preserved: %#v", draft.Warnings)
	}
}

func TestNormalizeAINotesRemovesRenewletAdvice(t *testing.T) {
	notes := aiSuggestedTextField{Value: "LOCVPS 提供 VPS、云服务器和服务器托管相关服务，适合记录主机或服务器套餐订阅。", Source: "suggested"}
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "locvps",
			Notes:      &notes,
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIChat, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	draft := response.Subscriptions[0]
	if draft.Notes == nil || draft.Notes.Value != "LOCVPS 提供 VPS、云服务器和服务器托管服务" {
		t.Fatalf("service note should remove Renewlet-facing advice: %#v", draft.Notes)
	}
}

func TestFillMissingAINotesWithDynamicFallback(t *testing.T) {
	website := aiSuggestedTextField{Value: "https://hostdzire.com/", Source: "suggested"}
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "HostDZire CloudVPS",
			Website:    &website,
			Notes:      nil,
			Tags:       []string{"VPS", "云主机"},
			Warnings:   []string{"AI_WARNING_NOTES_MISSING"},
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIChat, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	response = fillMissingAINotesWithDynamicFallback(response, localeZhCN, aiRecognitionConfigContext{})
	draft := response.Subscriptions[0]
	if draft.Notes == nil || draft.Notes.Value != "HostDZire CloudVPS 是提供 VPS、云主机相关产品或服务的订阅服务。" || draft.Notes.Source != "suggested" {
		t.Fatalf("missing notes should get dynamic fallback: %#v", draft.Notes)
	}
	if slices.Contains(draft.Warnings, "AI_WARNING_NOTES_MISSING") {
		t.Fatalf("fallback should remove stale missing-notes warning, got %#v", draft.Warnings)
	}
}

func TestNormalizeAIConfigValueKeepsUnknownNamesForImportCreation(t *testing.T) {
	category := "Cloud lab"
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "Lab",
			Category:   &category,
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIChat, "gpt-5.1", aiRecognitionConfigContext{
		Categories: []aiRecognitionConfigOption{{
			Value: "hosting_domains",
			Label: "域名与托管",
			ZhCN:  "域名与托管",
			EnUS:  "Domains & Hosting",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := response.Subscriptions[0].Category; got == nil || *got != "Cloud lab" {
		t.Fatalf("unknown category should be preserved for import config creation, got %#v", got)
	}
}

func TestAIRecognitionSchemaMismatchError(t *testing.T) {
	for _, err := range []error{
		errors.New("No object generated: response did not match schema."),
		errors.New("parsing structured output: invalid character 'o' looking for beginning of value (raw: ok)"),
	} {
		if !isAIRecognitionSchemaMismatchError(err) {
			t.Fatalf("expected schema mismatch error for %q", err.Error())
		}
	}
}
