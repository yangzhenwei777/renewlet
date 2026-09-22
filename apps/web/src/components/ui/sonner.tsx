/**
 * 全局通知外壳（Sonner）。
 *
 * 架构位置：跟随 ThemeProvider 与 i18n 状态，提供轻量异步反馈；业务页面只触发消息，不控制容器。
 *
 * 注意： 图标与颜色是全站反馈语义，调整前需要检查成功/警告/错误在深浅主题下的可辨识度。
 */
import { useTheme } from '@/lib/theme-provider';
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";

const toastIconClassName = "h-4 w-4";

const toastClassName =
  "group toast group-[.toaster]:rounded-lg group-[.toaster]:border-border/80 group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:shadow-lg group-[.toaster]:shadow-black/10 dark:group-[.toaster]:shadow-black/40 data-[type=success]:border-success/50 data-[type=error]:border-destructive/50 data-[type=warning]:border-warning/50 data-[type=info]:border-primary/45";

const Toaster = ({ toastOptions, ...props }: ToasterProps) => {
  const { theme } = useTheme();
  const { t } = useI18n();
  const resolvedTheme: NonNullable<ToasterProps["theme"]> = theme ?? "system";

  return (
    <Sonner
      theme={resolvedTheme}
      position="bottom-right"
      duration={5000}
      visibleToasts={1}
      closeButton
      containerAriaLabel={t("common.notifications")}
      className="toaster group"
      toastOptions={{
        ...toastOptions,
        closeButtonAriaLabel: toastOptions?.closeButtonAriaLabel ?? t("common.dismissNotification"),
        classNames: {
          ...toastOptions?.classNames,
          toast: cn(toastClassName, toastOptions?.classNames?.toast),
          title: cn("group-[.toast]:font-medium", toastOptions?.classNames?.title),
          description: cn("group-[.toast]:text-muted-foreground", toastOptions?.classNames?.description),
          icon: cn("group-[.toast]:mt-0.5", toastOptions?.classNames?.icon),
          closeButton: cn(
            "group-[.toast]:border-border group-[.toast]:bg-popover group-[.toast]:text-muted-foreground group-[.toast]:hover:text-foreground",
            toastOptions?.classNames?.closeButton,
          ),
          actionButton: cn(
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
            toastOptions?.classNames?.actionButton,
          ),
          cancelButton: cn(
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
            toastOptions?.classNames?.cancelButton,
          ),
        },
      }}
      icons={{
        success: (
          <CheckCircle2
            aria-hidden="true"
            className={cn(toastIconClassName, "text-success")}
            data-testid="toast-success-icon"
          />
        ),
        error: (
          <XCircle
            aria-hidden="true"
            className={cn(toastIconClassName, "text-destructive")}
            data-testid="toast-error-icon"
          />
        ),
        warning: (
          <AlertTriangle
            aria-hidden="true"
            className={cn(toastIconClassName, "text-warning")}
            data-testid="toast-warning-icon"
          />
        ),
        info: (
          <Info aria-hidden="true" className={cn(toastIconClassName, "text-primary")} data-testid="toast-info-icon" />
        ),
        loading: (
          <Loader2
            aria-hidden="true"
            className={cn(toastIconClassName, "animate-spin text-primary")}
            data-testid="toast-loading-icon"
          />
        ),
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
