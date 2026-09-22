import type { ReactNode } from "react";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";

interface SettingsManagerDialogFrameProps {
  icon?: ReactNode;
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  descriptionVisible?: boolean;
  bodyClassName?: string;
  contentClassName?: string;
  bodyTestId?: string;
}

export function SettingsManagerDialogFrame({
  icon,
  title,
  description,
  children,
  footer,
  descriptionVisible = false,
  bodyClassName,
  contentClassName,
  bodyTestId,
}: SettingsManagerDialogFrameProps) {
  const { t } = useI18n();

  return (
    <DialogContent
      dismissMode="explicit"
      layout="frame"
      closeLabel={t("common.close")}
      className={cn(
        "h5-dialog-frame h5-settings-manager-dialog-panel min-h-0 max-w-3xl gap-0 overflow-hidden border-border bg-card p-0",
        contentClassName,
      )}
    >
      <DialogHeader data-settings-manager-header="" className="shrink-0 border-b border-border px-4 py-5 pr-12 text-left sm:px-6 sm:pr-14">
        <DialogTitle className="flex items-center gap-2">
          {icon}
          {title}
        </DialogTitle>
        <DialogDescription className={descriptionVisible ? "text-left" : "sr-only"}>
          {description}
        </DialogDescription>
      </DialogHeader>
      <div
        className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6", bodyClassName)}
        data-testid={bodyTestId}
      >
        {children}
      </div>
      {footer ? (
        <DialogFooter data-settings-manager-footer="" className="shrink-0 border-t border-border px-4 py-4 sm:px-6">
          {footer}
        </DialogFooter>
      ) : null}
    </DialogContent>
  );
}
