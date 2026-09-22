/**
 * AI 识别提示词构造器是 Docker Go 与 Cloudflare Worker 的共同事实源。
 *
 * prompt JSON 记录可审阅的系统规则、字段规则和示例；运行时代码只注入用户上下文，
 * 避免两个后端各自维护一份不可对齐的提示词。
 */
import { z } from "zod";
import promptSpecJson from "../data/ai-recognition-prompt.json";

const promptExampleSchema = z.object({
  input: z.string(),
  output: z.unknown(),
}).strict();

const promptSpecSchema = z.object({
  version: z.string().min(1),
  schemaName: z.string().min(1),
  system: z.array(z.string().min(1)).min(1),
  outputContract: z.array(z.string().min(1)).min(1),
  fieldRules: z.array(z.string().min(1)).min(1),
  examples: z.array(promptExampleSchema).min(1),
}).strict();

export const aiRecognitionPromptSpec = promptSpecSchema.parse(promptSpecJson);
export const AI_RECOGNITION_PROMPT_VERSION = aiRecognitionPromptSpec.version;
export const AI_RECOGNITION_SCHEMA_NAME = aiRecognitionPromptSpec.schemaName;

/** 配置选项同时保留 value 与双语标签，让模型能优先复用用户已存在的分类/支付方式。 */
export interface AIRecognitionPromptConfigOption {
  value: string;
  label: string;
  zhCN: string;
  enUS: string;
}

/** 动态上下文只提供偏好与候选，不构成识别证据；模型不能凭这些选项虚构订阅。 */
export interface AIRecognitionPromptConfigContext {
  categories: readonly AIRecognitionPromptConfigOption[];
  paymentMethods: readonly AIRecognitionPromptConfigOption[];
  tags: readonly string[];
}

/** 系统 prompt 固定来自版本化 JSON，便于 Go/Worker diagnostics 回显同一个 promptVersion。 */
export function buildAIRecognitionSystemPrompt(): string {
  return aiRecognitionPromptSpec.system.join("\n");
}

/**
 * 构造单次识别 user prompt。
 *
 * 日期、时区、默认币种和现有配置都随请求注入；它们帮助模型解释输入，但不能绕过最终 schema/normalize。
 */
export function buildAIRecognitionUserPrompt({
  text,
  timezone,
  defaultCurrency,
  currentDate,
  imageCount,
  locale,
  configContext = { categories: [], paymentMethods: [], tags: [] },
}: {
  text: string;
  timezone: string;
  defaultCurrency: string;
  currentDate: string;
  imageCount: number;
  locale: string;
  configContext?: AIRecognitionPromptConfigContext;
}): string {
  const examples = aiRecognitionPromptSpec.examples.map((example, index) => [
    `Example ${index + 1} input:`,
    example.input,
    `Example ${index + 1} JSON output:`,
    JSON.stringify(example.output, null, 2),
  ].join("\n")).join("\n\n");

  const userInput = text.trim() || "(no text input; use attached images)";

  return [
    "Runtime context:",
    `- Current date in user's timezone: ${currentDate}`,
    `- User timezone: ${timezone}`,
    `- User locale: ${locale}`,
    `- Default currency hint: ${defaultCurrency}`,
    `- Attached image count: ${imageCount}`,
    "",
    "User context:",
    "Existing user tags:",
    ...formatTagsForPrompt(configContext.tags),
    "",
    "Available Renewlet configuration options:",
    "Categories:",
    ...formatConfigOptionsForPrompt(configContext.categories),
    "Payment methods:",
    ...formatConfigOptionsForPrompt(configContext.paymentMethods),
    "",
    "Task:",
    "- Extract subscriptions from the delimited user input below and any attached images.",
    "- Treat the dynamic user context as preferences and available options, not as subscription evidence.",
    "",
    "Output contract:",
    ...aiRecognitionPromptSpec.outputContract.map((rule) => `- ${rule}`),
    "",
    "Field rules:",
    ...aiRecognitionPromptSpec.fieldRules.map((rule) => `- ${rule}`),
    "",
    "Examples:",
    examples,
    "",
    "User input:",
    "<<<renewlet-user-input",
    userInput,
    ">>>",
  ].join("\n");
}

/**
 * 构造 schema repair prompt。
 *
 * Repair 只允许基于原始输入、图片、前一轮 JSON 和高置信公共知识补齐 notes，不能引入本地品牌表。
 */
export function buildAIRecognitionRepairUserPrompt({
  originalUserPrompt,
  previousObject,
  missingNoteNames,
}: {
  originalUserPrompt: string;
  previousObject: unknown;
  missingNoteNames: readonly string[];
}): string {
  return [
    "Repair task:",
    "- The previous JSON object is structurally valid but some describable subscriptions have missing or unusable notes.",
    "- Regenerate the entire JSON object with the same output contract, field rules, and all subscriptions.",
    "- Do not use a hardcoded service table, brand mapping, icon database, region list, operating system list, or local fallback knowledge.",
    "- For the subscription names below, notes.value must be a concise service/site description unless the service purpose is truly unknowable.",
    ...missingNoteNames.map((name) => `  - ${name}`),
    "- Use only the original input/images, high-confidence public knowledge, and dynamic fields already present in the previous object: service name, website/domain, category, and stable tags.",
    "",
    "Original recognition prompt:",
    "<<<renewlet-original-prompt",
    originalUserPrompt,
    ">>>",
    "",
    "Previous JSON object:",
    "<<<renewlet-previous-json",
    JSON.stringify(previousObject, null, 2),
    ">>>",
  ].join("\n");
}

function formatTagsForPrompt(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const value = tag.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(`- ${value}`);
    if (out.length >= 200) break;
  }
  return out.length === 0 ? ["- (none)"] : out;
}

function formatConfigOptionsForPrompt(options: readonly AIRecognitionPromptConfigOption[]): string[] {
  if (options.length === 0) return ["- (none)"];
  return options.slice(0, 200).map((option) => {
    const parts = [
      `value=${option.value}`,
      `label=${option.label}`,
      `zh-CN=${option.zhCN}`,
      `en-US=${option.enUS}`,
    ];
    return `- ${parts.join(" | ")}`;
  });
}
