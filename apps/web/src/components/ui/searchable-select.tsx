/**
 * 可搜索选择器。
 *
 * 架构位置：组合 Popover + cmdk + Tooltip，服务自定义配置、货币、分类等长选项列表。
 *
 * 注意： 选项 label 可能来自用户自定义配置；渲染层只展示文本，不在这里修复配置结构。
 */
import * as React from "react";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TruncatedTooltipText } from "@/components/ui/truncated-tooltip-text";
import { cn } from "@/lib/utils";
import { matchesSearchableOption, type SearchableSelectOption } from "@/lib/searchable-options";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";

export type { SearchableSelectOption };

interface SearchableSelectProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  renderOption?: (option: SearchableSelectOption, state: { selected: boolean }) => React.ReactNode;
  renderValue?: (option: SearchableSelectOption | undefined) => React.ReactNode;
  /** 未输入搜索词前最多渲染的选项数量；长货币/时区列表依赖它控制首屏开销。 */
  initialRenderLimit?: number;
  "aria-label"?: string;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling" | undefined;
}

const DEFAULT_INITIAL_RENDER_LIMIT = 100;

export function SearchableSelect({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  disabled = false,
  className,
  contentClassName,
  renderOption,
  renderValue,
  initialRenderLimit = DEFAULT_INITIAL_RENDER_LIMIT,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const selectedIndex = React.useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const locale = getApiLocale();
  const resolvedPlaceholder = placeholder ?? translate(locale, "common.selectPlaceholder");
  const resolvedSearchPlaceholder = searchPlaceholder ?? translate(locale, "common.searchPlaceholder");
  const resolvedEmptyMessage = emptyMessage ?? translate(locale, "common.noMatches");
  const visibleOptions = React.useMemo(() => {
    const trimmedSearch = search.trim();
    if (trimmedSearch) {
      // 搜索只过滤候选项，不能让 cmdk 的评分排序覆盖调用方传入的业务顺序。
      return options.filter((option) => matchesSearchableOption(option, trimmedSearch));
    }
    if (initialRenderLimit <= 0 || options.length <= initialRenderLimit) {
      return options;
    }

    const visibleLimit = selectedIndex >= initialRenderLimit ? selectedIndex + 1 : initialRenderLimit;
    // 长列表首屏限量只是性能优化；货币等业务选择器的顺序必须继续完全服从调用方传入顺序。
    return options.slice(0, visibleLimit);
  }, [initialRenderLimit, options, search, selectedIndex]);

  React.useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          disabled={disabled}
          className={cn(
            "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm font-normal ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            !selectedOption && "text-muted-foreground",
            className,
          )}
        >
          {renderValue ? (
            <span className="min-w-0 flex-1 truncate text-left">{renderValue(selectedOption)}</span>
          ) : (
            <TruncatedTooltipText
              text={selectedOption?.label ?? resolvedPlaceholder}
              className="min-w-0 flex-1 text-left"
            />
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={ariaLabel ?? resolvedPlaceholder}
        data-testid="searchable-select-sheet"
        mobileDetent="large"
        mobileHeaderLayout="flush"
        mobileKind="list"
        mobileTitle={ariaLabel ?? resolvedPlaceholder}
        mobileCloseLabel={translate(locale, "common.close")}
        className={cn(
          "w-(--radix-popover-trigger-width) min-w-56 overflow-hidden border-border bg-popover p-0 text-popover-foreground",
          contentClassName,
        )}
      >
        <Command
          loop
          shouldFilter={false}
          className="h5-mobile-searchable-select-command flex max-h-88 w-full flex-col bg-popover text-popover-foreground"
        >
          <div className="flex items-center border-b border-border px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder={resolvedSearchPlaceholder}
              className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <Command.List className="h5-mobile-searchable-select-list max-h-72 overflow-y-auto p-1">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              {resolvedEmptyMessage}
            </Command.Empty>
            {visibleOptions.map((option) => {
              const selected = option.value === value;
              return (
                <Command.Item
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, ...(option.keywords ?? [])]}
                  {...(option.disabled ? { disabled: true } : {})}
                  onSelect={() => {
                    if (option.disabled) return;
                    onValueChange(option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "relative flex cursor-default select-none items-center rounded-sm py-2 pl-8 pr-2 text-sm outline-none transition-colors",
                    "h5-mobile-option-item h5-mobile-option-item-leading",
                    "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                    "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
                  )}
                >
                  <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                    {selected && <Check className="h-4 w-4" />}
                  </span>
                  {renderOption ? (
                    <span className="min-w-0 flex-1 truncate">{renderOption(option, { selected })}</span>
                  ) : (
                    <TruncatedTooltipText text={option.label} className="min-w-0 flex-1" />
                  )}
                </Command.Item>
              );
            })}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
