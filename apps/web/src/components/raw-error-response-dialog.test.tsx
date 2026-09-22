import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RawErrorResponseDialog } from "./raw-error-response-dialog";

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.close": "关闭",
      "rawErrorResponse.copy": "复制",
      "rawErrorResponse.copied": "已复制",
      "rawErrorResponse.copyFailed": "复制失败",
      "rawErrorResponse.description": "接口返回的原始响应。",
      "rawErrorResponse.responseUnavailable": "没有可用响应",
      "rawErrorResponse.title": "错误响应详情",
    })[key] ?? key,
  }),
}));

describe("RawErrorResponseDialog", () => {
  it("does not repeat the raw response when the normalized summary is identical", () => {
    render(
      <RawErrorResponseDialog
        open
        details={{ message: "upstream unavailable", responseText: "upstream   unavailable" }}
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "错误响应详情" })).toBeInTheDocument();
    expect(screen.getAllByText(/upstream\s+unavailable/)).toHaveLength(1);
    expect(screen.getByText("接口返回的原始响应。")).toHaveClass("sr-only");
  });

  it("keeps a distinct normalized summary above the raw response", () => {
    render(
      <RawErrorResponseDialog
        open
        details={{ message: "请求失败", responseText: "upstream unavailable" }}
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText("请求失败")).not.toHaveClass("sr-only");
    expect(screen.getByText("upstream unavailable")).toBeInTheDocument();
  });
});
