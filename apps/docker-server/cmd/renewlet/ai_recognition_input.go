package main

// ai_recognition_input.go 负责读取 AI 识别 multipart 输入。
//
// 文本、图片和 thinking control 都是用户会直接发往第三方 provider 的敏感输入；这里先做总量限制、
// 图片类型白名单和 strict JSON control 校验，避免服务端代理成为大文件或未知配置入口。
import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

func readAIRecognitionMultipart(e *core.RequestEvent, locale appLocale) (aiRecognitionInput, error) {
	// MaxBytesReader 覆盖 multipart 头部开销，单个 part 仍单独限额；两层限制共同防止绕过图片数量预算。
	maxBodyBytes := int64(aiRecognitionMaxTextChars*4 + aiRecognitionMaxImages*aiRecognitionMaxImageBytes + aiRecognitionMultipartOverhead)
	e.Request.Body = http.MaxBytesReader(e.Response, e.Request.Body, maxBodyBytes)
	reader, err := e.Request.MultipartReader()
	if err != nil {
		return aiRecognitionInput{}, err
	}
	var input aiRecognitionInput
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if strings.Contains(err.Error(), "request body too large") {
				return aiRecognitionInput{}, errAIRecognitionBodyTooLarge
			}
			return aiRecognitionInput{}, err
		}
		if err := readAIRecognitionPart(part, &input, locale); err != nil {
			return aiRecognitionInput{}, err
		}
	}
	input.Text = strings.TrimSpace(input.Text)
	if len([]rune(input.Text)) > aiRecognitionMaxTextChars {
		return aiRecognitionInput{}, errAIRecognitionBodyTooLarge
	}
	if input.Text == "" && len(input.Images) == 0 {
		return aiRecognitionInput{}, errAIRecognitionInputEmpty
	}
	return input, nil
}

func readAIRecognitionPart(part *multipart.Part, input *aiRecognitionInput, locale appLocale) error {
	defer func() { _ = part.Close() }()
	switch part.FormName() {
	case "text":
		data, err := readLimitedPartBytes(part, aiRecognitionMaxTextChars*4)
		if err != nil {
			return err
		}
		input.Text = string(data)
	case "thinkingControl":
		data, err := readLimitedPartBytes(part, aiRecognitionThinkingControlMax)
		if err != nil {
			return err
		}
		control, err := parseAIThinkingControl(data, locale)
		if err != nil {
			return err
		}
		input.ThinkingControl = control
	case "images", "images[]":
		if len(input.Images) >= aiRecognitionMaxImages {
			return errAIRecognitionBodyTooLarge
		}
		data, err := readLimitedPartBytes(part, aiRecognitionMaxImageBytes)
		if err != nil {
			return err
		}
		if len(data) == 0 {
			return nil
		}
		mediaType, err := normalizeAIRecognitionImageType(part.Header.Get("Content-Type"), data)
		if err != nil {
			return err
		}
		input.Images = append(input.Images, aiRecognitionImage{
			MediaType: mediaType,
			DataURL:   fmt.Sprintf("data:%s;base64,%s", mediaType, base64.StdEncoding.EncodeToString(data)),
			SizeBytes: len(data),
		})
	case "":
		return errors.New("AI_RECOGNITION_MULTIPART_FIELD_INVALID")
	default:
		return errors.New("AI_RECOGNITION_MULTIPART_FIELD_INVALID")
	}
	return nil
}

func readLimitedPartBytes(reader io.Reader, maxBytes int) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, int64(maxBytes)+1))
	if err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			return nil, errAIRecognitionBodyTooLarge
		}
		return nil, err
	}
	if len(data) > maxBytes {
		return nil, errAIRecognitionBodyTooLarge
	}
	return data, nil
}

func normalizeAIRecognitionImageType(header string, data []byte) (string, error) {
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(header, ";")[0]))
	if isAllowedAIRecognitionImageType(contentType) {
		return contentType, nil
	}
	detected := strings.ToLower(http.DetectContentType(data[:minInt(len(data), 512)]))
	if isAllowedAIRecognitionImageType(detected) {
		return detected, nil
	}
	return "", errors.New("AI_RECOGNITION_IMAGE_TYPE_INVALID")
}

func isAllowedAIRecognitionImageType(value string) bool {
	return value == "image/png" || value == "image/jpeg" || value == "image/webp"
}

func parseAIThinkingControl(data []byte, locale appLocale) (*aiThinkingControl, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	control, err := decodeStrictJSONFromBytes[aiThinkingControl]([]byte(trimmed), locale, false)
	if err != nil {
		return nil, err
	}
	if err := validateAIThinkingControl(&control); err != nil {
		return nil, err
	}
	return &control, nil
}

func (settings *aiRecognitionSettings) UnmarshalJSON(data []byte) error {
	// settings 来自持久化用户配置；手写 allowed map 保留严格未知字段边界，同时兼容历史 provider 字段。
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	allowed := map[string]struct{}{
		"provider":               {},
		"providerType":           {},
		"transportProtocol":      {},
		"model":                  {},
		"modelInputMode":         {},
		"baseUrl":                {},
		"apiKey":                 {},
		"defaultThinkingControl": {},
	}
	for key := range raw {
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("json: unknown field %q", key)
		}
	}
	type aiRecognitionSettingsJSON struct {
		Provider               string             `json:"provider"`
		ProviderType           string             `json:"providerType"`
		TransportProtocol      string             `json:"transportProtocol"`
		Model                  string             `json:"model"`
		ModelInputMode         string             `json:"modelInputMode"`
		BaseURL                string             `json:"baseUrl"`
		APIKey                 string             `json:"apiKey"`
		DefaultThinkingControl *aiThinkingControl `json:"defaultThinkingControl"`
	}
	var input aiRecognitionSettingsJSON
	if err := json.Unmarshal(data, &input); err != nil {
		return err
	}
	providerType := firstNonBlank(input.ProviderType, input.Provider)
	*settings = aiRecognitionSettings{
		ProviderType:           providerType,
		TransportProtocol:      input.TransportProtocol,
		Model:                  input.Model,
		ModelInputMode:         input.ModelInputMode,
		BaseURL:                input.BaseURL,
		APIKey:                 input.APIKey,
		DefaultThinkingControl: input.DefaultThinkingControl,
	}
	if isValidAIRecognitionProviderType(providerType) {
		settings.TransportProtocol = canonicalAIRecognitionTransportProtocol(providerType)
	}
	return nil
}

func validateAIThinkingControl(control *aiThinkingControl) error {
	if control == nil {
		return nil
	}
	switch control.Provider {
	case "openai":
		if !slices.Contains([]string{"none", "minimal", "low", "medium", "high", "xhigh"}, control.Effort) {
			return errors.New("AI_THINKING_CONTROL_INVALID")
		}
	case "gemini":
		switch control.Mode {
		case "off", "dynamic":
			return nil
		case "budget":
			if control.Budget == nil || *control.Budget < 1 || *control.Budget > 32768 {
				return errors.New("AI_THINKING_CONTROL_INVALID")
			}
		case "level":
			if !slices.Contains([]string{"minimal", "low", "medium", "high"}, control.Level) {
				return errors.New("AI_THINKING_CONTROL_INVALID")
			}
		default:
			return errors.New("AI_THINKING_CONTROL_INVALID")
		}
	case "anthropic":
		switch control.Mode {
		case "effort":
			if !slices.Contains([]string{"low", "medium", "high", "xhigh", "max"}, control.Effort) {
				return errors.New("AI_THINKING_CONTROL_INVALID")
			}
		case "budget":
			if control.BudgetTokens == nil || *control.BudgetTokens < 1024 || *control.BudgetTokens > 64000 {
				return errors.New("AI_THINKING_CONTROL_INVALID")
			}
		default:
			return errors.New("AI_THINKING_CONTROL_INVALID")
		}
	default:
		return errors.New("AI_THINKING_CONTROL_INVALID")
	}
	return nil
}

func sanitizeAIRecognitionSettings(settings aiRecognitionSettings) aiRecognitionSettings {
	settings.ProviderType = strings.TrimSpace(settings.ProviderType)
	if !isValidAIRecognitionProviderType(settings.ProviderType) {
		settings.ProviderType = aiProviderTypeOpenAI
	}
	settings.TransportProtocol = canonicalAIRecognitionTransportProtocol(settings.ProviderType)
	settings.Model = strings.TrimSpace(settings.Model)
	settings.ModelInputMode = strings.TrimSpace(settings.ModelInputMode)
	if settings.ModelInputMode != "manual" {
		settings.ModelInputMode = "select"
	}
	settings.BaseURL = sanitizeAIRecognitionBaseURL(settings.BaseURL)
	settings.APIKey = strings.TrimSpace(settings.APIKey)
	if settings.DefaultThinkingControl != nil {
		if err := validateAIThinkingControl(settings.DefaultThinkingControl); err != nil || !aiThinkingControlMatchesSettings(settings, settings.DefaultThinkingControl) {
			// 设置页保存的是“上次可用控制项”；provider/model 切换后不兼容值必须在读取边界丢弃。
			settings.DefaultThinkingControl = nil
		}
	}
	return settings
}

func isValidAIRecognitionProviderType(value string) bool {
	return value == aiProviderTypeOpenAI || value == aiProviderTypeGemini || value == aiProviderTypeAnthropic || value == aiProviderTypeOpenAICompatible
}

func aiThinkingControlMatchesSettings(settings aiRecognitionSettings, control *aiThinkingControl) bool {
	if control == nil {
		return true
	}
	switch settings.TransportProtocol {
	case aiProtocolOpenAIChat:
		return settings.ProviderType == aiProviderTypeOpenAI && control.Provider == aiProviderTypeOpenAI
	case aiProtocolAnthropicMessages:
		return settings.ProviderType == aiProviderTypeAnthropic && control.Provider == aiProviderTypeAnthropic
	case aiProtocolGeminiGenerateContent:
		return settings.ProviderType == aiProviderTypeGemini && control.Provider == aiProviderTypeGemini
	default:
		return false
	}
}

func sanitizeAIRecognitionBaseURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return ""
	}
	return value
}

func validateAIRecognitionSettings(settings aiRecognitionSettings, locale appLocale) error {
	settings = sanitizeAIRecognitionSettings(settings)
	if settings.Model == "" {
		return errors.New(serverText(locale, "aiRecognition.modelRequired"))
	}
	endpoint := resolveAIProviderEndpoint(settings)
	if endpoint.BaseURLRequired {
		if settings.BaseURL == "" {
			return errors.New(serverText(locale, "aiRecognition.baseUrlRequired"))
		}
	}
	if endpoint.APIKeyRequired && settings.APIKey == "" {
		return errors.New(serverText(locale, "aiRecognition.apiKeyRequired"))
	}
	return nil
}
