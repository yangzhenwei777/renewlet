import { describe, expect, it } from "vitest";
import {
  UPSTREAM_RAW_RESPONSE_TEXT_MAX_CHARS,
  upstreamErrorDetailsSchema,
} from "./upstream";

describe("upstream error schemas", () => {
  it("accepts raw response text only", () => {
    // 上游错误详情只暴露脱敏 rawResponseText，避免恢复 providerResponse 这类可持久化结构。
    const parsed = upstreamErrorDetailsSchema.parse({
      rawResponseText: "rate limited",
    });

    expect(parsed.rawResponseText).toBe("rate limited");
  });

  it("caps raw response text at the shared schema boundary", () => {
    // Go、Worker 和前端共用长度上限，防止第三方 HTML/JSON 错误体无限进入 API 响应。
    expect(upstreamErrorDetailsSchema.safeParse({
      rawResponseText: "x".repeat(UPSTREAM_RAW_RESPONSE_TEXT_MAX_CHARS),
    }).success).toBe(true);

    expect(upstreamErrorDetailsSchema.safeParse({
      rawResponseText: "x".repeat(UPSTREAM_RAW_RESPONSE_TEXT_MAX_CHARS + 1),
    }).success).toBe(false);
  });

  it("rejects the old structured upstream response shape", () => {
    // 彻底切换到 rawResponseText，旧结构即使字段完整也必须被拒绝。
    expect(upstreamErrorDetailsSchema.safeParse({
      rawResponseText: "rate limited",
      providerResponse: {
        status: 429,
        body: "rate limited",
      },
    }).success).toBe(false);
  });
});
