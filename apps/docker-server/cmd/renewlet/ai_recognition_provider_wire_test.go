package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zendev-sh/goai"
	"github.com/zendev-sh/goai/provider"
)

func TestAIRecognitionNativeProviderTokenParametersOnWire(t *testing.T) {
	requests := make(chan struct {
		path string
		body map[string]any
	}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode provider request: %v", err)
			return
		}
		requests <- struct {
			path string
			body map[string]any
		}{path: r.URL.Path, body: body}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/messages":
			_, _ = fmt.Fprint(w, `{"id":"msg_test","type":"message","role":"assistant","content":[{"type":"text","text":"OK"}],"model":"claude-sonnet-4-6","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
		case "/v1beta/models/gemini-3-flash:generateContent":
			_, _ = fmt.Fprint(w, `{"candidates":[{"content":{"parts":[{"text":"OK"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}`)
		default:
			t.Errorf("unexpected provider path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	t.Run("anthropic Claude keeps max_tokens", func(t *testing.T) {
		err := testAIRecognitionConnection(context.Background(), aiRecognitionSettings{
			ProviderType:      aiProviderTypeAnthropic,
			TransportProtocol: aiProtocolAnthropicMessages,
			Model:             "claude-sonnet-4-6",
			BaseURL:           server.URL,
			APIKey:            "sk-ant-test",
		})
		if err != nil {
			t.Fatalf("Anthropic connection test failed: %v", err)
		}
		request := <-requests
		if request.path != "/v1/messages" {
			t.Fatalf("Anthropic request path = %q", request.path)
		}
		if _, ok := request.body["max_tokens"]; !ok {
			t.Fatalf("Anthropic request should contain max_tokens: %#v", request.body)
		}
		if _, ok := request.body["max_completion_tokens"]; ok {
			t.Fatalf("Anthropic request must not contain max_completion_tokens: %#v", request.body)
		}
	})

	t.Run("Gemini keeps native generationConfig", func(t *testing.T) {
		err := testAIRecognitionConnection(context.Background(), aiRecognitionSettings{
			ProviderType:      aiProviderTypeGemini,
			TransportProtocol: aiProtocolGeminiGenerateContent,
			Model:             "gemini-3-flash",
			BaseURL:           server.URL,
			APIKey:            "AIza-test",
		})
		if err != nil {
			t.Fatalf("Gemini connection test failed: %v", err)
		}
		request := <-requests
		if request.path != "/v1beta/models/gemini-3-flash:generateContent" {
			t.Fatalf("Gemini request path = %q", request.path)
		}
		generationConfig, ok := request.body["generationConfig"].(map[string]any)
		if !ok {
			t.Fatalf("Gemini request missing generationConfig: %#v", request.body)
		}
		if _, ok := generationConfig["maxOutputTokens"]; !ok {
			t.Fatalf("Gemini generationConfig should contain maxOutputTokens: %#v", generationConfig)
		}
		if _, ok := request.body["max_tokens"]; ok {
			t.Fatalf("Gemini request must not contain max_tokens: %#v", request.body)
		}
	})
}

func TestRequiresOpenAIMaxCompletionTokens(t *testing.T) {
	tests := []struct {
		model string
		want  bool
	}{
		{model: "gpt-6-sol", want: true},
		{model: "gpt-6.1", want: true},
		{model: "gpt-7", want: true},
		{model: "gpt-6-chat", want: false},
		{model: "gpt-6.1-chat", want: false},
		{model: "gpt-6-chat-latest", want: false},
		{model: "gpt-5.1", want: false},
		{model: "o3", want: false},
		{model: "openai/gpt-6-sol", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.model, func(t *testing.T) {
			if got := requiresOpenAIMaxCompletionTokens(tt.model); got != tt.want {
				t.Fatalf("requiresOpenAIMaxCompletionTokens(%q) = %v, want %v", tt.model, got, tt.want)
			}
		})
	}
}

func TestAIRecognitionTokenParameterSelectionOnWire(t *testing.T) {
	requests := make(chan map[string]any, 10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected OpenAI Chat path: %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
			return
		}
		requests <- body
		if streaming, _ := body["stream"].(bool); streaming {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"OK\"}}]}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"id":"chatcmpl-test","choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}`)
	}))
	defer server.Close()

	var gpt6Model provider.LanguageModel
	previousModelFactory := newAIRecognitionModelForConnection
	newAIRecognitionModelForConnection = func(settings aiRecognitionSettings) (provider.LanguageModel, error) {
		model, err := newAIRecognitionModel(settings)
		if err == nil && settings.ProviderType == aiProviderTypeOpenAI && settings.Model == "gpt-6-sol" {
			gpt6Model = model
		}
		return model, err
	}
	t.Cleanup(func() {
		newAIRecognitionModelForConnection = previousModelFactory
	})

	tests := []struct {
		name         string
		providerType string
		model        string
		want         string
	}{
		{name: "official GPT-6", providerType: aiProviderTypeOpenAI, model: "gpt-6-sol", want: "max_completion_tokens"},
		{name: "official GPT-6.1", providerType: aiProviderTypeOpenAI, model: "gpt-6.1", want: "max_completion_tokens"},
		{name: "official GPT-6 chat", providerType: aiProviderTypeOpenAI, model: "gpt-6-chat", want: "max_tokens"},
		{name: "official GPT-5 reasoning", providerType: aiProviderTypeOpenAI, model: "gpt-5.1", want: "max_completion_tokens"},
		{name: "official o-series reasoning", providerType: aiProviderTypeOpenAI, model: "o4-mini", want: "max_completion_tokens"},
		{name: "official codex reasoning", providerType: aiProviderTypeOpenAI, model: "codex-mini", want: "max_completion_tokens"},
		{name: "official GPT-5 chat", providerType: aiProviderTypeOpenAI, model: "gpt-5-chat", want: "max_tokens"},
		{name: "official GPT-4o", providerType: aiProviderTypeOpenAI, model: "gpt-4o", want: "max_tokens"},
		{name: "OpenAI-compatible GPT-6", providerType: aiProviderTypeOpenAICompatible, model: "gpt-6-sol", want: "max_tokens"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := testAIRecognitionConnection(context.Background(), aiRecognitionSettings{
				ProviderType:      tt.providerType,
				TransportProtocol: aiProtocolOpenAIChat,
				Model:             tt.model,
				BaseURL:           server.URL,
				APIKey:            "sk-test",
			})
			if err != nil {
				t.Fatalf("connection test failed: %v", err)
			}
			body := <-requests
			if _, ok := body[tt.want]; !ok {
				t.Fatalf("request should contain %q: %#v", tt.want, body)
			}
			unexpected := "max_tokens"
			if tt.want == unexpected {
				unexpected = "max_completion_tokens"
			}
			if _, ok := body[unexpected]; ok {
				t.Fatalf("request should not contain %q: %#v", unexpected, body)
			}
		})
	}

	if gpt6Model == nil {
		t.Fatal("connection test did not construct the official GPT-6 model")
	}
	stream, err := goai.StreamText(context.Background(), gpt6Model,
		goai.WithPrompt(aiRecognitionTestPrompt),
		goai.WithMaxOutputTokens(aiRecognitionTestProviderTokens),
		goai.WithMaxRetries(0),
		goai.WithProviderOptions(map[string]any{"useResponsesAPI": false}),
	)
	if err != nil {
		t.Fatalf("streaming connection test failed: %v", err)
	}
	for range stream.Stream() {
	}
	if err := stream.Err(); err != nil {
		t.Fatalf("streaming response failed: %v", err)
	}
	body := <-requests
	if _, ok := body["max_completion_tokens"]; !ok {
		t.Fatalf("streaming request should contain max_completion_tokens: %#v", body)
	}
	if _, ok := body["max_tokens"]; ok {
		t.Fatalf("streaming request should not contain max_tokens: %#v", body)
	}
}
