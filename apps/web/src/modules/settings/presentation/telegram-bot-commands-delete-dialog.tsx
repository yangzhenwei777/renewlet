import type { RefObject } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/i18n/I18nProvider";
import { LoadingButtonContent } from "./settings-shared-controls";

interface TelegramBotCommandsDeleteDialogProps {
  open: boolean;
  pending: boolean;
  focusFallbackRef: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  onDelete: () => Promise<void>;
}

export function TelegramBotCommandsDeleteDialog({
  open,
  pending,
  focusFallbackRef,
  onOpenChange,
  onDelete,
}: TelegramBotCommandsDeleteDialogProps) {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && !pending) onOpenChange(false);
    }}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // 删除后原删除按钮会转为禁用，回到稳定的安装操作，避免焦点停在不可操作控件上。
          focusFallbackRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t("settings.telegramBotCommandsDeleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("settings.telegramBotCommandsDeleteDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            aria-busy={pending ? true : undefined}
            onClick={(event) => {
              event.preventDefault();
              void onDelete().finally(() => onOpenChange(false));
            }}
          >
            <LoadingButtonContent loading={pending} loadingLabel={t("settings.telegramBotCommandsDeleting")}>
              {t("settings.telegramBotCommandsDelete")}
            </LoadingButtonContent>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
