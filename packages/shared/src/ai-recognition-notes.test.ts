// AI notes 测试保护“长期备注只保存服务简介”的导入边界，避免模型过程提示被写入订阅记录。
import { describe, expect, it } from "vitest";
import { normalizeAIRecognitionUsefulNotes } from "./ai-recognition-notes";
import { buildAIRecognitionUserPrompt } from "./ai-recognition-prompt";

describe("AI recognition notes", () => {
  it("keeps service and website notes but removes recognition process text", () => {
    expect(normalizeAIRecognitionUsefulNotes("LOCVPS 是面向 VPS、云服务器和服务器托管的主机服务商。"))
      .toBe("LOCVPS 是面向 VPS、云服务器和服务器托管的主机服务商。");
    expect(normalizeAIRecognitionUsefulNotes("LOCVPS 提供 VPS、云服务器和服务器托管相关服务，适合记录主机或服务器套餐订阅。"))
      .toBe("LOCVPS 提供 VPS、云服务器和服务器托管服务");
    expect(normalizeAIRecognitionUsefulNotes("AI 根据服务名称建议官网。")).toBeNull();
    expect(normalizeAIRecognitionUsefulNotes("输入没有提供官网或更多上下文，AI 未能高置信识别该服务。")).toBeNull();
    expect(normalizeAIRecognitionUsefulNotes("Cannot determine the renewal date from the input; please confirm.")).toBeNull();
    expect(normalizeAIRecognitionUsefulNotes("领先的全方位云服务平台。")).toBeNull();
  });

  it("builds a prompt that keeps uncertainty out of notes", () => {
    const prompt = buildAIRecognitionUserPrompt({
      text: "sample service 15元 1个月",
      timezone: "Asia/Shanghai",
      defaultCurrency: "CNY",
      currentDate: "2026-06-06",
      imageCount: 0,
      locale: "zh-CN",
      configContext: {
        categories: [{
          value: "hosting_domains",
          label: "域名与托管",
          zhCN: "域名与托管",
          enUS: "Domains & Hosting",
        }],
        paymentMethods: [],
        tags: ["VPS", "云服务器"],
      },
    });

    expect(prompt).toContain("notes must always be an object");
    expect(prompt).toContain("notes.value must be non-null for describable services");
    expect(prompt).toContain("dynamic evidence from this request");
    expect(prompt).toContain("Generated user-facing metadata must follow User locale");
    expect(prompt).toContain("use English for en-US and Simplified Chinese for zh-CN");
    expect(prompt).toContain("Do not translate source=input text, Existing user tags");
    expect(prompt).toContain("Runtime context:");
    expect(prompt).toContain("User context:");
    expect(prompt).toContain("Task:");
    expect(prompt).toContain("Examples:");
    expect(prompt).toContain("<<<renewlet-user-input");
    expect(prompt).not.toContain("适合记录");
    expect(prompt).not.toContain("可用于记录");
    expect(prompt).not.toContain("订阅管理");
    expect(prompt).toContain("Use notes={\"value\": null, \"source\": \"none\"} only when the service purpose is truly unknowable");
    expect(prompt).toContain("\"source\": \"none\"");
    expect(prompt).toContain("AI_WARNING_DATE_UNCERTAIN");
    expect(prompt).toContain("Existing user tags:");
    expect(prompt).toContain("- VPS");
    expect(prompt).toContain("Prefer Existing user tags when they fit.");
    expect(prompt).toContain("stable and reusable across multiple subscriptions");
    expect(prompt).toContain("Do not use one-off order attributes as tags");
    expect(prompt).not.toContain("https://www.apple.com/");
    expect(prompt).not.toContain("YouTube 是 Google 旗下的视频分享和流媒体平台。");
    expect(prompt).not.toContain("LOCVPS 是面向 VPS、云服务器和服务器托管的主机服务商。");
    expect(prompt).not.toContain("DMIT 是提供 VPS、云服务器和网络线路服务的主机商。");
  });
});
