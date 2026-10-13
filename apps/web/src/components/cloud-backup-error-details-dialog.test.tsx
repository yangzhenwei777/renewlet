import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CloudBackupErrorDetailsDialog } from "./cloud-backup-error-details-dialog";
import type { CloudBackupErrorDetailsView } from "@/lib/cloud-backup-error-details";

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.close": "关闭",
      "settings.cloudBackupUpstreamTitle": "云存储错误详情",
      "settings.cloudBackupUpstreamDescription": "接口返回的阶段和脱敏诊断信息。",
      "settings.cloudBackupError.clientMessage": "本地处理错误",
      "settings.cloudBackupError.providerMessage": "服务端响应",
      "settings.cloudBackupError.providerCode": "服务端错误码",
      "rawErrorResponse.copy": "复制错误详情",
      "rawErrorResponse.copied": "已复制",
      "rawErrorResponse.copyFailed": "复制失败",
      "rawErrorResponse.responseUnavailable": "当前错误没有可回显的响应正文。",
    }[key] ?? key),
  }),
}));

function renderDialog(details: CloudBackupErrorDetailsView) {
  return render(<CloudBackupErrorDetailsDialog open details={details} onOpenChange={vi.fn()} />);
}

function stubClipboard() {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

describe("CloudBackupErrorDetailsDialog", () => {
  it("shows the local parsing failure alongside HTTP 200 provider XML", async () => {
    const writeText = stubClipboard();
    renderDialog({
      code: "CLOUD_BACKUP_S3_LIST_FAILED",
      message: "云端快照列表加载失败",
      responseText: "ReferenceError: DOMParser is not defined",
      structured: {
        provider: "s3",
        operation: "ListObjectsV2",
        target: "host=storage.example.com; bucket=backup-test; key=(bucket root)",
        httpStatus: 200,
        clientMessage: "ReferenceError: DOMParser is not defined",
        providerMessage: "<ListBucketResult/>",
      },
    });

    const text = screen.getByRole("dialog").querySelector("pre")?.textContent;
    expect(text).toContain("本地处理错误:\nReferenceError: DOMParser is not defined");
    expect(text).toContain("服务端响应:\n<ListBucketResult/>");
    expect(text).not.toContain("服务端错误码");
    await userEvent.click(screen.getByRole("button", { name: "复制错误详情" }));
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("shows raw response text without a duplicated code badge", async () => {
    const writeText = stubClipboard();
    const raw = "{\"message\":\"[AUTH]账号错误Key\",\"code\":40001,\"info\":\"账号错误Key\",\"args\":[null],\"scode\":461}";
    const pretty = [
      "{",
      '  "message": "[AUTH]账号错误Key",',
      '  "code": 40001,',
      '  "info": "账号错误Key",',
      '  "args": [',
      "    null",
      "  ],",
      '  "scode": 461',
      "}",
    ].join("\n");
    renderDialog({
      message: "云备份连接测试失败",
      responseText: raw,
      structured: null,
    });

    const dialog = screen.getByRole("dialog", { name: "云存储错误详情" });
    expect(screen.queryByText("code")).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent("[AUTH]账号错误Key");
    expect(dialog).not.toHaveTextContent("CLOUD_BACKUP_TEST_FAILED");
    expect(dialog).not.toHaveTextContent("rawResponseText");
    expect(dialog.querySelector("pre")?.textContent).toBe(pretty);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "复制错误详情" }));
    expect(writeText).toHaveBeenCalledWith(pretty);
  });
});
