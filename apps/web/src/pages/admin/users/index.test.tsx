// 管理员用户页测试保护前端防自锁 UX 和 admin API 调用形状；安全边界仍由后端 route 重复校验。
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { apiFetch, ApiError } from "@/lib/api-client";
import AdminUsersPage from "./index";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type AdminUserFixture = {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  mfaEnabled: boolean;
  mfaMethods: string[];
  passkeysEnabled: boolean;
  passkeyCount: number;
  createdAt: string;
};

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  useI18n: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock("@/components/header", () => ({
  Header: () => <header data-testid="header" />,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: mocks.useI18n,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: mocks.useSession,
  },
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiFetch: mocks.apiFetch,
  };
});

const messages: Record<string, string> = {
  "admin.actions": "操作",
  "admin.banned": "已禁用",
  "admin.createUser": "创建用户",
  "admin.currentUserProtected": "不能禁用、降级或删除当前登录账号",
  "admin.enabled": "启用",
  "admin.lastAdmin": "至少需要保留一个启用的管理员",
  "admin.loadFailed": "加载用户失败",
  "admin.loadFailedDescription": "加载用户失败，请稍后重试",
  "admin.mfa": "身份验证器",
  "admin.mfaDisabled": "未启用",
  "admin.mfaEnabled": "已启用",
  "admin.mfaMethodCount": "{count} 种方式",
  "admin.passkeys": "通行密钥",
  "admin.passkeysDisabled": "未添加",
  "admin.passkeysEnabled": "已添加",
  "admin.passkeyCount": "{count} 个",
  "admin.resetPassword": "重置密码",
  "admin.resetDescription": "为 {name}（{email}）设置新密码。",
  "admin.resetFallback": "选择用户后设置新密码。",
  "admin.resetSuccess": "密码已重置",
  "admin.resetMfa": "重置身份验证器",
  "admin.resetMfaTitle": "重置身份验证器？",
  "admin.resetMfaDescription": "将关闭 {name}（{email}）的身份验证器并废弃恢复码；通行密钥不会被删除。",
  "admin.resetMfaFallback": "将关闭该用户的身份验证器并废弃恢复码；通行密钥不会被删除。",
  "admin.confirmResetMfa": "确认重置身份验证器",
  "admin.resetMfaSuccess": "身份验证器已重置",
  "admin.resetMfaFailed": "重置身份验证器失败",
  "admin.resetMfaFailedDescription": "重置失败，请稍后重试",
  "admin.resetPasskeys": "重置通行密钥",
  "admin.resetPasskeysTitle": "重置通行密钥？",
  "admin.resetPasskeysDescription": "将删除 {name}（{email}）的所有通行密钥，并让该用户的现有会话失效。",
  "admin.resetPasskeysFallback": "将删除该用户的所有通行密钥，并让现有会话失效。",
  "admin.confirmResetPasskeys": "确认重置通行密钥",
  "admin.resetPasskeysSuccess": "通行密钥已重置",
  "admin.resetPasskeysFailed": "重置通行密钥失败",
  "admin.resetPasskeysFailedDescription": "重置失败，请稍后重试",
  "admin.role": "角色",
  "admin.roleAdmin": "管理员",
  "admin.roleUser": "用户",
  "admin.status": "状态",
  "admin.subtitle": "管理可访问本系统的用户账号",
  "admin.title": "用户管理",
  "admin.user": "用户",
  "common.delete": "删除",
  "common.loading": "Loading...",
  "common.cancel": "取消",
  "common.saving": "保存中",
  "passwordReset.confirmPassword": "确认密码",
  "passwordReset.confirmRequired": "请确认密码",
  "passwordReset.newPassword": "新密码",
  "passwordReset.passwordLength": "密码至少需要 8 位",
  "passwordReset.passwordMismatch": "两次输入的密码不一致",
  "passwordReset.saveNew": "保存新密码",
  "settings.changePassword": "修改密码",
  "settings.confirmPasswordPlaceholder": "再输入一次",
  "settings.currentPassword": "当前密码",
  "settings.currentPasswordPlaceholder": "输入当前密码",
  "settings.newPasswordPlaceholder": "至少 8 位",
  "settings.passwordDialogDescription": "密码将写入本地认证账户。修改成功后不会在页面回显，请妥善保存。",
  "settings.passwordDialogTitle": "修改密码",
  "settings.saveNewPassword": "保存新密码",
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function makeT(prefix = "") {
  return (key: string, params?: Record<string, string | number>) => {
    let value: string = messages[key] ?? key;
    for (const [paramKey, paramValue] of Object.entries(params ?? {})) {
      value = value.split(`{${paramKey}}`).join(String(paramValue));
    }
    return prefix ? `${prefix}${value}` : value;
  };
}

function user(overrides: Partial<AdminUserFixture> = {}): AdminUserFixture {
  return {
    id: "user-1",
    name: "张三",
    email: "zhangsan@example.com",
    role: "user",
    banned: false,
    mfaEnabled: false,
    mfaMethods: [],
    passkeysEnabled: false,
    passkeyCount: 0,
    createdAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function AdminUsersTestTree() {
  return (
    <MemoryRouter initialEntries={["/admin/users"]}>
      <Routes>
        <Route
          path="/admin/users"
          element={(
            <TooltipProvider delayDuration={0}>
              <AdminUsersPage />
            </TooltipProvider>
          )}
        />
        <Route path="/settings" element={<div data-testid="settings-page" />} />
      </Routes>
      <RouteProbe />
    </MemoryRouter>
  );
}

function renderAdminUsersPage() {
  return render(<AdminUsersTestTree />);
}

function RouteProbe() {
  const location = useLocation();
  return <div data-testid="route-path">{location.pathname}</div>;
}

describe("AdminUsersPage", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.useI18n.mockReturnValue({ t: makeT() });
    mocks.useSession.mockReturnValue({
      data: {
        session: { expiresAt: "2026-07-01T00:00:00.000Z" },
        user: {
          id: "current-admin",
          email: "admin@example.com",
          name: "管理员",
          role: "admin",
          banned: false,
        },
      },
      isPending: false,
    });
  });

  it("shows loading only until the initial users request resolves", async () => {
    const usersRequest = createDeferred<{ users: AdminUserFixture[] }>();
    mocks.apiFetch.mockReturnValueOnce(usersRequest.promise);

    renderAdminUsersPage();

    expect(screen.getByTestId("admin-users-skeleton-table")).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();

    usersRequest.resolve({ users: [user({ name: "李四", email: "lisi@example.com" })] });

    expect(await screen.findByText("李四")).toBeInTheDocument();
    expect(screen.getByText("lisi@example.com")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-users-skeleton-table")).not.toBeInTheDocument();
  });

  it("does not reload users when the translation function reference changes", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      users: [user({ name: "王五", email: "wangwu@example.com" })],
    });
    const { rerender } = renderAdminUsersPage();

    expect(await screen.findByText("王五")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    mocks.useI18n.mockReturnValue({ t: makeT("[new] ") });
    rerender(<AdminUsersTestTree />);

    expect(screen.getByText("王五")).toBeInTheDocument();
    expect(screen.queryByText("[new] Loading...")).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("redirects without a load failure toast when the admin API rejects the current session", async () => {
    mocks.apiFetch.mockRejectedValue(new ApiError("需要管理员权限", 403, { message: "需要管理员权限" }));

    renderAdminUsersPage();

    await waitFor(() => expect(screen.getByTestId("route-path")).toHaveTextContent("/settings"));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("keeps the existing list visible while a refresh request is pending", async () => {
    const userFixture = user({ id: "editable-user", name: "赵六", email: "zhaoliu@example.com" });
    const refreshRequest = createDeferred<{ users: AdminUserFixture[] }>();
    let getRequests = 0;

    mocks.apiFetch.mockImplementation((input: string, _responseSchema: unknown, init?: RequestInit) => {
      if (input === "/api/app/admin/users") {
        getRequests += 1;
        if (getRequests === 1) return Promise.resolve({ users: [userFixture] });
        return refreshRequest.promise;
      }
      if (input === "/api/app/admin/users/editable-user" && init?.method === "PATCH") {
        return Promise.resolve({});
      }
      return Promise.reject(new Error(`Unexpected request: ${input}`));
    });

    const interaction = userEvent.setup();
    renderAdminUsersPage();

    expect(await screen.findByText("赵六")).toBeInTheDocument();

    await interaction.click(screen.getByRole("switch"));

    await waitFor(() => expect(getRequests).toBe(2));
    expect(screen.getByText("赵六")).toBeInTheDocument();
    expect(screen.getByText("zhaoliu@example.com")).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();

    refreshRequest.resolve({ users: [{ ...userFixture, banned: true }] });

    await waitFor(() => expect(screen.getByText("已禁用")).toBeInTheDocument());
  });

  it("uses the account password flow when the current admin changes their own password", async () => {
    const currentAdmin = user({
      id: "current-admin",
      name: "管理员",
      email: "admin@example.com",
      role: "admin",
    });
    mocks.apiFetch.mockImplementation((input: string, _responseSchema: unknown, init?: RequestInit) => {
      if (input === "/api/app/admin/users") return Promise.resolve({ users: [currentAdmin] });
      if (input === "/api/app/account/password" && init?.method === "PUT") return Promise.resolve({});
      return Promise.reject(new Error(`Unexpected request: ${input}`));
    });

    const interaction = userEvent.setup();
    renderAdminUsersPage();

    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    await interaction.click(screen.getByRole("button", { name: "修改密码" }));

    expect(screen.getByRole("dialog", { name: "修改密码" })).toBeInTheDocument();
    await interaction.type(screen.getByLabelText("当前密码"), "password123");
    await interaction.type(screen.getByLabelText("新密码"), "newpassword123");
    await interaction.type(screen.getByLabelText("确认密码"), "newpassword123");
    await interaction.click(screen.getByRole("button", { name: "保存新密码" }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/api/app/account/password",
        expect.anything(),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ currentPassword: "password123", newPassword: "newpassword123" }),
        }),
      ),
    );
    expect(apiFetch).not.toHaveBeenCalledWith(
      "/api/app/admin/users/current-admin",
      expect.anything(),
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("keeps admin password reset for other users", async () => {
    const otherUser = user({ id: "editable-user", name: "赵六", email: "zhaoliu@example.com" });
    let getRequests = 0;
    mocks.apiFetch.mockImplementation((input: string, _responseSchema: unknown, init?: RequestInit) => {
      if (input === "/api/app/admin/users") {
        getRequests += 1;
        return Promise.resolve({ users: [otherUser] });
      }
      if (input === "/api/app/admin/users/editable-user" && init?.method === "PATCH") {
        return Promise.resolve({});
      }
      return Promise.reject(new Error(`Unexpected request: ${input}`));
    });

    const interaction = userEvent.setup();
    renderAdminUsersPage();

    expect(await screen.findByText("赵六")).toBeInTheDocument();
    await interaction.click(screen.getByRole("button", { name: "重置密码" }));
    await interaction.type(screen.getByLabelText("新密码"), "resetpassword123");
    await interaction.type(screen.getByLabelText("确认密码"), "resetpassword123");
    await interaction.click(screen.getByRole("button", { name: "保存新密码" }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/api/app/admin/users/editable-user",
        expect.anything(),
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ newPassword: "resetpassword123" }),
        }),
      ),
    );
    expect(getRequests).toBeGreaterThanOrEqual(2);
  });

  it("resets passkeys through the dedicated admin endpoint", async () => {
    const passkeyUser = user({
      id: "passkey-user",
      name: "通行密钥用户",
      email: "passkey-user@example.com",
      passkeysEnabled: true,
      passkeyCount: 2,
    });
    let getRequests = 0;
    mocks.apiFetch.mockImplementation((input: string, _responseSchema: unknown, init?: RequestInit) => {
      if (input === "/api/app/admin/users") {
        getRequests += 1;
        return Promise.resolve({ users: [passkeyUser] });
      }
      if (input === "/api/app/admin/users/passkey-user/passkeys/reset" && init?.method === "POST") {
        return Promise.resolve({});
      }
      return Promise.reject(new Error(`Unexpected request: ${input}`));
    });

    const interaction = userEvent.setup();
    renderAdminUsersPage();

    expect(await screen.findByText("通行密钥用户")).toBeInTheDocument();
    await interaction.click(screen.getByRole("button", { name: "重置通行密钥" }));
    await interaction.click(screen.getByRole("button", { name: "确认重置通行密钥" }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/api/app/admin/users/passkey-user/passkeys/reset",
        expect.anything(),
        expect.objectContaining({
          method: "POST",
          body: "{}",
        }),
      ),
    );
    expect(apiFetch).not.toHaveBeenCalledWith(
      "/api/app/admin/users/passkey-user/mfa/reset",
      expect.anything(),
      expect.anything(),
    );
    expect(getRequests).toBeGreaterThanOrEqual(2);
  });
});
