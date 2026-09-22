import type { DragEvent, RefObject } from "react";
import { Archive, CheckCircle2, FileJson, Loader2, Upload, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ImportFileDropZoneProps {
  file: File | null;
  dragActive: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  uploadButtonRef: RefObject<HTMLButtonElement | null>;
  onFileSelected: (file: File | null) => void;
  onFileDrop: (event: DragEvent<HTMLButtonElement>) => void;
  onDragActiveChange: (active: boolean) => void;
  chooseFileLabel: string;
  fileEmptyLabel: string;
  fileHintLabel: string;
}

// 文件入口同时承接 Renewlet 备份 ZIP 与 Wallos 源文件，accept 只做浏览器提示，真实校验仍在导入解析层。
export function ImportFileDropZone({
  file,
  dragActive,
  fileInputRef,
  uploadButtonRef,
  onFileSelected,
  onFileDrop,
  onDragActiveChange,
  chooseFileLabel,
  fileEmptyLabel,
  fileHintLabel,
}: ImportFileDropZoneProps) {
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".json,.zip,.db,.sqlite,application/json,application/zip"
        onChange={(event) => onFileSelected(event.target.files?.[0] ?? null)}
      />
      <button
        ref={uploadButtonRef}
        type="button"
        className={cn(
          "group grid w-full gap-4 rounded-lg border border-dashed border-border bg-secondary/30 p-4 text-left transition-colors hover:border-primary/50 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center",
          dragActive && "border-primary bg-secondary/60",
        )}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          onDragActiveChange(true);
        }}
        onDragLeave={() => onDragActiveChange(false)}
        onDrop={onFileDrop}
        aria-label={chooseFileLabel}
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-background text-primary transition-colors group-hover:border-primary/40">
          <UploadCloud className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground" title={file?.name}>
            {file?.name ?? fileEmptyLabel}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {file ? formatFileSize(file.size) : fileHintLabel}
          </span>
          <span className="mt-3 flex flex-wrap gap-1.5">
            {["Renewlet ZIP", "Wallos JSON", "backup.zip", "wallos.db"].map((item) => (
              <span key={item} className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {item}
              </span>
            ))}
          </span>
        </span>
        <span className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors group-hover:border-primary/40">
          <Upload className="mr-2 h-4 w-4" />
          {chooseFileLabel}
        </span>
      </button>
    </>
  );
}

interface ImportPastePanelProps {
  value: string;
  parsing: boolean;
  onChange: (value: string) => void;
  onPreview: () => void;
  placeholder: string;
  previewLabel: string;
}

export function ImportPastePanel({ value, parsing, onChange, onPreview, placeholder, previewLabel }: ImportPastePanelProps) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        // 粘贴入口面向 JSON/SQLite 文本排障，保留等宽字体但不在这里解析，避免输入中途产生昂贵副作用。
        className="min-h-40 resize-y border-border bg-background font-mono text-xs"
      />
      <div className="mt-3 flex justify-end">
        <Button type="button" variant="outline" onClick={onPreview} disabled={!value.trim() || parsing}>
          {parsing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileJson className="mr-2 h-4 w-4" />}
          {previewLabel}
        </Button>
      </div>
    </div>
  );
}

// 导入弹层的步骤状态由上层状态机传入，这里只负责紧凑展示，避免 UI 组件自行推断流程阶段。
export function ImportStep({ active, done, label }: { active: boolean; done?: boolean; label: string }) {
  return (
    <div className={cn(
      "flex items-center justify-center gap-1.5 border-r border-border px-2 py-2 text-muted-foreground last:border-r-0",
      active && "bg-secondary text-foreground",
    )}>
      {done ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />}
      <span className="truncate">{label}</span>
    </div>
  );
}

export function SummaryBadge({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <div className={cn("text-lg font-semibold text-foreground", danger && "text-destructive")}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
