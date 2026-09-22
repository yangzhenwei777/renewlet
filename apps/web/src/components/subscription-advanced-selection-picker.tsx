import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { AdvancedOptionList } from "@/components/subscription-advanced-option-list";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/I18nProvider";
import type { SubscriptionAdvancedFilterOption } from "@/modules/subscriptions/domain/subscription-advanced-filter-options";

type AdvancedOptionPickerLayout = "desktop" | "mobile";

export interface AdvancedOptionPickerBodyProps<T extends string = string> {
  options: Array<SubscriptionAdvancedFilterOption<T>>;
  selectedValues: T[];
  onChange: (values: T[]) => void;
  layout: AdvancedOptionPickerLayout;
  searchPlaceholder: string;
  emptyMessage: string;
  searchResultsLabel: string;
  allOptionsLabel: string;
  alwaysShowSearch?: boolean;
  searchThreshold?: number;
  testId: string;
}

interface AdvancedSelectionEntryProps {
  title: string;
  summary: string;
  preview?: string | undefined;
  onOpen: () => void;
  testId: string;
}

interface AdvancedOptionSelectionDialogProps<T extends string = string> extends Omit<AdvancedOptionPickerBodyProps<T>, "selectedValues" | "onChange" | "layout" | "testId"> {
  layout?: AdvancedOptionPickerLayout;
  open: boolean;
  title: string;
  selectedValues: T[];
  onOpenChange: (open: boolean) => void;
  onApply: (values: T[]) => void;
  pickerTestId: string;
  testId: string;
}

interface AdvancedFilterGroupDialogProps<T> {
  layout?: AdvancedOptionPickerLayout;
  open: boolean;
  title: string;
  value: T;
  onOpenChange: (open: boolean) => void;
  onApply: (value: T) => void;
  isActive: (value: T) => boolean;
  clearValue: (value: T) => T;
  children: (value: T, onChange: (value: T) => void) => ReactNode;
  testId: string;
}

export function AdvancedOptionPickerBody<T extends string = string>({
  options,
  selectedValues,
  onChange,
  layout,
  searchPlaceholder,
  emptyMessage,
  searchResultsLabel,
  allOptionsLabel,
  alwaysShowSearch = false,
  searchThreshold = 12,
  testId,
}: AdvancedOptionPickerBodyProps<T>) {
  return (
    <AdvancedOptionList
      options={options}
      selectedValues={selectedValues}
      onChange={onChange}
      layout={layout}
      searchPlaceholder={searchPlaceholder}
      searchResultsLabel={searchResultsLabel}
      allOptionsLabel={allOptionsLabel}
      emptyMessage={emptyMessage}
      alwaysShowSearch={alwaysShowSearch}
      searchThreshold={searchThreshold}
      testId={testId}
    />
  );
}

export function AdvancedSelectionEntry({
  title,
  summary,
  preview,
  onOpen,
  testId,
}: AdvancedSelectionEntryProps) {
  // 摘要预览在弹窗外可见，也要进入可访问名称，键盘用户无需打开弹窗才能确认已选内容。
  const accessibleLabel = preview ? `${title} ${summary} ${preview}` : `${title} ${summary}`;

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={accessibleLabel}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-3 text-left transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      onClick={onOpen}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center justify-between gap-3">
          <span className="truncate text-sm font-semibold text-foreground">{title}</span>
          <span className="max-w-44 shrink-0 truncate text-right text-xs text-muted-foreground">{summary}</span>
        </span>
        {preview ? (
          <span
            data-testid={`${testId}-preview`}
            className="mt-1 block line-clamp-2 text-xs leading-5 text-muted-foreground"
          >
            {preview}
          </span>
        ) : null}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

export function AdvancedFilterGroupDialog<T>({
  layout = "desktop",
  open,
  title,
  value,
  onOpenChange,
  onApply,
  isActive,
  clearValue,
  children,
  testId,
}: AdvancedFilterGroupDialogProps<T>) {
  const { t } = useI18n();
  const [draftValue, setDraftValue] = useState(value);
  const draftActive = isActive(draftValue);
  const mobile = layout === "mobile";

  useEffect(() => {
    if (!open) return;
    setDraftValue(value);
  }, [open, value]);

  const handleApply = () => {
    onApply(draftValue);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          dismissMode="explicit"
          layout="frame"
          closeLabel={t("common.close")}
          overlayClassName="z-90 bg-black/60"
          className={mobile
            ? "z-100 h-(--app-viewport-height) max-h-(--app-viewport-height) w-full max-w-none gap-0 overflow-hidden rounded-none border-0 bg-card p-0"
            : "z-100 h-[min(calc(var(--app-viewport-height)-2rem),40rem)] max-h-[min(calc(var(--app-viewport-height)-2rem),40rem)] max-w-2xl gap-0 overflow-hidden border-border bg-card p-0"}
          data-testid={testId}
        >
          <DialogHeader className={mobile
            ? "shrink-0 border-b border-border px-5 pb-3 pr-14 pt-[calc(1rem+env(safe-area-inset-top))] text-left"
            : "shrink-0 border-b border-border px-5 py-4 pr-12 text-left"}
          >
            <DialogTitle className="text-base font-semibold text-foreground">{title}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("subscriptions.advanced.panelDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid={`${testId}-body`}>
            {children(draftValue, setDraftValue)}
          </div>

          <DialogFooter className={mobile
            ? "shrink-0 flex-row items-center justify-end border-t border-border bg-card px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
            : "shrink-0 border-t border-border bg-card px-5 py-4"}
          >
            <Button
              type="button"
              variant="ghost"
              className={mobile ? "mr-auto h-11 text-muted-foreground" : "h-10 text-muted-foreground"}
              disabled={!draftActive}
              onClick={() => setDraftValue((currentValue) => clearValue(currentValue))}
            >
              {t("subscriptions.advanced.clearGroup")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={mobile ? "h-11 border-border px-5" : "h-10 border-border"}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              className={mobile ? "h-11 bg-primary px-5 text-primary-foreground hover:bg-primary-glow" : "h-10 bg-primary text-primary-foreground hover:bg-primary-glow"}
              onClick={handleApply}
            >
              {t("subscriptions.advanced.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export function AdvancedOptionSelectionDialog<T extends string = string>({
  layout = "desktop",
  open,
  title,
  selectedValues,
  onOpenChange,
  onApply,
  pickerTestId,
  testId,
  ...pickerProps
}: AdvancedOptionSelectionDialogProps<T>) {
  const { t } = useI18n();
  const [draftValues, setDraftValues] = useState<T[]>(selectedValues);
  const draftActive = draftValues.length > 0;
  const mobile = layout === "mobile";

  useEffect(() => {
    if (!open) return;
    // 分组弹窗有自己的临时草稿；完成只写回父级高级筛选草稿，最终筛选仍由主面板“确定”统一提交。
    setDraftValues(selectedValues);
  }, [open, selectedValues]);

  const handleApply = () => {
    onApply(draftValues);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        // 桌面分组弹窗叠在右侧 Drawer 之上；z-index 与高级筛选面板 z-80 成对维护。
        <DialogContent
          dismissMode="explicit"
          layout="frame"
          closeLabel={t("common.close")}
          overlayClassName="z-90 bg-black/60"
          className={mobile
            ? "z-100 h-(--app-viewport-height) max-h-(--app-viewport-height) w-full max-w-none gap-0 overflow-hidden rounded-none border-0 bg-card p-0"
            : "z-100 h-[min(calc(var(--app-viewport-height)-2rem),40rem)] max-h-[min(calc(var(--app-viewport-height)-2rem),40rem)] max-w-2xl gap-0 overflow-hidden border-border bg-card p-0"}
          data-testid={testId}
        >
          <DialogHeader className={mobile
            ? "shrink-0 border-b border-border px-5 pb-3 pr-14 pt-[calc(1rem+env(safe-area-inset-top))] text-left"
            : "shrink-0 border-b border-border px-5 py-4 pr-12 text-left"}
          >
            <DialogTitle className="text-base font-semibold text-foreground">{title}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("subscriptions.advanced.panelDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-hidden">
            <AdvancedOptionPickerBody
              {...pickerProps}
              selectedValues={draftValues}
              onChange={setDraftValues}
              layout={layout}
              testId={pickerTestId}
            />
          </div>

          <DialogFooter className={mobile
            ? "shrink-0 flex-row items-center justify-end border-t border-border bg-card px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
            : "shrink-0 border-t border-border bg-card px-5 py-4"}
          >
            <Button
              type="button"
              variant="ghost"
              className={mobile ? "mr-auto h-11 text-muted-foreground" : "h-10 text-muted-foreground"}
              disabled={!draftActive}
              onClick={() => setDraftValues([])}
            >
              {t("subscriptions.advanced.clearGroup")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={mobile ? "h-11 border-border px-5" : "h-10 border-border"}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              className={mobile ? "h-11 bg-primary px-5 text-primary-foreground hover:bg-primary-glow" : "h-10 bg-primary text-primary-foreground hover:bg-primary-glow"}
              onClick={handleApply}
            >
              {t("subscriptions.advanced.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
