import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AIRecognizeSubscriptionDialogProps } from "@/components/ai-recognize-subscription-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogModulePending } from "@/components/ui/dialog-module-pending";
import { createLazyDialogResource, useLazyDialogSession } from "@/hooks/use-lazy-dialog-session";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useNestedDialogCloseGuard } from "@/hooks/use-nested-dialog-close-guard";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";

const aiRecognizeSubscriptionDialogResource = createLazyDialogResource(() =>
  import("@/components/ai-recognize-subscription-dialog").then((module) => module.AIRecognizeSubscriptionDialogContent),
);

export function preloadAIRecognizeSubscriptionDialog(): void {
  void aiRecognizeSubscriptionDialogResource.load().catch(() => undefined);
}

/** AI 工作台按 intent 加载，当前会话的 shell 与嵌套弹层关闭保护始终由同步边界持有。 */
export function DeferredAIRecognizeSubscriptionDialog(props: AIRecognizeSubscriptionDialogProps) {
  const { t } = useI18n();
  const isMobile = useMediaQuery("(max-width: 639px)");
  const wasOpenRef = useRef(props.open);
  const [workflowExpanded, setWorkflowExpanded] = useState(false);
  const { handleNestedDialogOpenChange, handleParentOpenChange } = useNestedDialogCloseGuard(
    props.open,
    props.onOpenChange,
  );
  const { value: Content, error, sessionKey } = useLazyDialogSession(props.open, aiRecognizeSubscriptionDialogResource);
  const handleRequestClose = useCallback(() => handleParentOpenChange(false), [handleParentOpenChange]);

  useLayoutEffect(() => {
    if (props.open && !wasOpenRef.current) setWorkflowExpanded(false);
    wasOpenRef.current = props.open;
  }, [props.open]);

  if (props.open && error) throw error;

  return (
    <Dialog open={props.open} onOpenChange={handleParentOpenChange}>
      <DialogContent
        dismissMode="explicit"
        layout="frame"
        closeLabel={t("common.close")}
        className={cn(
          "overflow-hidden border-border bg-card p-0",
          isMobile
            ? "h5-ai-recognition-workbench-frame"
            : cn(
              "h5-import-dialog-panel sm:max-w-6xl",
              workflowExpanded ? "h5-dialog-frame" : "h5-ai-recognition-input-dialog-frame",
            ),
        )}
        aria-busy={Content ? undefined : true}
        data-testid={Content ? undefined : "ai-recognition-dialog-loading"}
        onOpenAutoFocus={(event) => {
          if (Content) event.preventDefault();
        }}
      >
        {Content ? (
          <Content
            key={sessionKey}
            open={props.open}
            settings={props.settings}
            apiKeyConfigured={props.apiKeyConfigured}
            config={props.config}
            availableTags={props.availableTags}
            onNestedDialogOpenChange={handleNestedDialogOpenChange}
            onRequestClose={handleRequestClose}
            onWorkflowExpandedChange={setWorkflowExpanded}
          />
        ) : (
          <>
            <DialogHeader
              className={cn(
                "shrink-0 border-b border-border bg-card pr-12",
                isMobile ? "px-4 py-3 text-left" : "px-4 py-4 sm:px-6 sm:pr-14",
              )}
            >
              <DialogTitle className={isMobile ? "text-base leading-6" : "text-lg"}>
                {t("aiRecognition.dialogTitle")}
              </DialogTitle>
              <DialogDescription className={isMobile ? "sr-only" : "mt-1 max-w-3xl text-left leading-5"}>
                {t("aiRecognition.dialogDescription")}
              </DialogDescription>
            </DialogHeader>
            <DialogModulePending
              label={t("common.loading")}
              className={isMobile ? "row-[2/-1] min-h-0" : "min-h-0"}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
