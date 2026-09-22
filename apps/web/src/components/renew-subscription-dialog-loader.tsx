import type { RenewSubscriptionDialogProps } from "@/components/renew-subscription-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogModulePending } from "@/components/ui/dialog-module-pending";
import { useI18n } from "@/i18n/I18nProvider";
import { createLazyDialogResource, useLazyDialogSession } from "@/hooks/use-lazy-dialog-session";

const renewSubscriptionDialogResource = createLazyDialogResource(() =>
  import("@/components/renew-subscription-dialog").then((module) => module.RenewSubscriptionDialogContent),
);

export function preloadRenewSubscriptionDialog(): void {
  void renewSubscriptionDialogResource.load().catch(() => undefined);
}

/** 续订代码按 intent 加载，但单次 open session 始终复用同一套 Radix Portal、焦点域和退出动画。 */
export function DeferredRenewSubscriptionDialog(props: RenewSubscriptionDialogProps) {
  const { t } = useI18n();
  const { value: Content, error, sessionKey } = useLazyDialogSession(props.open, renewSubscriptionDialogResource);
  const titleSubscription = props.subscription ?? props.loadingPreview;
  const title = titleSubscription
    ? t("subscription.renew.title", { name: titleSubscription.name })
    : t("subscription.renew");
  if (props.open && error) throw error;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        closeLabel={t("common.close")}
        dismissMode="explicit"
        layout="content"
        className="h5-dialog-auto-frame gap-0 border-border bg-card p-0 sm:max-w-lg"
        aria-busy={!Content || props.loading ? true : undefined}
        data-testid={Content ? undefined : "renew-subscription-dialog-module-pending"}
        onCloseAutoFocus={(event) => {
          if (!props.restoreFocusRef?.current) return;
          event.preventDefault();
          props.restoreFocusRef.current.focus();
        }}
      >
        {Content ? (
          <Content key={sessionKey} {...props} />
        ) : (
          <>
            <DialogHeader className="shrink-0 p-6 pb-0">
              <DialogTitle className="text-xl font-semibold">{title}</DialogTitle>
              <DialogDescription className="sr-only">
                {t("subscription.renew.description")}
              </DialogDescription>
            </DialogHeader>
            <DialogModulePending label={t("common.loading")} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
