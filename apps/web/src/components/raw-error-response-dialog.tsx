import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/I18nProvider";
import { formatRawErrorResponseText, type RawErrorResponseDetails } from "@/lib/raw-error-response";
import { copyTextToClipboard } from "@/shared/browser/clipboard";

interface RawErrorResponseDialogProps {
  open: boolean;
  details: RawErrorResponseDetails | null;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  testId?: string;
}

type CopyState = "idle" | "copied" | "failed";

// 通用 raw response 弹窗只做当前会话排障展示；调用方负责保证内容已脱敏且不会被持久化。
export function RawErrorResponseDialog({
  open,
  details,
  onOpenChange,
  title,
  description,
  testId = "raw-error-response-dialog",
}: RawErrorResponseDialogProps) {
  const { t } = useI18n();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const responseTextRef = useRef<HTMLPreElement>(null);
  const responseText = details?.responseText || details?.message || "";
  const displayText = formatRawErrorResponseText(responseText);
  const summary = description ?? details?.message ?? t("rawErrorResponse.description");
  const showSummary = normalizedErrorText(summary) !== normalizedErrorText(displayText);
  const copyLabel = copyState === "copied"
    ? t("rawErrorResponse.copied")
    : copyState === "failed"
      ? t("rawErrorResponse.copyFailed")
      : t("rawErrorResponse.copy");

  useEffect(() => {
    // 弹窗关闭即清空复制状态，避免下一次错误详情继承“已复制”的过期反馈。
    if (!open) setCopyState("idle");
  }, [open, details]);

  async function handleCopy() {
    if (!displayText) return;
    const copyResult = await copyTextToClipboard(displayText, { target: responseTextRef.current });
    if (copyResult.ok) {
      setCopyState("copied");
      return;
    }
    setCopyState("failed");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        layout="frame"
        className="h-[min(calc(var(--app-viewport-height)-2rem),42rem)] max-h-[min(calc(var(--app-viewport-height)-2rem),42rem)] max-w-4xl gap-0 overflow-hidden border-border bg-card p-0"
        closeLabel={t("common.close")}
      >
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-12 text-left">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 text-destructive">
              <AlertTriangle className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base leading-6">{title ?? t("rawErrorResponse.title")}</DialogTitle>
              <DialogDescription className={showSummary ? "mt-1 wrap-break-word text-xs leading-5" : "sr-only"}>
                {showSummary ? summary : t("rawErrorResponse.description")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3" data-testid={testId}>
          <pre
            ref={responseTextRef}
            tabIndex={-1}
            className={[
              "min-h-0 flex-1 overflow-auto rounded-md border border-border bg-secondary/30 p-3 font-mono text-xs leading-5 whitespace-pre-wrap wrap-break-word",
              displayText ? "text-foreground" : "text-muted-foreground",
            ].join(" ")}
          >
            {displayText || t("rawErrorResponse.responseUnavailable")}
          </pre>
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-border"
            disabled={!displayText}
            onClick={() => void handleCopy()}
          >
            {copyState === "copied" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copyLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function normalizedErrorText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
