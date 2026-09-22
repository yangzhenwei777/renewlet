import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client";
import {
  createRawErrorResponseDetails,
  createRawErrorResponseDetailsFromText,
  formatRawErrorResponseText,
} from "@/lib/raw-error-response";

describe("formatRawErrorResponseText", () => {
  it("pretty prints JSON responses for display", () => {
    expect(formatRawErrorResponseText('{"code":"INVALID_PAYLOAD","details":{"field":"baseUrl"}}')).toBe([
      "{",
      '  "code": "INVALID_PAYLOAD",',
      '  "details": {',
      '    "field": "baseUrl"',
      "  }",
      "}",
    ].join("\n"));
  });

  it("keeps non-JSON responses unchanged", () => {
    expect(formatRawErrorResponseText("<html>rate limited</html>")).toBe("<html>rate limited</html>");
  });

  it("keeps code only as a fallback message and not as view data", () => {
    expect(createRawErrorResponseDetailsFromText({
      code: "HTTP 429",
      responseText: "",
    })).toEqual({
      message: "HTTP 429",
      responseText: "HTTP 429",
    });
  });

  it("prefers upstream rawResponseText from the API error details over the outer envelope", () => {
    const upstreamBody = JSON.stringify({
      message: "[AUTH]账号错误Key",
      code: 40001,
      info: "账号错误Key",
      args: [null],
      scode: 461,
    });
    const outerBody = JSON.stringify({
      error: {
        message: "云备份列表加载失败",
        code: "CLOUD_BACKUP_LIST_FAILED",
        details: {
          rawResponseText: upstreamBody,
        },
      },
    });
    const error = new ApiError(
      "云备份列表加载失败",
      400,
      {
        rawResponseText: upstreamBody,
      },
      "CLOUD_BACKUP_LIST_FAILED",
      outerBody,
    );

    const details = createRawErrorResponseDetails(error);

    expect(details.responseText).toBe(upstreamBody);
    expect(details.responseText).not.toBe(outerBody);
    const formatted = formatRawErrorResponseText(details.responseText);
    expect(formatted).toContain('"message": "[AUTH]账号错误Key"');
    expect(formatted).toContain('"code": 40001');
    expect(formatted).not.toContain("rawResponseText");
    expect(formatted).not.toContain("CLOUD_BACKUP_LIST_FAILED");
  });
});
