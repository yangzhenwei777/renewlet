import { Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ImportPreviewList, type PreviewFilter } from "@/components/import-preview-list";
import type { DeferredLogoAsset } from "@/components/import-logo-editor";
import { SummaryBadge } from "@/components/import-data-dialog-parts";
import { ImportWallosSourceGuide } from "@/components/import-wallos-source-guide";
import { useI18n } from "@/i18n/I18nProvider";
import { formatImportMessage } from "@/modules/import-export/domain/import-message-format";
import type { WallosImportUser, PreparedImport } from "@/modules/import-export/domain/import-export-model";
import type { ImportConflictMode, ImportPreviewResponse } from "@/lib/api/schemas/import-export";

interface ImportPreviewPanelProps {
  prepared: PreparedImport;
  preview: ImportPreviewResponse;
  conflictMode: ImportConflictMode;
  previewFilter: PreviewFilter;
  skippedIndexes: ReadonlySet<number>;
  wallosUsers?: WallosImportUser[];
  selectedWallosUser?: string;
  assetProgress?: { done: number; total: number } | null;
  applyProgress?: { done: number; total: number } | null;
  showImportOptions?: boolean;
  onConflictModeChange: (value: ImportConflictMode) => void;
  onWallosUserChange?: (value: string) => void;
  onPreviewFilterChange: (value: PreviewFilter) => void;
  onLogoChange: (index: number, value: string | null, asset?: DeferredLogoAsset) => void;
  onSkipChange: (index: number, skipped: boolean) => void;
}

export function ImportPreviewPanel({
  prepared,
  preview,
  conflictMode,
  previewFilter,
  skippedIndexes,
  wallosUsers = [],
  selectedWallosUser,
  assetProgress,
  applyProgress,
  showImportOptions = true,
  onConflictModeChange,
  onWallosUserChange,
  onPreviewFilterChange,
  onLogoChange,
  onSkipChange,
}: ImportPreviewPanelProps) {
  const { t } = useI18n();
  const wallosUserSelection = wallosUsers.length > 1
    && selectedWallosUser !== undefined
    && selectedWallosUser.length > 0
    && onWallosUserChange !== undefined
    ? { value: selectedWallosUser, onValueChange: onWallosUserChange }
    : null;

  return (
    <section className="space-y-3" aria-label={t("import.previewTitle")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t("import.previewTitle")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("import.previewCount", { count: preview.summary.total })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={preview.summary.errors > 0 ? "destructive" : "secondary"}>
            {preview.summary.errors > 0 ? t("import.summaryError") : t("import.ready")}
          </Badge>
          {assetProgress && assetProgress.total > 0 ? (
            // Logo/图标资产是导入确认前的延迟上传任务，进度只展示本轮 apply 状态，不写回 preview。
            <Badge variant="outline">{t("import.assetProgress", assetProgress)}</Badge>
          ) : null}
          {applyProgress && applyProgress.total > 0 ? (
            <Badge variant="outline">{t("import.applyProgress", applyProgress)}</Badge>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <SummaryBadge label={t("import.summaryCreate")} value={preview.summary.creates} />
        <SummaryBadge label={t("import.summaryReplace")} value={preview.summary.replaces} />
        <SummaryBadge label={t("import.summarySkip")} value={preview.summary.skips} />
        <SummaryBadge label={t("import.summaryWarning")} value={preview.summary.warnings} />
        <SummaryBadge label={t("import.summaryError")} value={preview.summary.errors} danger={preview.summary.errors > 0} />
      </div>
      {showImportOptions ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/20 p-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              <p className="text-sm font-medium text-foreground">{t("import.optionsTitle")}</p>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("import.conflictDescription")}</p>
          </div>
          <FormFieldRow
            alignAt="md"
            className="min-w-0 md:shrink-0"
            rowClassName={wallosUserSelection ? "md:grid-cols-2" : undefined}
          >
            {wallosUserSelection ? (
              // Wallos 备份可能包含多个用户，切换用户必须回到预览层重算冲突，不能在列表里局部过滤。
              <FormField
                id="import-wallos-user"
                label={t("import.wallosUser")}
                labelClassName="text-xs font-medium text-muted-foreground"
              >
                {({ id }) => (
                  <Select
                    value={wallosUserSelection.value}
                    onValueChange={wallosUserSelection.onValueChange}
                  >
                    <SelectTrigger id={id} className="h-9 min-w-44 border-border bg-background">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {wallosUsers.map((user) => (
                        <SelectItem key={user.id} value={user.id}>{user.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            ) : null}
            <FormField
              id="import-conflict-mode"
              label={t("import.conflictMode")}
              labelClassName="text-xs font-medium text-muted-foreground"
            >
              {({ id }) => (
                <Select value={conflictMode} onValueChange={(value) => onConflictModeChange(value as ImportConflictMode)}>
                  <SelectTrigger id={id} className="h-9 min-w-44 border-border bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">{t("import.conflictSkip")}</SelectItem>
                    <SelectItem value="replace">{t("import.conflictReplace")}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </FormFieldRow>
        </div>
      ) : null}
      {prepared.payload.source === "wallos" ? <ImportWallosSourceGuide /> : null}
      <ImportPreviewList
        prepared={prepared}
        preview={preview}
        filter={previewFilter}
        skippedIndexes={skippedIndexes}
        onFilterChange={onPreviewFilterChange}
        onLogoChange={onLogoChange}
        onSkipChange={onSkipChange}
      />
      {prepared.warnings.length ? (
        <div className="rounded-lg border border-border bg-secondary/30 p-3 text-xs leading-5 text-muted-foreground">
          {prepared.warnings.slice(0, 6).map((warning, warningIndex) => <p key={`${warning}:${warningIndex}`}>{formatImportMessage(warning, t)}</p>)}
        </div>
      ) : null}
    </section>
  );
}
