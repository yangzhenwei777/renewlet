package main

// ai_recognition_diagnostics.go 构造 AI 识别的临时排障信息。
//
// diagnostics 只随当前认证 API 响应返回，不入库、不导出；prompt、raw 输出、provider metadata 和图片信息
// 必须在这里统一脱敏/截断，避免第三方 key、Bearer、JWT、cookie 或 base64 图片泄漏到浏览器日志。
import (
	"encoding/json"
	"errors"
	"strings"
)

const (
	aiRecognitionDiagnosticSchemaVersion = "1"
	aiRecognitionDiagnosticTextMaxChars  = 32000
	aiRecognitionDiagnosticJSONMaxChars  = 32000
)

type aiRecognitionDiagnosticText struct {
	Value     string `json:"value"`
	Truncated bool   `json:"truncated"`
}

type aiRecognitionDiagnostics struct {
	SchemaVersion string                          `json:"schemaVersion"`
	PromptVersion string                          `json:"promptVersion"`
	SchemaName    string                          `json:"schemaName"`
	Prompt        aiRecognitionDiagnosticPrompt   `json:"prompt"`
	Output        aiRecognitionDiagnosticOutput   `json:"output"`
	Request       aiRecognitionDiagnosticRequest  `json:"request"`
	Response      aiRecognitionDiagnosticResponse `json:"response"`
}

type aiRecognitionDiagnosticPrompt struct {
	System aiRecognitionDiagnosticText `json:"system"`
	User   aiRecognitionDiagnosticText `json:"user"`
}

type aiRecognitionDiagnosticOutput struct {
	RawModelText  *aiRecognitionDiagnosticText `json:"rawModelText"`
	RawObjectJSON *aiRecognitionDiagnosticText `json:"rawObjectJson"`
}

type aiRecognitionDiagnosticRequest struct {
	ProviderType      string                         `json:"providerType"`
	TransportProtocol string                         `json:"transportProtocol"`
	Model             string                         `json:"model"`
	ThinkingControl   *aiThinkingControl             `json:"thinkingControl"`
	MaxOutputTokens   int                            `json:"maxOutputTokens"`
	TextCharCount     int                            `json:"textCharCount"`
	Images            []aiRecognitionDiagnosticImage `json:"images"`
}

type aiRecognitionDiagnosticImage struct {
	MediaType string `json:"mediaType"`
	SizeBytes int    `json:"sizeBytes"`
}

type aiRecognitionDiagnosticResponse struct {
	Usage            interface{} `json:"usage"`
	FinishReason     *string     `json:"finishReason"`
	ProviderMetadata interface{} `json:"providerMetadata"`
}

type aiRecognitionCapture struct {
	rawModelText     string
	usage            interface{}
	finishReason     string
	providerMetadata interface{}
}

type aiRecognitionRunError struct {
	cause       error
	diagnostics aiRecognitionDiagnostics
}

func (err *aiRecognitionRunError) Error() string {
	if err == nil || err.cause == nil {
		return "AI_RECOGNITION_FAILED"
	}
	return err.cause.Error()
}

func (err *aiRecognitionRunError) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.cause
}

func buildAIRecognitionDiagnostics(settings aiRecognitionSettings, input aiRecognitionInput, systemPrompt string, userPrompt string, rawModelText string, rawObject interface{}, usage interface{}, finishReason string, providerMetadata interface{}) aiRecognitionDiagnostics {
	images := make([]aiRecognitionDiagnosticImage, 0, len(input.Images))
	for _, image := range input.Images {
		// 图片诊断只暴露类型和大小，绝不返回 data URL/base64；用户可据此排查输入规模而不泄漏内容。
		images = append(images, aiRecognitionDiagnosticImage{MediaType: image.MediaType, SizeBytes: image.SizeBytes})
	}
	diagnostics := aiRecognitionDiagnostics{
		SchemaVersion: aiRecognitionDiagnosticSchemaVersion,
		PromptVersion: aiRecognitionPrompt.Version,
		SchemaName:    aiRecognitionPrompt.SchemaName,
		Prompt: aiRecognitionDiagnosticPrompt{
			System: diagnosticAIRecognitionText(systemPrompt, aiRecognitionDiagnosticTextMaxChars),
			User:   diagnosticAIRecognitionText(userPrompt, aiRecognitionDiagnosticTextMaxChars),
		},
		Output: aiRecognitionDiagnosticOutput{
			RawModelText:  diagnosticAIRecognitionOptionalText(rawModelText, aiRecognitionDiagnosticTextMaxChars),
			RawObjectJSON: diagnosticAIRecognitionOptionalText(aiRecognitionJSONText(rawObject), aiRecognitionDiagnosticJSONMaxChars),
		},
		Request: aiRecognitionDiagnosticRequest{
			ProviderType:      settings.ProviderType,
			TransportProtocol: settings.TransportProtocol,
			Model:             settings.Model,
			ThinkingControl:   input.ThinkingControl,
			MaxOutputTokens:   aiRecognitionOutputTokenLimit(input),
			TextCharCount:     len([]rune(input.Text)),
			Images:            images,
		},
		Response: aiRecognitionDiagnosticResponse{
			Usage:            sanitizeAIRecognitionDiagnosticJSON(usage),
			FinishReason:     optionalAIRecognitionString(finishReason),
			ProviderMetadata: sanitizeAIRecognitionDiagnosticJSON(providerMetadata),
		},
	}
	return diagnostics
}

func diagnosticAIRecognitionOptionalText(value string, maxChars int) *aiRecognitionDiagnosticText {
	if value == "" {
		return nil
	}
	text := diagnosticAIRecognitionText(value, maxChars)
	return &text
}

func diagnosticAIRecognitionText(value string, maxChars int) aiRecognitionDiagnosticText {
	safe := redactAIRecognitionSecrets(value)
	runes := []rune(safe)
	if len(runes) > maxChars {
		return aiRecognitionDiagnosticText{Value: string(runes[:maxChars]), Truncated: true}
	}
	return aiRecognitionDiagnosticText{Value: safe, Truncated: false}
}

func aiRecognitionJSONText(value interface{}) string {
	if value == nil {
		return ""
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err.Error()
	}
	return string(data)
}

func sanitizeAIRecognitionDiagnosticJSON(value interface{}) interface{} {
	if value == nil {
		return nil
	}
	text := diagnosticAIRecognitionText(aiRecognitionJSONText(value), aiRecognitionDiagnosticJSONMaxChars)
	if text.Truncated {
		// JSON 超限时保持文本形态，避免截断后的半截 JSON 被误解析成可信 provider metadata。
		return text
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(text.Value), &parsed); err != nil {
		return text
	}
	return parsed
}

func optionalAIRecognitionString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func aiRecognitionDiagnosticsFromError(err error) *aiRecognitionDiagnostics {
	var runErr *aiRecognitionRunError
	if errors.As(err, &runErr) {
		return &runErr.diagnostics
	}
	return nil
}

func aiRecognitionCauseError(err error) error {
	var runErr *aiRecognitionRunError
	if errors.As(err, &runErr) {
		return runErr.cause
	}
	return err
}

func aiRecognitionRawTextFromError(err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	const marker = "(raw: "
	index := strings.LastIndex(message, marker)
	if index < 0 {
		return ""
	}
	raw := message[index+len(marker):]
	return strings.TrimSuffix(raw, ")")
}
