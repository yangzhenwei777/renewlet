import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  accountSecurityDialogCopyKeys,
  type AccountSecurityDialogState,
} from "./account-security-dialog-state";
import { DeferredAccountSecurityDialogs } from "./account-security-dialogs-loader";

const moduleGate = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});

vi.mock("./account-security-dialogs", async () => {
  await moduleGate.promise;
  const dialog = await vi.importActual<typeof import("@/components/ui/dialog")>("@/components/ui/dialog");
  return {
    AccountSecurityDialogContent: () => (
      <>
        <dialog.DialogHeader>
          <dialog.DialogTitle>关闭身份验证器？</dialog.DialogTitle>
          <dialog.DialogDescription>关闭说明</dialog.DialogDescription>
        </dialog.DialogHeader>
        <div data-testid="account-security-dialog-real-content">真实 MFA 内容</div>
      </>
    ),
  };
});

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.close": "关闭",
      "common.loading": "加载中",
      "settings.mfaDisableTitle": "关闭身份验证器？",
      "settings.mfaDisableDescription": "关闭说明",
    }[key] ?? key),
    formatDateTime: (value: string) => value,
  }),
}));

function Harness() {
  const [state, setState] = useState<AccountSecurityDialogState>({
    type: "mfa_password",
    action: "disable",
  });
  return (
    <>
      <button
        type="button"
        onClick={() => setState({ type: "mfa_password", action: "disable" })}
      >
        打开 MFA
      </button>
      <DeferredAccountSecurityDialogs
        state={state}
        onStateChange={setState}
        onPasskeysOpenChange={vi.fn()}
        accountEmail="alice@example.com"
        passkeys={{
          data: [],
          hasData: true,
          error: null,
          isInitialLoading: false,
          isRefreshing: false,
          retry: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        }}
      />
    </>
  );
}

describe("DeferredAccountSecurityDialogs", () => {
  it("keeps pending titles aligned with each authenticator state", () => {
    expect(accountSecurityDialogCopyKeys({
      type: "mfa_setup",
      setup: {
        setupId: "setup-1",
        secret: "secret",
        otpauthUrl: "otpauth://totp/Renewlet",
        expiresAt: "2026-08-20T00:00:00.000Z",
      },
    }).title).toBe("settings.mfaSetupTitle");
    expect(accountSecurityDialogCopyKeys({ type: "mfa_password", action: "disable" }).title)
      .toBe("settings.mfaDisableTitle");
    expect(accountSecurityDialogCopyKeys({ type: "mfa_password", action: "regenerate" }).title)
      .toBe("settings.mfaRegenerateTitle");
    expect(accountSecurityDialogCopyKeys({ type: "recovery_codes", codes: ["code"] }).title)
      .toBe("settings.mfaRecoveryCodesTitle");
  });

  it("does not let a late MFA module replace a closing dialog session", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByRole("dialog", { name: "关闭身份验证器？" })).toHaveAttribute("aria-busy", "true");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await act(async () => {
      moduleGate.release();
      await moduleGate.promise;
    });
    expect(screen.queryByTestId("account-security-dialog-real-content")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开 MFA" }));
    expect(await screen.findByTestId("account-security-dialog-real-content")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "关闭身份验证器？" })).not.toHaveAttribute("aria-busy");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});
