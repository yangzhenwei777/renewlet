import type { ImportDataDialogProps } from "@/components/import-data-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogModulePending } from "@/components/ui/dialog-module-pending";
import { createLazyDialogResource, useLazyDialogSession } from "@/hooks/use-lazy-dialog-session";
import { useI18n } from "@/i18n/I18nProvider";

const importDataDialogResource = createLazyDialogResource(() =>
  import("@/components/import-data-dialog").then((module) => module.ImportDataDialogContent),
);

export function preloadImportDataDialog(): void {
  void importDataDialogResource.load().catch(() => undefined);
}

/** 导入代码按 intent 加载，Portal 与焦点域由同步 shell 独占，避免骨架和真实工作台互换 modal 所有权。 */
export function DeferredImportDataDialog(props: ImportDataDialogProps) {
  const { t } = useI18n();
  const { value: Content, error, sessionKey } = useLazyDialogSession(props.open, importDataDialogResource);
  if (props.open && error) throw error;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        dismissMode="explicit"
        layout="frame"
        closeLabel={t("common.close")}
        className="h5-dialog-frame h5-import-dialog-panel overflow-hidden border-border bg-card p-0 sm:max-w-5xl"
        aria-busy={Content ? undefined : true}
        data-testid={Content ? undefined : "import-data-dialog-loading"}
      >
        {Content ? (
          <Content key={sessionKey} {...props} />
        ) : (
          <>
            <DialogHeader className="shrink-0 border-b border-border bg-secondary/20 px-4 py-5 pr-12 sm:px-6 sm:pr-14">
              <DialogTitle className="text-xl">{t("import.title")}</DialogTitle>
              <DialogDescription className="mt-1 text-left">{t("import.description")}</DialogDescription>
            </DialogHeader>
            <DialogModulePending label={t("common.loading")} className="min-h-0" />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
