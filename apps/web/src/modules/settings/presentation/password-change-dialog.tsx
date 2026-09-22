/**
 * 当前用户修改密码弹窗。
 *
 * 架构位置：只展示 current/new/confirm 三段输入；提交和密码 state 生命周期由调用方 controller 管理。
 */
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/I18nProvider";

export interface PasswordChangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPassword: string;
  onCurrentPasswordChange: (value: string) => void;
  newPassword: string;
  onNewPasswordChange: (value: string) => void;
  confirmPassword: string;
  onConfirmPasswordChange: (value: string) => void;
  isUpdating: boolean;
  onSubmit: () => void | Promise<void>;
}

export function PasswordChangeDialog({
  open,
  onOpenChange,
  currentPassword,
  onCurrentPasswordChange,
  newPassword,
  onNewPasswordChange,
  confirmPassword,
  onConfirmPasswordChange,
  isUpdating,
  onSubmit,
}: PasswordChangeDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dismissMode="explicit" className="border-border bg-card">
        <DialogHeader>
          <DialogTitle>{t("settings.passwordDialogTitle")}</DialogTitle>
          <DialogDescription>{t("settings.passwordDialogDescription")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="currentPassword">{t("settings.currentPassword")}</Label>
            <Input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => onCurrentPasswordChange(e.target.value)}
              placeholder={t("settings.currentPasswordPlaceholder")}
              className="border-border bg-secondary"
              autoComplete="current-password"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="newPassword">{t("passwordReset.newPassword")}</Label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => onNewPasswordChange(e.target.value)}
              placeholder={t("settings.newPasswordPlaceholder")}
              className="border-border bg-secondary"
              autoComplete="new-password"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirmPassword">{t("passwordReset.confirmPassword")}</Label>
            <Input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => onConfirmPasswordChange(e.target.value)}
              placeholder={t("settings.confirmPasswordPlaceholder")}
              className="border-border bg-secondary"
              autoComplete="new-password"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={onSubmit}
            disabled={isUpdating}
            className="bg-primary text-primary-foreground hover:bg-primary-glow"
          >
            {isUpdating ? t("common.saving") : t("settings.saveNewPassword")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
