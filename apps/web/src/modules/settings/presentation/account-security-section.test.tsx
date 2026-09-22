import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSettingsSectionProps } from "./account-settings-section";
import { AccountSettingsSection } from "./account-settings-section";

const mocks = vi.hoisted(() => ({
  mfaService: {
    status: vi.fn(),
    startTotpSetup: vi.fn(),
    enableTotp: vi.fn(),
    regenerateRecoveryCodes: vi.fn(),
    disable: vi.fn(),
  },
  passkeyService: {
    list: vi.fn(),
    register: vi.fn(),
    delete: vi.fn(),
  },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/services/mfa-service", () => ({
  mfaService: mocks.mfaService,
}));

vi.mock("@/services/passkey-service", () => ({
  passkeyService: mocks.passkeyService,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: mocks.toast,
}));

const translations: Record<string, string> = {
  "auth.forgotPassword": "忘记密码？",
  "auth.mfaCodePlaceholder": "000000",
  "auth.password": "密码",
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.disabled": "未启用",
  "common.enabled": "已启用",
  "common.loading": "加载中",
  "common.saving": "保存中",
  "settings.managerLoadFailed": "加载失败",
  "settings.managerRefreshFailed": "未更新",
  "settings.managerRetry": "重试",
  "settings.notUpdated": "未更新",
  "settings.statusUnknown": "状态未知",
  "passwordReset.confirmPassword": "确认新密码",
  "passwordReset.newPassword": "新密码",
  "settings.account": "账号",
  "settings.accountSecurityDemoDisabled": "演示模式仅供浏览，不能修改身份验证器或通行密钥。",
  "settings.addPasskey": "添加通行密钥",
  "settings.addPasskeyDescription": "输入当前密码后，浏览器会引导你使用设备或安全密钥创建通行密钥。",
  "settings.changePassword": "修改密码",
  "settings.confirmPasswordPlaceholder": "再输入一次",
  "settings.currentPassword": "当前密码",
  "settings.currentPasswordPlaceholder": "输入当前密码",
  "settings.deletePasskey": "删除通行密钥",
  "settings.deletePasskeyDescription": "删除 {name} 后，它不能再用于登录。",
  "settings.deletePasskeyNamed": "删除通行密钥 {name}",
  "settings.deletePasskeyTitle": "删除通行密钥？",
  "settings.emailLoading": "加载中",
  "settings.emailMissing": "未设置邮箱",
  "settings.manageUsers": "管理用户",
  "settings.mfaAddAuthenticator": "更换身份验证器",
  "settings.mfaDisable": "关闭身份验证器",
  "settings.mfaDisableDescription": "关闭后不再要求身份验证器验证码；通行密钥不会被删除。",
  "settings.mfaDisableTitle": "关闭身份验证器？",
  "settings.mfaHelp": "使用身份验证器应用生成 6 位验证码；恢复码只会展示一次。",
  "settings.mfaMethodRecovery": "恢复码",
  "settings.mfaMethodTotp": "身份验证器",
  "settings.mfaNoMethods": "尚未设置身份验证器。",
  "settings.mfaRecoveryRemaining": "剩余恢复码：{count} 个",
  "settings.mfaRegenerateRecovery": "重新生成恢复码",
  "settings.mfaRegenerateDescription": "旧的未使用恢复码会立即失效。",
  "settings.mfaRegenerateTitle": "重新生成恢复码？",
  "settings.mfaSetupFailed": "无法开始设置身份验证器",
  "settings.mfaSetupFailedDescription": "账号安全初始化失败，请稍后重试。",
  "settings.mfaSetupTitle": "设置身份验证器",
  "settings.mfaSetupDescription": "扫描二维码或手动输入密钥，然后填写身份验证器中的 6 位验证码。",
  "settings.mfaManualSecret": "手动密钥",
  "settings.mfaSetupCode": "身份验证器验证码",
  "settings.mfaConfirmEnable": "启用并生成恢复码",
  "settings.mfaEnabled": "身份验证器已启用",
  "settings.mfaTitle": "身份验证器",
  "settings.newPasswordPlaceholder": "至少 8 位",
  "settings.noPasskeys": "尚未添加通行密钥。",
  "settings.passkeyCount": "{count} 个",
  "settings.passkeyCountStale": "{count} 个 · 未更新",
  "settings.passkeyCreatedAt": "添加于 {time}",
  "settings.passkeyHelp": "使用浏览器、设备生物识别或安全密钥直接登录；通行密钥和身份验证器分开管理。",
  "settings.passkeyName": "通行密钥名称",
  "settings.passkeyNamePlaceholder": "例如：MacBook Touch ID",
  "settings.passkeys": "通行密钥",
  "settings.passkeysSummary": "通行密钥 · {summary}",
  "settings.passkeysManage": "管理通行密钥",
  "settings.passkeysManageDescription": "添加、查看和删除可用于登录的通行密钥。",
  "settings.passkeysManageTitle": "管理通行密钥",
  "settings.passwordDialogDescription": "更新账号密码。",
  "settings.passwordDialogTitle": "修改密码",
  "settings.passwordHelp": "定期更新密码可降低账号风险。",
  "settings.pocketBaseAdmin": "PocketBase 后台",
  "settings.saveNewPassword": "保存新密码",
  "settings.username": "用户名",
  "settings.usernameHelp": "用于登录的邮箱地址。",
};

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const template = translations[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`));
    },
    formatDateTime: (value: string) => `formatted:${value}`,
  }),
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderAccountSettings(overrides: Partial<AccountSettingsSectionProps> = {}) {
  const queryClient = createQueryClient();
  const props: AccountSettingsSectionProps = {
    accountEmail: "alice@example.com",
    canManageUsers: true,
    canAccessPocketBaseAdmin: true,
    passwordResetEnabled: true,
    passwordDialogOpen: false,
    setPasswordDialogOpen: vi.fn(),
    handlePasswordDialogOpenChange: vi.fn(),
    currentPassword: "",
    setCurrentPassword: vi.fn(),
    newPassword: "",
    setNewPassword: vi.fn(),
    confirmPassword: "",
    setConfirmPassword: vi.fn(),
    isUpdatingPassword: false,
    updatePassword: vi.fn(),
    ...overrides,
  };

  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AccountSettingsSection {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  return { queryClient, props };
}

async function waitForAccountSecurityReady() {
  expect(await screen.findByText("剩余恢复码：10 个")).toBeInTheDocument();
  expect(await screen.findByText("通行密钥 · 1 个")).toBeInTheDocument();
}

function getTopDialogOverlay() {
  const overlays = document.querySelectorAll<HTMLElement>("[data-dialog-overlay]");
  const overlay = overlays.item(overlays.length - 1);
  if (!overlay) throw new Error("Dialog overlay was not rendered");
  return overlay;
}

describe("AccountSettingsSection account security dialogs", () => {
  beforeEach(() => {
    mocks.mfaService.status.mockReset().mockResolvedValue({
      enabled: true,
      methods: ["totp", "recovery_code"],
      recoveryCodesRemaining: 10,
      passkeyCount: 1,
    });
    mocks.mfaService.startTotpSetup.mockReset().mockResolvedValue({
      setupId: "setup-1",
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUrl: "otpauth://totp/Renewlet:alice@example.com?secret=JBSWY3DPEHPK3PXP",
      expiresAt: "2026-06-22T00:05:00.000Z",
    });
    mocks.mfaService.enableTotp.mockReset().mockResolvedValue(["ABCD-EFGH-IJKL"]);
    mocks.mfaService.regenerateRecoveryCodes.mockReset().mockResolvedValue(["MNOP-QRST-UVWX"]);
    mocks.mfaService.disable.mockReset().mockResolvedValue(undefined);
    mocks.passkeyService.list.mockReset().mockResolvedValue([
      { id: "pkey-1", name: "MacBook Touch ID", createdAt: "2026-06-22T00:00:00.000Z" },
    ]);
    mocks.passkeyService.register.mockReset().mockResolvedValue(undefined);
    mocks.passkeyService.delete.mockReset().mockResolvedValue(undefined);
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
  });

  it("does not report MFA as disabled when the first status read fails", async () => {
    const user = userEvent.setup();
    mocks.mfaService.status.mockRejectedValue(new Error("MFA unavailable"));

    renderAccountSettings();

    const title = screen.getByRole("heading", { name: "身份验证器" });
    const section = title.closest("div.rounded-md") as HTMLElement;
    expect(await within(section).findByText("加载失败")).toBeInTheDocument();
    expect(within(section).getByText("状态未知")).toBeInTheDocument();
    expect(within(section).queryByText("未启用")).not.toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.mfaService.status).toHaveBeenCalledTimes(2));
  });

  it("does not report zero passkeys when the first list read fails", async () => {
    const user = userEvent.setup();
    mocks.passkeyService.list.mockRejectedValue(new Error("Passkeys unavailable"));

    renderAccountSettings();

    expect(await screen.findByRole("heading", { name: "通行密钥 · 状态未知" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "通行密钥 · 0 个" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理通行密钥" }));

    const dialog = screen.getByRole("dialog", { name: "管理通行密钥" });
    expect(within(dialog).getByText("加载失败")).toBeInTheDocument();
    expect(within(dialog).queryByText("尚未添加通行密钥。")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.passkeyService.list).toHaveBeenCalledTimes(2));
  });

  it("keeps the passkey list out of the settings page and opens the manager dialog", async () => {
    const user = userEvent.setup();
    renderAccountSettings();
    await waitForAccountSecurityReady();

    expect(screen.queryByText("MacBook Touch ID")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "管理通行密钥" }));

    const dialog = screen.getByRole("dialog", { name: "管理通行密钥" });
    expect(within(dialog).getByText("MacBook Touch ID")).toBeInTheDocument();
    expect(within(dialog).getByText("添加于 formatted:2026-06-22T00:00:00.000Z")).toBeInTheDocument();
    expect(within(dialog).queryByText(/可和身份验证器同时启用/)).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("passkeys-manager-scroll")).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "管理通行密钥" })).toBeInTheDocument();
    await user.click(getTopDialogOverlay());
    expect(screen.getByRole("dialog", { name: "管理通行密钥" })).toBeInTheDocument();
    await user.click(within(dialog).getAllByRole("button", { name: "关闭" })[0]!);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "管理通行密钥" })).not.toBeInTheDocument();
    });
  });

  it("requires explicit close controls while setting up an authenticator", async () => {
    const user = userEvent.setup();
    renderAccountSettings();
    await waitForAccountSecurityReady();

    await user.click(screen.getByRole("button", { name: "更换身份验证器" }));

    const dialog = await screen.findByRole("dialog", { name: "设置身份验证器" });
    const cancelButton = await within(dialog).findByRole("button", { name: "取消" });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "设置身份验证器" })).toBeInTheDocument();
    await user.click(getTopDialogOverlay());
    expect(screen.getByRole("dialog", { name: "设置身份验证器" })).toBeInTheDocument();

    await user.click(cancelButton);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "设置身份验证器" })).not.toBeInTheDocument();
    });
  });

  it("submits passkey add from the manager without calling MFA services", async () => {
    const user = userEvent.setup();
    renderAccountSettings();
    await waitForAccountSecurityReady();

    await user.click(screen.getByRole("button", { name: "管理通行密钥" }));

    const dialog = screen.getByRole("dialog", { name: "管理通行密钥" });
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "关闭身份验证器？" })).not.toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("通行密钥名称"), "iPhone Face ID");
    await user.type(within(dialog).getByLabelText("当前密码"), "Aa111111");
    await user.click(within(dialog).getByRole("button", { name: "添加通行密钥" }));

    await waitFor(() => {
      expect(mocks.passkeyService.register).toHaveBeenCalledWith({
        name: "iPhone Face ID",
        currentPassword: "Aa111111",
      });
    });
    expect(mocks.mfaService.disable).not.toHaveBeenCalled();
    expect(mocks.mfaService.regenerateRecoveryCodes).not.toHaveBeenCalled();
  });

  it("keeps MFA password actions blocked while the passkey manager is open", async () => {
    const user = userEvent.setup();
    renderAccountSettings();
    await waitForAccountSecurityReady();

    const disableAuthenticatorButton = screen.getByRole("button", { name: "关闭身份验证器" });
    await user.click(screen.getByRole("button", { name: "管理通行密钥" }));

    expect(screen.getByRole("dialog", { name: "管理通行密钥" })).toBeInTheDocument();
    fireEvent.click(disableAuthenticatorButton);

    expect(screen.queryByRole("dialog", { name: "关闭身份验证器？" })).not.toBeInTheDocument();
    expect(mocks.mfaService.disable).not.toHaveBeenCalled();
  });

  it("uses password-manager friendly form metadata for passkey registration", async () => {
    const user = userEvent.setup();
    renderAccountSettings();
    await waitForAccountSecurityReady();

    await user.click(screen.getByRole("button", { name: "管理通行密钥" }));
    const dialog = screen.getByRole("dialog", { name: "管理通行密钥" });
    const addForm = within(dialog).getByRole("form", { name: "添加通行密钥" });
    const usernameInput = addForm.querySelector<HTMLInputElement>('input[name="username"]');
    const nameInput = within(addForm).getByLabelText("通行密钥名称");
    const passwordInput = within(addForm).getByLabelText("当前密码");
    const accountCredentialsRow = document.getElementById("username")?.closest('[data-slot="form-field-row"]');

    expect(usernameInput).toHaveAttribute("autocomplete", "username");
    expect(usernameInput).toHaveValue("alice@example.com");
    expect(nameInput).toHaveAttribute("name", "passkey-name");
    expect(nameInput).toHaveAttribute("autocomplete", "off");
    expect(passwordInput).toHaveAttribute("name", "current-password");
    expect(passwordInput).toHaveAttribute("autocomplete", "current-password");
    expect(passwordInput).toHaveAttribute("aria-describedby", "passkey-password-description");
    expect(accountCredentialsRow).toHaveAttribute("data-align-at", "sm");
    expect(accountCredentialsRow).toHaveAttribute("data-tracks", "3");

    const fieldRow = nameInput.closest('[data-slot="form-field-row"]');
    const rowLayout = fieldRow?.firstElementChild;
    expect(fieldRow).toHaveAttribute("data-align-at", "md");
    expect(fieldRow).toHaveAttribute("data-tracks", "3");
    expect(rowLayout?.children[0]).toHaveAttribute("data-slot", "form-field");
    expect(rowLayout?.children[1]).toHaveAttribute("data-slot", "form-field");
    expect(rowLayout?.children[2]).toHaveAttribute("data-slot", "form-field-row-action");
    expect(rowLayout?.children[2]).toContainElement(within(addForm).getByRole("button", { name: "添加通行密钥" }));
  });

  it("does not open MFA dialogs when a password manager fills the passkey form", async () => {
    const user = userEvent.setup();
    renderAccountSettings();
    await waitForAccountSecurityReady();

    await user.click(screen.getByRole("button", { name: "管理通行密钥" }));
    const dialog = screen.getByRole("dialog", { name: "管理通行密钥" });
    fireEvent.change(within(dialog).getByLabelText("通行密钥名称"), { target: { value: "1password" } });
    fireEvent.change(within(dialog).getByLabelText("当前密码"), { target: { value: "Aa111111" } });

    expect(screen.queryByRole("dialog", { name: "关闭身份验证器？" })).not.toBeInTheDocument();
    expect(mocks.mfaService.disable).not.toHaveBeenCalled();
    expect(mocks.mfaService.regenerateRecoveryCodes).not.toHaveBeenCalled();
  });

  it("submits only passkey registration when pressing Enter in the manager password field", async () => {
    const user = userEvent.setup();
    renderAccountSettings();
    await waitForAccountSecurityReady();

    await user.click(screen.getByRole("button", { name: "管理通行密钥" }));
    const dialog = screen.getByRole("dialog", { name: "管理通行密钥" });
    await user.type(within(dialog).getByLabelText("通行密钥名称"), "iPhone Face ID");
    await user.type(within(dialog).getByLabelText("当前密码"), "Aa111111{Enter}");

    await waitFor(() => {
      expect(mocks.passkeyService.register).toHaveBeenCalledWith({
        name: "iPhone Face ID",
        currentPassword: "Aa111111",
      });
    });
    expect(screen.queryByRole("dialog", { name: "关闭身份验证器？" })).not.toBeInTheDocument();
    expect(mocks.mfaService.disable).not.toHaveBeenCalled();
    expect(mocks.mfaService.regenerateRecoveryCodes).not.toHaveBeenCalled();
  });

  it("does not keep the MFA disable dialog when opening passkey management afterward", async () => {
    const user = userEvent.setup();
    renderAccountSettings();
    await waitForAccountSecurityReady();

    await user.click(screen.getByRole("button", { name: "关闭身份验证器" }));
    const mfaDialog = screen.getByRole("dialog", { name: "关闭身份验证器？" });
    expect(mfaDialog).toBeInTheDocument();

    await user.click(within(mfaDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "关闭身份验证器？" })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "管理通行密钥" }));

    expect(screen.getByRole("dialog", { name: "管理通行密钥" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "关闭身份验证器？" })).not.toBeInTheDocument();
  });

  it("opens only the passkey delete confirmation with a named delete button", async () => {
    const user = userEvent.setup();
    renderAccountSettings();
    await waitForAccountSecurityReady();

    await user.click(screen.getByRole("button", { name: "管理通行密钥" }));
    const manager = screen.getByRole("dialog", { name: "管理通行密钥" });
    await user.click(within(manager).getByRole("button", { name: "删除通行密钥 MacBook Touch ID" }));

    expect(screen.getByRole("alertdialog", { name: "删除通行密钥？" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "关闭身份验证器？" })).not.toBeInTheDocument();
  });

  it("keeps the passkey manager open after deleting a passkey", async () => {
    const user = userEvent.setup();
    renderAccountSettings();
    await waitForAccountSecurityReady();

    await user.click(screen.getByRole("button", { name: "管理通行密钥" }));
    const manager = screen.getByRole("dialog", { name: "管理通行密钥" });
    await user.click(within(manager).getByRole("button", { name: "删除通行密钥 MacBook Touch ID" }));

    const alertDialog = screen.getByRole("alertdialog", { name: "删除通行密钥？" });
    await user.type(within(alertDialog).getByLabelText("当前密码"), "Aa111111");
    await user.click(within(alertDialog).getByRole("button", { name: "删除通行密钥" }));

    await waitFor(() => {
      expect(mocks.passkeyService.delete).toHaveBeenCalledWith("pkey-1", { currentPassword: "Aa111111" });
    });
    expect(screen.getByRole("dialog", { name: "管理通行密钥" })).toBeInTheDocument();
  });

  it("keeps long passkey lists inside the manager dialog", async () => {
    mocks.passkeyService.list.mockResolvedValue([
      { id: "pkey-1", name: "MacBook Touch ID", createdAt: "2026-06-22T00:00:00.000Z" },
      { id: "pkey-2", name: "iPhone Face ID", createdAt: "2026-06-21T00:00:00.000Z" },
      { id: "pkey-3", name: "Very long passkey name that should not stretch the account settings layout", createdAt: "2026-06-20T00:00:00.000Z" },
    ]);
    const user = userEvent.setup();
    renderAccountSettings();
    expect(await screen.findByText("通行密钥 · 3 个")).toBeInTheDocument();

    expect(screen.queryByText("iPhone Face ID")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理通行密钥" }));

    const dialog = screen.getByRole("dialog", { name: "管理通行密钥" });
    expect(within(dialog).getByText("iPhone Face ID")).toBeInTheDocument();
    expect(within(dialog).getByTestId("passkeys-manager-scroll")).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    expect(within(dialog).getByText("Very long passkey name that should not stretch the account settings layout")).toHaveClass("truncate");
  });

  it("shows authenticator and passkey sections as coexisting enabled account security capabilities", async () => {
    renderAccountSettings();
    await waitForAccountSecurityReady();

    expect(screen.getByRole("heading", { name: "身份验证器" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通行密钥 · 1 个" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cloudflare Turnstile" })).not.toBeInTheDocument();
    expect(screen.getAllByText("身份验证器").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("恢复码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更换身份验证器" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "管理通行密钥" })).toBeEnabled();
  });

  it("keeps account security read-only in demo mode", async () => {
    const user = userEvent.setup();
    renderAccountSettings({ passwordDisabled: true, accountSecurityDemoDisabled: true });
    await waitForAccountSecurityReady();

    expect(screen.getByText("演示模式仅供浏览，不能修改身份验证器或通行密钥。")).toBeInTheDocument();
    const setupButton = screen.getByRole("button", { name: "更换身份验证器" });
    const regenerateButton = screen.getByRole("button", { name: "重新生成恢复码" });
    const disableButton = screen.getByRole("button", { name: "关闭身份验证器" });
    const managePasskeysButton = screen.getByRole("button", { name: "管理通行密钥" });
    expect(setupButton).toBeDisabled();
    expect(regenerateButton).toBeDisabled();
    expect(disableButton).toBeDisabled();
    expect(managePasskeysButton).toBeDisabled();

    await user.click(setupButton);
    await user.click(managePasskeysButton);

    expect(screen.queryByRole("dialog", { name: "管理通行密钥" })).not.toBeInTheDocument();
    expect(mocks.mfaService.startTotpSetup).not.toHaveBeenCalled();
    expect(mocks.passkeyService.register).not.toHaveBeenCalled();
    expect(mocks.passkeyService.delete).not.toHaveBeenCalled();
  });
});
