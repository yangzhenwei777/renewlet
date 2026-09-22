import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForgotPasswordClient } from "./forgot-password/forgot-password-client";
import { ResetPasswordClient } from "./reset-password/reset-password-client";

const mocks = vi.hoisted(() => ({
  confirmPasswordReset: vi.fn(),
  requestPasswordReset: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    confirmPasswordReset: mocks.confirmPasswordReset,
    requestPasswordReset: mocks.requestPasswordReset,
  },
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock("@/components/router-link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

vi.mock("@/components/brand/renewlet-brand-mark", () => ({
  RenewletBrandLockup: ({ title, subtitle }: { title: string; subtitle: string }) => (
    <header><h1>{title}</h1><p>{subtitle}</p></header>
  ),
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "auth.email": "邮箱",
      "auth.hidePassword": "隐藏密码",
      "auth.showPassword": "显示密码",
      "common.backHome": "返回首页",
      "common.backToLogin": "返回登录",
      "common.saving": "保存中",
      "passwordReset.confirmPassword": "确认密码",
      "passwordReset.confirmRequired": "请再次输入新密码",
      "passwordReset.emailHelp": "输入登录邮箱，我们会发送一次性重置链接。",
      "passwordReset.emailInvalid": "请输入有效邮箱",
      "passwordReset.emailRequired": "请输入邮箱",
      "passwordReset.forgotSubtitle": "通过邮箱接收重置链接",
      "passwordReset.forgotTitle": "找回密码",
      "passwordReset.newPassword": "新密码",
      "passwordReset.newSubtitle": "使用邮件链接完成密码重置",
      "passwordReset.newTitle": "设置新密码",
      "passwordReset.passwordHelp": "至少 8 位，建议包含字母、数字和符号。",
      "passwordReset.passwordLength": "新密码至少需要 8 位",
      "passwordReset.passwordMismatch": "两次输入的密码不一致",
      "passwordReset.passwordRequired": "请输入新密码",
      "passwordReset.resetFailed": "重置失败",
      "passwordReset.resetFailedDescription": "请重新申请重置链接。",
      "passwordReset.saveNew": "保存新密码",
      "passwordReset.sendFailed": "发送失败",
      "passwordReset.sendFailedDescription": "请稍后重试。",
      "passwordReset.sendLink": "发送重置链接",
      "passwordReset.sending": "发送中",
      "passwordReset.successHint": "链接 1 小时内有效。",
      "passwordReset.successMessage": "如果该邮箱存在，重置链接会发送到该邮箱。",
      "passwordReset.updatedLogin": "密码已更新，请使用新密码登录。",
    })[key] ?? key,
  }),
}));

beforeEach(() => {
  mocks.confirmPasswordReset.mockReset().mockResolvedValue(undefined);
  mocks.requestPasswordReset.mockReset().mockResolvedValue(undefined);
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

describe("password reset feedback", () => {
  it("uses the forgot-password inline success state without a success toast", async () => {
    const user = userEvent.setup();
    render(<ForgotPasswordClient enabled />);

    await user.type(screen.getByLabelText("邮箱"), "alice@example.com");
    await user.click(screen.getByRole("button", { name: "发送重置链接" }));

    expect(await screen.findByText("如果该邮箱存在，重置链接会发送到该邮箱。")).toBeInTheDocument();
    expect(mocks.requestPasswordReset).toHaveBeenCalledWith("alice@example.com");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("uses the reset-password inline success state without a success toast", async () => {
    const user = userEvent.setup();
    render(<ResetPasswordClient token="reset-token" />);

    await user.type(screen.getByLabelText("新密码"), "new-password");
    await user.type(screen.getByLabelText("确认密码"), "new-password");
    await user.click(screen.getByRole("button", { name: "保存新密码" }));

    expect(await screen.findByText("密码已更新，请使用新密码登录。")).toBeInTheDocument();
    expect(mocks.confirmPasswordReset).toHaveBeenCalledWith("reset-token", "new-password");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
