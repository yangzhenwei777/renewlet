/**
 * 管理员用户操作弹窗。
 *
 * 架构位置：创建、重置密码、删除确认都由 AdminUsersPage 持有状态，本文件只负责表单可访问性和展示。
 *
 * 注意： 删除弹窗文案必须继续提示关联数据会被清理；后端实际级联逻辑变化时要同步这里。
 */
import type { FormEvent, RefObject } from "react";
import { KeyRound, UserPlus } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/i18n/I18nProvider";
import type { AdminUser } from "@/lib/api/schemas/admin";
import type { CreateUserErrors, CreateUserFormState, ResetPasswordErrors } from "./types";

export interface CreateUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: CreateUserFormState;
  errors: CreateUserErrors;
  isCreating: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  updateForm: <K extends keyof CreateUserFormState>(field: K, value: CreateUserFormState[K]) => void;
  nameInputRef: RefObject<HTMLInputElement | null>;
  emailInputRef: RefObject<HTMLInputElement | null>;
  passwordInputRef: RefObject<HTMLInputElement | null>;
  confirmPasswordInputRef: RefObject<HTMLInputElement | null>;
}

export function CreateUserDialog({
  open,
  onOpenChange,
  form,
  errors,
  isCreating,
  onSubmit,
  updateForm,
  nameInputRef,
  emailInputRef,
  passwordInputRef,
  confirmPasswordInputRef,
}: CreateUserDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dismissMode="explicit" className="border-border bg-card sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            {t("admin.createUser")}
          </DialogTitle>
          <DialogDescription>{t("admin.createDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <FormFieldRow
            alignAt="sm"
            rowClassName="sm:grid-cols-2"
            errors={[
              { id: "create-user-name-error", message: errors.name },
              { id: "create-user-email-error", message: errors.email },
            ]}
          >
            <FormField id="create-user-name" label={t("setup.name")} error={errors.name} renderError={false}>
              {(field) => (
                <Input
                  ref={nameInputRef}
                  id={field.id}
                  value={form.name}
                  onChange={(e) => updateForm("name", e.target.value)}
                  aria-invalid={field.invalid}
                  aria-describedby={field.describedBy}
                  autoComplete="name"
                  required
                />
              )}
            </FormField>
            <FormField id="create-user-email" label={t("auth.email")} error={errors.email} renderError={false}>
              {(field) => (
                <Input
                  ref={emailInputRef}
                  id={field.id}
                  type="email"
                  value={form.email}
                  onChange={(e) => updateForm("email", e.target.value)}
                  aria-invalid={field.invalid}
                  aria-describedby={field.describedBy}
                  autoComplete="email"
                  required
                />
              )}
            </FormField>
          </FormFieldRow>
          <FormFieldRow
            alignAt="sm"
            rowClassName="sm:grid-cols-2"
            errors={[
              { id: "create-user-password-error", message: errors.password },
              { id: "create-user-confirm-password-error", message: errors.confirmPassword },
            ]}
          >
            <FormField id="create-user-password" label={t("admin.initialPassword")} error={errors.password} renderError={false}>
              {(field) => (
                <Input
                  ref={passwordInputRef}
                  id={field.id}
                  type="password"
                  minLength={8}
                  value={form.password}
                  onChange={(e) => updateForm("password", e.target.value)}
                  aria-invalid={field.invalid}
                  aria-describedby={field.describedBy}
                  autoComplete="new-password"
                  required
                />
              )}
            </FormField>
            <FormField
              id="create-user-confirm-password"
              label={t("admin.confirmInitialPassword")}
              error={errors.confirmPassword}
              renderError={false}
            >
              {(field) => (
                <Input
                  ref={confirmPasswordInputRef}
                  id={field.id}
                  type="password"
                  minLength={8}
                  value={form.confirmPassword}
                  onChange={(e) => updateForm("confirmPassword", e.target.value)}
                  aria-invalid={field.invalid}
                  aria-describedby={field.describedBy}
                  autoComplete="new-password"
                  required
                />
              )}
            </FormField>
          </FormFieldRow>
          <div className="grid gap-2">
            <Label htmlFor="create-user-role">{t("admin.role")}</Label>
            <Select
              value={form.role}
              onValueChange={(value) => updateForm("role", value === "admin" ? "admin" : "user")}
            >
              <SelectTrigger id="create-user-role" aria-label={t("admin.role")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t("admin.roleUser")}</SelectItem>
                <SelectItem value="admin">{t("admin.roleAdmin")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              className="bg-primary text-primary-foreground hover:bg-primary-glow"
              disabled={isCreating}
            >
              {isCreating ? t("common.creating") : t("admin.createUser")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface ResetPasswordDialogProps {
  user: AdminUser | null;
  updatingUserIds: Set<string>;
  password: string;
  confirmPassword: string;
  errors: ResetPasswordErrors;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  onPasswordChange: (password: string) => void;
  onConfirmPasswordChange: (password: string) => void;
  clearErrors: () => void;
  resetDialog: () => void;
  passwordInputRef: RefObject<HTMLInputElement | null>;
  confirmPasswordInputRef: RefObject<HTMLInputElement | null>;
}

export function ResetPasswordDialog({
  user,
  updatingUserIds,
  password,
  confirmPassword,
  errors,
  onOpenChange,
  onSubmit,
  onPasswordChange,
  onConfirmPasswordChange,
  clearErrors,
  resetDialog,
  passwordInputRef,
  confirmPasswordInputRef,
}: ResetPasswordDialogProps) {
  const { t } = useI18n();
  const isSaving = user ? updatingUserIds.has(user.id) : false;

  return (
    <Dialog open={Boolean(user)} onOpenChange={onOpenChange}>
      <DialogContent dismissMode="explicit" className="border-border bg-card sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            {t("admin.resetPassword")}
          </DialogTitle>
          <DialogDescription>
            {user
              ? t("admin.resetDescription", { name: user.name, email: user.email })
              : t("admin.resetFallback")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <FormField id="reset-user-password" label={t("passwordReset.newPassword")} error={errors.password}>
            {(field) => (
              <Input
                ref={passwordInputRef}
                id={field.id}
                type="password"
                minLength={8}
                value={password}
                onChange={(e) => {
                  onPasswordChange(e.target.value);
                  clearErrors();
                }}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                autoComplete="new-password"
                required
              />
            )}
          </FormField>
          <FormField id="reset-user-confirm-password" label={t("passwordReset.confirmPassword")} error={errors.confirmPassword}>
            {(field) => (
              <Input
                ref={confirmPasswordInputRef}
                id={field.id}
                type="password"
                minLength={8}
                value={confirmPassword}
                onChange={(e) => {
                  onConfirmPasswordChange(e.target.value);
                  clearErrors();
                }}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                autoComplete="new-password"
                required
              />
            )}
          </FormField>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={resetDialog}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              className="bg-primary text-primary-foreground hover:bg-primary-glow"
              disabled={!user || isSaving}
            >
              {isSaving ? t("common.saving") : t("passwordReset.saveNew")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface ResetMfaDialogProps {
  target: AdminUser | null;
  updatingUserIds: Set<string>;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}

export function ResetMfaDialog({
  target,
  updatingUserIds,
  onOpenChange,
  onConfirm,
}: ResetMfaDialogProps) {
  const { t } = useI18n();
  const isResetting = target ? updatingUserIds.has(target.id) : false;

  return (
    <AlertDialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("admin.resetMfaTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? t("admin.resetMfaDescription", { name: target.name, email: target.email })
              : t("admin.resetMfaFallback")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isResetting}>
            {isResetting ? t("common.saving") : t("admin.confirmResetMfa")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface ResetPasskeysDialogProps {
  target: AdminUser | null;
  updatingUserIds: Set<string>;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}

export function ResetPasskeysDialog({
  target,
  updatingUserIds,
  onOpenChange,
  onConfirm,
}: ResetPasskeysDialogProps) {
  const { t } = useI18n();
  const isResetting = target ? updatingUserIds.has(target.id) : false;

  return (
    <AlertDialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("admin.resetPasskeysTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? t("admin.resetPasskeysDescription", { name: target.name, email: target.email })
              : t("admin.resetPasskeysFallback")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isResetting}>
            {isResetting ? t("common.saving") : t("admin.confirmResetPasskeys")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface DeleteUserDialogProps {
  target: AdminUser | null;
  updatingUserIds: Set<string>;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}

export function DeleteUserDialog({ target, updatingUserIds, onOpenChange, onConfirm }: DeleteUserDialogProps) {
  const { t } = useI18n();
  const isDeleting = target ? updatingUserIds.has(target.id) : false;

  return (
    <AlertDialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <AlertDialogContent className="border-border bg-card">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("admin.deleteUser")}</AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? t("admin.deleteDescription", { name: target.name, email: target.email })
              : t("admin.deleteFallback")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={!target || isDeleting}
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            {isDeleting ? t("admin.deleting") : t("admin.confirmDelete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
