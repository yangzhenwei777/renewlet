const AI_RECOGNITION_PROCESS_NOTE_FRAGMENTS = [
  "ai根据",
  "ai建议",
  "ai未能",
  "ai无法",
  "ai生成",
  "ai猜测",
  "输入没有",
  "输入未",
  "用户输入",
  "原文",
  "图片未",
  "图像未",
  "表格未",
  "无法确定",
  "不能确定",
  "不确定",
  "未能确定",
  "未能高置信识别",
  "无法识别",
  "未明确",
  "未提供",
  "没有提供",
  "请确认",
  "需要确认",
  "确认后",
  "低置信",
  "高置信识别",
  "模型返回",
  "模型输出",
  "模型无法",
  "aigenerated",
  "aiguessed",
  "theinputdoesnot",
  "inputdoesnot",
  "inputdidnot",
  "notprovided",
  "notspecified",
  "uncertain",
  "cannotdetermine",
  "cantdetermine",
  "pleaseconfirm",
  "lowconfidence",
  "modeloutput",
  "modelreturned",
] as const;

const AI_RECOGNITION_NOTE_DROP_CLAUSE_FRAGMENTS = [
  "适合记录",
  "可用于记录",
  "用于记录",
  "便于记录",
  "方便记录",
  "订阅管理",
  "套餐订阅",
  "请确认",
  "需要确认",
  "导入",
  "renewlet",
  "suitableforrecording",
  "canbeusedtorecord",
  "usedtorecord",
  "subscriptionmanagement",
  "pleaseconfirm",
  "import",
] as const;

const AI_RECOGNITION_NOTE_MARKETING_FRAGMENTS = [
  "优质",
  "领先",
  "专业",
  "全方位",
  "一站式",
  "可靠",
  "高性能",
  "稳定",
  "premium",
  "leading",
  "professional",
  "comprehensive",
  "all-in-one",
] as const;

/**
 * 清洗 AI 识别草稿中的长期备注。
 *
 * AI 备注会进入订阅长期记录；这里只兜底清掉识别过程、产品内视角和营销套话，保留真实服务/网站简介。
 */
export function normalizeAIRecognitionUsefulNotes(value: string | null | undefined, maxLength = 5000): string | null {
  const text = trimMax(value ?? "", maxLength);
  if (!text || isAIRecognitionProcessNote(text)) return null;
  const withoutAdvice = stripAIRecognitionAdviceClauses(text);
  if (!withoutAdvice || isAIRecognitionProcessNote(withoutAdvice) || isAIRecognitionMarketingNote(withoutAdvice)) return null;
  return trimMax(cleanAIRecognitionServiceDescription(withoutAdvice), maxLength) || null;
}

/** 识别模型推理、低置信提示或“请确认”类备注；这些内容不应随订阅导入长期入库。 */
export function isAIRecognitionProcessNote(value: string): boolean {
  const key = recognitionNoteMatchKey(value);
  return Boolean(key) && AI_RECOGNITION_PROCESS_NOTE_FRAGMENTS.some((fragment) => key.includes(fragment));
}

function recognitionNoteMatchKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
}

function stripAIRecognitionAdviceClauses(value: string): string {
  const clauses = value.split(/(?<=[。.!?！？；;])|[，,]/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !AI_RECOGNITION_NOTE_DROP_CLAUSE_FRAGMENTS.some((fragment) => recognitionNoteMatchKey(part).includes(fragment)));
  return clauses.join("，").replace(/，([。.!?！？；;])/g, "$1").trim();
}

function isAIRecognitionMarketingNote(value: string): boolean {
  const key = recognitionNoteMatchKey(value);
  return Boolean(key) && AI_RECOGNITION_NOTE_MARKETING_FRAGMENTS.some((fragment) => key.includes(fragment));
}

function cleanAIRecognitionServiceDescription(value: string): string {
  return value
    .replace(/相关服务/g, "服务")
    .replace(/等服务服务/g, "等服务")
    .replace(/服务服务/g, "服务")
    .replace(/\s+/g, " ")
    .trim();
}

function trimMax(value: string, maxLength: number): string {
  return [...value.trim()].slice(0, maxLength).join("");
}
