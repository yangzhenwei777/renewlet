import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { AlertTriangle, Archive, CheckCircle2, FileJson, FileUp, Loader2 } from "lucide-react";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ImportFileDropZone, ImportPastePanel, ImportStep } from "@/components/import-data-dialog-parts";
import { ImportPreviewPanel } from "@/components/import-preview-panel";
import { useDeferredDialogInitialFocus } from "@/hooks/use-deferred-dialog-initial-focus";
import { useI18n } from "@/i18n/I18nProvider";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import type { CustomConfig } from "@/types/config";
import type { AppSettings } from "@/types/subscription";
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_PREVIEW_SUBSCRIPTIONS,
  type WallosImportUser,
} from "@/modules/import-export/domain/import-export-model";
import {
  parseImportFile,
  parseJsonText,
} from "@/modules/import-export/domain/wallos-import";
import { formatImportMessage } from "@/modules/import-export/domain/import-message-format";
import { useImportPreviewApply } from "@/modules/import-export/application/use-import-preview-apply";

export interface ImportDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 导入解析使用当前设置里的 timezone/defaultCurrency/reminder 默认值，不自行读取全局 query。 */
  settings: AppSettings;
  /** Wallos/Renewlet 导入会映射分类、状态、支付方式和货币，必须使用当前已规范化配置。 */
  config: CustomConfig;
  /** 外部恢复入口预载的文件；仍然只进入 preview/apply，不在弹窗外写库。 */
  initialFile?: File | null;
  /** 云快照外层 ZIP 已通过后端 hash 校验，可使用独立于普通导入的 16 MiB 存储包上限。 */
  initialFileMaxBytes?: number;
  onInitialFileConsumed?: () => void;
}

export function ImportDataDialogContent({ open, onOpenChange, settings, config, initialFile, initialFileMaxBytes, onInitialFileConsumed }: ImportDataDialogProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const consumedInitialFileRef = useRef<File | null>(null);
  const parseAbortRef = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [pasteValue, setPasteValue] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [wallosUsers, setWallosUsers] = useState<WallosImportUser[]>([]);
  const [selectedWallosUser, setSelectedWallosUser] = useState<string>("");
  const [parsing, setParsing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const today = todayDateOnlyInTimeZone(new Date(), settings.timezone);
  const importPreview = useImportPreviewApply({ onApplied: () => onOpenChange(false) });
  const resolveInitialFocus = useCallback(() => uploadButtonRef.current, []);
  const {
    prepared,
    preview,
    conflictMode,
    previewFilter,
    skippedIndexes,
    error,
    applying,
    assetProgress,
    applyProgress,
    setError,
    setPreviewFilter,
    resetImportPreview,
    previewPrepared,
    handleConflictModeChange,
    handleLogoChange,
    handleSkipChange,
    handleApply,
  } = importPreview;
  useDeferredDialogInitialFocus(open, true, "import", resolveInitialFocus);

  const parseFile = useCallback(async (
    nextFile: File,
    options: {
      maxFileBytes: number;
      signal: AbortSignal;
      wallosUserId?: string;
    },
  ) => {
    const { maxFileBytes, signal, wallosUserId } = options;
    if (nextFile.size > maxFileBytes) {
      throw new Error(t("import.fileTooLarge"));
    }
    // 文件类型只做入口提示，真实识别按内容探测；zip/db 解析器只在导入弹窗内动态加载。
    const parsed = await parseImportFile(nextFile, { config, settings, today }, wallosUserId, maxFileBytes, signal);
    if (parsed.payload.subscriptions.length > MAX_IMPORT_PREVIEW_SUBSCRIPTIONS) {
      throw new Error(t("import.fileTooLarge"));
    }
    setWallosUsers(parsed.wallosUsers ?? []);
    if (parsed.wallosUsers?.length && !wallosUserId) {
      setSelectedWallosUser(parsed.wallosUsers[0]?.id ?? "");
    }
    await previewPrepared(parsed, conflictMode, signal);
  }, [config, conflictMode, previewPrepared, settings, t, today]);

  const handleFileSelected = useCallback(async (nextFile: File | null, maxFileBytes = MAX_IMPORT_FILE_BYTES) => {
    if (!nextFile) return;
    // 文件对象只保存在弹窗生命周期内；预览失败时清掉 PreparedImport，避免应用上一次成功解析的包。
    setFile(nextFile);
    parseAbortRef.current?.abort();
    const controller = new AbortController();
    parseAbortRef.current = controller;
    setParsing(true);
    setError(null);
    try {
      await parseFile(nextFile, {
        maxFileBytes,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      resetImportPreview();
      setError(err instanceof Error ? formatImportMessage(err.message, t) : t("import.parseFailed"));
    } finally {
      if (parseAbortRef.current === controller) {
        parseAbortRef.current = null;
        setParsing(false);
      }
    }
  }, [parseFile, resetImportPreview, setError, t]);

  const handleFileDrop = async (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragActive(false);
    await handleFileSelected(event.dataTransfer.files?.[0] ?? null);
  };

  const handlePastePreview = async () => {
    parseAbortRef.current?.abort();
    const controller = new AbortController();
    parseAbortRef.current = controller;
    setFile(null);
    setParsing(true);
    setError(null);
    try {
      if (new TextEncoder().encode(pasteValue).byteLength > MAX_IMPORT_FILE_BYTES) {
        throw new Error(t("import.fileTooLarge"));
      }
      const parsed = await parseJsonText(pasteValue, { config, settings, today });
      if (parsed.payload.subscriptions.length > MAX_IMPORT_PREVIEW_SUBSCRIPTIONS) {
        throw new Error(t("import.fileTooLarge"));
      }
      controller.signal.throwIfAborted();
      setWallosUsers(parsed.wallosUsers ?? []);
      if (parsed.wallosUsers?.length) {
        setSelectedWallosUser(parsed.wallosUsers[0]?.id ?? "");
      }
      await previewPrepared(parsed, conflictMode, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      resetImportPreview();
      setError(err instanceof Error ? formatImportMessage(err.message, t) : t("import.parseFailed"));
    } finally {
      if (parseAbortRef.current === controller) {
        parseAbortRef.current = null;
        setParsing(false);
      }
    }
  };

  const handleWallosUserChange = async (value: string) => {
    setSelectedWallosUser(value);
    parseAbortRef.current?.abort();
    const controller = new AbortController();
    parseAbortRef.current = controller;
    setParsing(true);
    setError(null);
    try {
      if (file) {
        await parseFile(file, {
          maxFileBytes: MAX_IMPORT_FILE_BYTES,
          signal: controller.signal,
          wallosUserId: value,
        });
      } else if (pasteValue.trim()) {
        if (new TextEncoder().encode(pasteValue).byteLength > MAX_IMPORT_FILE_BYTES) {
          throw new Error(t("import.fileTooLarge"));
        }
        const parsed = await parseJsonText(pasteValue, { config, settings, today }, value);
        if (parsed.payload.subscriptions.length > MAX_IMPORT_PREVIEW_SUBSCRIPTIONS) {
          throw new Error(t("import.fileTooLarge"));
        }
        await previewPrepared(parsed, conflictMode, controller.signal);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? formatImportMessage(err.message, t) : t("import.parseFailed"));
    } finally {
      if (parseAbortRef.current === controller) {
        parseAbortRef.current = null;
        setParsing(false);
      }
    }
  };

  useEffect(() => {
    if (!open || !initialFile || consumedInitialFileRef.current === initialFile) return;
    consumedInitialFileRef.current = initialFile;
    setMode("file");
    void handleFileSelected(initialFile, initialFileMaxBytes ?? MAX_IMPORT_FILE_BYTES).finally(() => {
      onInitialFileConsumed?.();
    });
  }, [handleFileSelected, initialFile, initialFileMaxBytes, onInitialFileConsumed, open]);

  useEffect(() => () => parseAbortRef.current?.abort(), []);

  useLayoutEffect(() => {
    if (!open) {
      // 关闭会话只取消在途解析，不重置退出动画中的可见内容；下次打开会由新的 content key 建立全新草稿。
      parseAbortRef.current?.abort();
      parseAbortRef.current = null;
      return;
    }
  }, [open]);

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-border bg-secondary/20 px-4 py-5 pr-12 sm:px-6 sm:pr-14">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-primary">
            <FileUp className="h-5 w-5" />
          </div>
          <div className="min-w-0 text-left">
            <DialogTitle className="text-xl">{t("import.title")}</DialogTitle>
            <DialogDescription className="mt-1 text-left">{t("import.description")}</DialogDescription>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 overflow-hidden rounded-lg border border-border bg-background/70 text-xs">
          <ImportStep active done label={t("import.stepSelect")} />
          <ImportStep active={Boolean(preview)} done={Boolean(preview)} label={t("import.stepPreview")} />
          <ImportStep active={Boolean(preview && preview.summary.errors === 0)} label={t("import.stepApply")} />
        </div>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
        <Tabs value={mode} onValueChange={(value) => setMode(value as "file" | "paste")} className="space-y-4">
          <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:min-w-80">
            <TabsTrigger value="file" className="gap-2">
              <Archive className="h-4 w-4" />
              {t("import.tabFile")}
            </TabsTrigger>
            <TabsTrigger value="paste" className="gap-2">
              <FileJson className="h-4 w-4" />
              {t("import.tabPaste")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="mt-0 space-y-3">
            <ImportFileDropZone
              file={file}
              dragActive={dragActive}
              fileInputRef={fileInputRef}
              uploadButtonRef={uploadButtonRef}
              onFileSelected={(nextFile) => void handleFileSelected(nextFile)}
              onFileDrop={(event) => void handleFileDrop(event)}
              onDragActiveChange={setDragActive}
              chooseFileLabel={t("import.chooseFile")}
              fileEmptyLabel={t("import.fileEmpty")}
              fileHintLabel={t("import.fileHint")}
            />
          </TabsContent>

          <TabsContent value="paste" className="mt-0 space-y-3">
            <ImportPastePanel
              value={pasteValue}
              parsing={parsing}
              onChange={setPasteValue}
              onPreview={() => void handlePastePreview()}
              placeholder={t("import.pastePlaceholder")}
              previewLabel={t("import.preview")}
            />
          </TabsContent>
        </Tabs>

        {error && (
          <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {parsing && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {t("import.loading")}
          </div>
        )}

        {preview && (
          prepared ? (
            <ImportPreviewPanel
              prepared={prepared}
              preview={preview}
              conflictMode={conflictMode}
              previewFilter={previewFilter}
              skippedIndexes={skippedIndexes}
              wallosUsers={wallosUsers}
              selectedWallosUser={selectedWallosUser}
              assetProgress={assetProgress}
              applyProgress={applyProgress}
              onConflictModeChange={handleConflictModeChange}
              onWallosUserChange={(value) => void handleWallosUserChange(value)}
              onPreviewFilterChange={setPreviewFilter}
              onLogoChange={handleLogoChange}
              onSkipChange={handleSkipChange}
            />
          ) : null
        )}
      </div>

      <DialogFooter className="shrink-0 border-t border-border bg-card px-4 py-4 sm:px-6">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
        <Button type="button" onClick={() => void handleApply()} disabled={!preview || preview.summary.errors > 0 || applying}>
          {applying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
          {t("import.apply")}
        </Button>
      </DialogFooter>
    </>
  );
}
