/**
 * 重置密码客户端表单。
 *
 * 架构位置：负责本地密码一致性校验和当前运行时认证服务的密码重置确认调用。
 *
 * 注意： 成功后立即清空本地密码 state，避免用户离开页面前明文继续停留在内存和输入框中。
 */
import { type FormEvent, useRef, useState } from "react";
import Link from '@/components/router-link';
import { ArrowLeft, CheckCircle2, Eye, EyeOff, Lock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { RenewletBrandLockup } from "@/components/brand/renewlet-brand-mark";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { toast } from "@/components/ui/sonner";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/i18n/I18nProvider";

type ResetPasswordClientProps = {
  token: string;
};

type ResetPasswordErrors = Partial<Record<"password" | "confirm", string>>;

export function ResetPasswordClient({ token }: ResetPasswordClientProps) {
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<ResetPasswordErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const { t } = useI18n();

  const validate = () => {
    const nextErrors: ResetPasswordErrors = {};
    if (!password.trim()) {
      nextErrors.password = t("passwordReset.passwordRequired");
    } else if (password.length < 8) {
      nextErrors.password = t("passwordReset.passwordLength");
    }

    if (!confirm) {
      nextErrors.confirm = t("passwordReset.confirmRequired");
    } else if (password !== confirm) {
      nextErrors.confirm = t("passwordReset.passwordMismatch");
    }

    return nextErrors;
  };

  const focusFirstError = (nextErrors: ResetPasswordErrors) => {
    if (nextErrors.password) {
      passwordInputRef.current?.focus();
      return;
    }
    if (nextErrors.confirm) {
      confirmInputRef.current?.focus();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate();
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      focusFirstError(nextErrors);
      return;
    }

    setIsSubmitting(true);
    setErrors({});
    try {
      await authClient.confirmPasswordReset(token, password);
      setSucceeded(true);
      setPassword("");
      setConfirm("");
    } catch (err: unknown) {
      toast.error(t("passwordReset.resetFailed"), {
        description: getDisplayErrorMessage(err, t("passwordReset.resetFailedDescription")),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-page theme-gradient">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-border bg-card p-6 shadow-card grid gap-6 sm:p-8">
          <RenewletBrandLockup
            title={t("passwordReset.newTitle")}
            subtitle={t("passwordReset.newSubtitle")}
            titleClassName="text-xl"
          />

          {!token ? (
            <div className="rounded-lg border border-border bg-secondary/50 p-4 text-sm text-muted-foreground">
              <ShieldAlert className="mb-3 h-5 w-5 text-primary" />
              <p>{t("passwordReset.tokenMissing1")}</p>
              <p className="mt-2">{t("passwordReset.tokenMissing2")}</p>
            </div>
          ) : succeeded ? (
            <div className="rounded-lg border border-border bg-secondary/50 p-4 text-sm text-muted-foreground">
              <CheckCircle2 className="mb-3 h-5 w-5 text-primary" />
              <p>{t("passwordReset.updatedLogin")}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="grid gap-4" noValidate>
              <FormField
                id="new-password"
                label={t("passwordReset.newPassword")}
                description={t("passwordReset.passwordHelp")}
                descriptionId="new-password-description"
                error={errors.password}
              >
                {(field) => (
                  <>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={passwordInputRef}
                    id={field.id}
                    name="new-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (errors.password) setErrors((prev) => {
                        const { password: _password, ...next } = prev;
                        return next;
                      });
                    }}
                    className="pl-10 pr-10 bg-secondary border-border"
                    autoComplete="new-password"
                    enterKeyHint="next"
                    aria-invalid={field.invalid}
                    aria-describedby={field.describedBy}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                  </>
                )}
              </FormField>

              <FormField id="confirm-password" label={t("passwordReset.confirmPassword")} error={errors.confirm}>
                {(field) => (
                <Input
                  ref={confirmInputRef}
                  id={field.id}
                  name="confirm-password"
                  type={showPassword ? "text" : "password"}
                  value={confirm}
                  onChange={(event) => {
                    setConfirm(event.target.value);
                    if (errors.confirm) setErrors((prev) => {
                      const { confirm: _confirm, ...next } = prev;
                      return next;
                    });
                  }}
                  className="bg-secondary border-border"
                  autoComplete="new-password"
                  enterKeyHint="done"
                  aria-invalid={field.invalid}
                  aria-describedby={field.describedBy}
                  required
                />
                )}
              </FormField>

              <Button
                type="submit"
                className="w-full bg-primary text-primary-foreground hover:bg-primary-glow"
                disabled={isSubmitting}
              >
                {isSubmitting ? t("common.saving") : t("passwordReset.saveNew")}
              </Button>
            </form>
          )}

          <div className="flex items-center justify-between text-sm">
            <Link href="/login" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
              {t("common.backToLogin")}
            </Link>
            <Link href="/" className="text-muted-foreground hover:text-foreground">
              {t("common.backHome")}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
