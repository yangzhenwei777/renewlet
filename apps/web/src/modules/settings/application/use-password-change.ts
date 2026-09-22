/**
 * 修改密码 application hook。
 *
 * 架构位置：
 * - 密码不是 AppSettings，不能混入 settings 保存流程。
 * - 该 hook 独立调用账号 API，并只向 UI 暴露弹窗状态和提交动作。
 *
 * 边界防御：
 * - 客户端先做最小校验，减少无效请求；服务端仍是最终安全边界。
 * - 成功后清空输入，避免密码残留在 React state 中超过必要生命周期。
 */
import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { okResponseSchema } from "@/lib/api/schemas/common";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { reportClientError } from "@/lib/report-client-error";
import { toast } from "@/components/ui/sonner";
import { useDeferredDialogCleanup } from "@/hooks/use-deferred-dialog-cleanup";
import { useI18n } from "@/i18n/I18nProvider";

export interface PasswordChangeController {
  passwordDialogOpen: boolean;
  setPasswordDialogOpen: (open: boolean) => void;
  handlePasswordDialogOpenChange: (open: boolean) => void;
  currentPassword: string;
  setCurrentPassword: (value: string) => void;
  newPassword: string;
  setNewPassword: (value: string) => void;
  confirmPassword: string;
  setConfirmPassword: (value: string) => void;
  isUpdatingPassword: boolean;
  updatePassword: () => Promise<void>;
}

/** 管理“修改密码”弹窗状态和提交流程。 */
export function usePasswordChange(): PasswordChangeController {
  const { t } = useI18n();
  const [passwordDialogOpen, setPasswordDialogOpenState] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);

  const resetPasswordForm = useCallback(() => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }, []);
  const { scheduleCleanup: schedulePasswordCleanup, cancelCleanup: cancelPasswordCleanup } =
    useDeferredDialogCleanup(resetPasswordForm);

  const setPasswordDialogOpen = useCallback(
    (open: boolean) => {
      setPasswordDialogOpenState(open);
      if (open) {
        cancelPasswordCleanup();
        return;
      }
      schedulePasswordCleanup();
    },
    [cancelPasswordCleanup, schedulePasswordCleanup],
  );
  const handlePasswordDialogOpenChange = setPasswordDialogOpen;

  const updatePassword = useCallback(async () => {
    // 这里的校验是 UX 优化，不替代服务端 schema 和认证层校验。
    if (!currentPassword.trim()) {
      toast.error(t("passwordReset.currentRequired"));
      return;
    }
    if (!newPassword.trim()) {
      toast.error(t("passwordReset.passwordRequired"));
      return;
    }
    if (newPassword.length < 8) {
      toast.error(t("passwordReset.passwordMinShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(t("passwordReset.passwordMismatch"));
      return;
    }

    setIsUpdatingPassword(true);
    try {
      await apiFetch("/api/app/account/password", okResponseSchema, {
        method: "PUT",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      toast.success(t("passwordReset.passwordUpdatedWithNextLogin"));
      setPasswordDialogOpenState(false);
      schedulePasswordCleanup();
    } catch (e: unknown) {
      reportClientError(e, { source: "settings.password-change" });
      toast.error(t("passwordReset.changeFailed"), {
        description: getDisplayErrorMessage(e, t("passwordReset.changeFailedDescription")),
      });
    } finally {
      setIsUpdatingPassword(false);
    }
  }, [confirmPassword, currentPassword, newPassword, schedulePasswordCleanup, t]);

  return {
    passwordDialogOpen,
    setPasswordDialogOpen,
    handlePasswordDialogOpenChange,
    currentPassword,
    setCurrentPassword,
    newPassword,
    setNewPassword,
    confirmPassword,
    setConfirmPassword,
    isUpdatingPassword,
    updatePassword,
  };
}
