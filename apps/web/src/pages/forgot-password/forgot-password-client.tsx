/**
 * 忘记密码客户端表单。
 *
 * 架构位置：调用当前运行时的认证服务，页面入口只决定该功能是否可见。
 *
 * 注意： 发送失败可能来自 SMTP 未配置或网络问题，展示层只反馈通用错误，避免泄漏账号存在性。
 */
import { type FormEvent, useRef, useState } from "react";
import Link from '@/components/router-link';
import { ArrowLeft, CheckCircle2, Mail, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { RenewletBrandLockup } from "@/components/brand/renewlet-brand-mark";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { toast } from "@/components/ui/sonner";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/i18n/I18nProvider";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ForgotPasswordClientProps = {
  enabled: boolean;
};

export function ForgotPasswordClient({ enabled }: ForgotPasswordClientProps) {
  const emailInputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const { t } = useI18n();

  const validateEmail = () => {
    const trimmed = email.trim();
    if (!trimmed) return t("passwordReset.emailRequired");
    if (!emailPattern.test(trimmed)) return t("passwordReset.emailInvalid");
    return "";
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const error = validateEmail();
    if (error) {
      setEmailError(error);
      emailInputRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    setEmailError("");
    try {
      await authClient.requestPasswordReset(email.trim());
      setSubmitted(true);
    } catch (err: unknown) {
      toast.error(t("passwordReset.sendFailed"), {
        description: getDisplayErrorMessage(err, t("passwordReset.sendFailedDescription")),
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
            title={t("passwordReset.forgotTitle")}
            subtitle={t("passwordReset.forgotSubtitle")}
            titleClassName="text-xl"
          />

          {!enabled ? (
            <div className="rounded-lg border border-border bg-secondary/50 p-4 text-sm text-muted-foreground">
              <ShieldAlert className="mb-3 h-5 w-5 text-primary" />
              <p>{t("passwordReset.smtpUnavailable1")}</p>
              <p className="mt-2">{t("passwordReset.smtpUnavailable2")}</p>
            </div>
          ) : submitted ? (
            <div className="rounded-lg border border-border bg-secondary/50 p-4 text-sm text-muted-foreground">
              <CheckCircle2 className="mb-3 h-5 w-5 text-primary" />
              <p>{t("passwordReset.successMessage")}</p>
              <p className="mt-2">{t("passwordReset.successHint")}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="grid gap-4" noValidate>
              <FormField
                id="forgot-email"
                label={t("auth.email")}
                description={t("passwordReset.emailHelp")}
                descriptionId="forgot-email-description"
                error={emailError}
                errorId="forgot-email-error"
              >
                {(field) => (
                  <>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={emailInputRef}
                    id={field.id}
                    name="email"
                    type="email"
                    inputMode="email"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      if (emailError) setEmailError("");
                    }}
                    className="pl-10 bg-secondary border-border"
                    autoComplete="email"
                    enterKeyHint="done"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-invalid={field.invalid}
                    aria-describedby={field.describedBy}
                    required
                  />
                </div>
                  </>
                )}
              </FormField>

              <Button
                type="submit"
                className="w-full bg-primary text-primary-foreground hover:bg-primary-glow"
                disabled={isSubmitting}
              >
                {isSubmitting ? t("passwordReset.sending") : t("passwordReset.sendLink")}
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
