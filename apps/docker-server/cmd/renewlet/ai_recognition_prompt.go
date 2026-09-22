package main

// ai_recognition_prompt.go 从 shared prompt JSON 生成 Go 运行面的提示词。
//
// shared/data/ai-recognition-prompt.json 是 Docker 与 Cloudflare 的事实源；Go 只读取 embedded 副本，
// 不能在运行面里手写另一套输出规则或字段解释。
import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	appstatic "github.com/zhiyingzzhou/renewlet/apps/docker-server/internal/static"
)

type aiRecognitionPromptSpec struct {
	Version        string                       `json:"version"`
	SchemaName     string                       `json:"schemaName"`
	System         []string                     `json:"system"`
	OutputContract []string                     `json:"outputContract"`
	FieldRules     []string                     `json:"fieldRules"`
	Examples       []aiRecognitionPromptExample `json:"examples"`
}

type aiRecognitionPromptExample struct {
	Input  string          `json:"input"`
	Output json.RawMessage `json:"output"`
}

type aiRecognitionConfigOption struct {
	Value string
	Label string
	ZhCN  string
	EnUS  string
}

type aiRecognitionConfigContext struct {
	Categories     []aiRecognitionConfigOption
	PaymentMethods []aiRecognitionConfigOption
	Tags           []string
}

var aiRecognitionPrompt = mustLoadAIRecognitionPrompt()

func mustLoadAIRecognitionPrompt() aiRecognitionPromptSpec {
	var spec aiRecognitionPromptSpec
	if err := json.Unmarshal(appstatic.AIRecognitionPrompt, &spec); err != nil {
		panic(fmt.Sprintf("load AI recognition prompt: %v", err))
	}
	if spec.Version == "" || spec.SchemaName == "" || len(spec.System) == 0 || len(spec.OutputContract) == 0 || len(spec.FieldRules) == 0 {
		panic("load AI recognition prompt: incomplete prompt spec")
	}
	return spec
}

func buildAIRecognitionSystemPrompt() string {
	return strings.Join(aiRecognitionPrompt.System, "\n")
}

func buildAIRecognitionUserPrompt(text string, timezone string, defaultCurrency string, imageCount int, locale appLocale, configContext aiRecognitionConfigContext) string {
	examples := make([]string, 0, len(aiRecognitionPrompt.Examples))
	for index, example := range aiRecognitionPrompt.Examples {
		examples = append(examples, strings.Join([]string{
			fmt.Sprintf("Example %d input:", index+1),
			example.Input,
			fmt.Sprintf("Example %d JSON output:", index+1),
			formatAIRecognitionPromptJSON(example.Output),
		}, "\n"))
	}
	userInput := strings.TrimSpace(text)
	if userInput == "" {
		userInput = "(no text input; use attached images)"
	}
	lines := []string{
		"Runtime context:",
		fmt.Sprintf("- Current date in user's timezone: %s", todayDateOnly(time.Now().UTC(), timezone)),
		fmt.Sprintf("- User timezone: %s", timezone),
		fmt.Sprintf("- User locale: %s", locale),
		fmt.Sprintf("- Default currency hint: %s", defaultCurrency),
		fmt.Sprintf("- Attached image count: %d", imageCount),
		"",
		"User context:",
		"Existing user tags:",
	}
	lines = append(lines, formatAIRecognitionTags(configContext.Tags)...)
	lines = append(lines,
		"",
		"Available Renewlet configuration options:",
		"Categories:",
	)
	lines = append(lines, formatAIRecognitionConfigOptions(configContext.Categories)...)
	lines = append(lines, "Payment methods:")
	lines = append(lines, formatAIRecognitionConfigOptions(configContext.PaymentMethods)...)
	lines = append(lines,
		"",
		"Task:",
		"- Extract subscriptions from the delimited user input below and any attached images.",
		"- Treat the dynamic user context as preferences and available options, not as subscription evidence.",
		"",
		"Output contract:",
	)
	lines = append(lines, prefixAIPromptRules(aiRecognitionPrompt.OutputContract)...)
	lines = append(lines, "", "Field rules:")
	lines = append(lines, prefixAIPromptRules(aiRecognitionPrompt.FieldRules)...)
	lines = append(lines, "", "Examples:", strings.Join(examples, "\n\n"), "", "User input:", "<<<renewlet-user-input", userInput, ">>>")
	return strings.Join(lines, "\n")
}

func buildAIRecognitionRepairUserPrompt(originalUserPrompt string, previousObject interface{}, missingNoteNames []string) string {
	// repair 只修补缺失备注，不允许引入本地品牌表或图标库；否则 Docker/Worker 会在同一输入上产生不同草稿。
	lines := []string{
		"Repair task:",
		"- The previous JSON object is structurally valid but some describable subscriptions have missing or unusable notes.",
		"- Regenerate the entire JSON object with the same output contract, field rules, and all subscriptions.",
		"- Do not use a hardcoded service table, brand mapping, icon database, region list, operating system list, or local fallback knowledge.",
		"- For the subscription names below, notes.value must be a concise service/site description unless the service purpose is truly unknowable.",
	}
	for _, name := range missingNoteNames {
		lines = append(lines, "  - "+name)
	}
	lines = append(lines,
		"- Use only the original input/images, high-confidence public knowledge, and dynamic fields already present in the previous object: service name, website/domain, category, and stable tags.",
		"",
		"Original recognition prompt:",
		"<<<renewlet-original-prompt",
		originalUserPrompt,
		">>>",
		"",
		"Previous JSON object:",
		"<<<renewlet-previous-json",
		aiRecognitionJSONText(previousObject),
		">>>",
	)
	return strings.Join(lines, "\n")
}

func formatAIRecognitionTags(tags []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, tag := range tags {
		value := strings.TrimSpace(tag)
		key := strings.ToLower(value)
		if value == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, "- "+value)
		if len(out) >= 200 {
			// 标签上下文只提供偏好提示；过多用户历史标签会稀释订阅证据并放大 prompt 成本。
			break
		}
	}
	if len(out) == 0 {
		return []string{"- (none)"}
	}
	return out
}

func formatAIRecognitionConfigOptions(options []aiRecognitionConfigOption) []string {
	if len(options) == 0 {
		return []string{"- (none)"}
	}
	limit := len(options)
	if limit > 200 {
		limit = 200
	}
	out := make([]string, 0, limit)
	for _, option := range options[:limit] {
		out = append(out, fmt.Sprintf("- value=%s | label=%s | zh-CN=%s | en-US=%s", option.Value, option.Label, option.ZhCN, option.EnUS))
	}
	return out
}

func prefixAIPromptRules(rules []string) []string {
	out := make([]string, 0, len(rules))
	for _, rule := range rules {
		out = append(out, "- "+rule)
	}
	return out
}

func formatAIRecognitionPromptJSON(raw json.RawMessage) string {
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err == nil {
		return buf.String()
	}
	return string(raw)
}
