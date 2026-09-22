import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Check, Filter, Search } from "lucide-react";

import { SubscriptionFilterPopoverFrame } from "@/components/subscription-filter-popover-frame";
import { subscriptionFilterLayout } from "@/components/subscription-filter-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MobileBottomDrawerContent, MobileDrawerRoot, MobileDrawerTrigger } from "@/components/ui/mobile-drawer";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/i18n/I18nProvider";
import { colorWithAlpha } from "@/lib/color";
import { cn } from "@/lib/utils";
import type { ConfigItem } from "@/types/config";
import type { Category } from "@/types/subscription";

interface SubscriptionCategoryFilterProps {
  categories: ConfigItem[];
  selectedCategories: Category[];
  onToggleCategory: (category: Category) => void;
  onClearCategories: () => void;
  onApply: (categories: Category[]) => void;
  mode: "popover" | "drawer";
  className?: string;
}

interface CategoryFilterOption {
  value: Category;
  label: string;
  color?: string | undefined;
}

interface CategoryCheckboxChipProps {
  option: CategoryFilterOption;
  selected: boolean;
  onToggle: () => void;
  className?: string;
}

function toggleCategoryValue(categories: Category[], category: Category) {
  return categories.includes(category)
    ? categories.filter((item) => item !== category)
    : [...categories, category];
}

function selectedCategoryStyle(color?: string): CSSProperties | undefined {
  if (!color) return undefined;
  // 分类色来自用户配置，只参与轻量强调；透明度固定，避免自定义高饱和色压过状态语义色。
  return {
    backgroundColor: colorWithAlpha(color, 0.12) ?? undefined,
    borderColor: colorWithAlpha(color, 0.35) ?? undefined,
    color,
  };
}

function CategoryCheckboxChip({ option, selected, onToggle, className }: CategoryCheckboxChipProps) {
  const selectedStyle = selected ? selectedCategoryStyle(option.color) : undefined;

  return (
    <label
      className={cn(
        "inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-sm font-semibold transition-colors",
        "focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background",
        selected
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-foreground hover:border-primary/50 hover:bg-secondary/70",
        className,
      )}
      style={selectedStyle}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="sr-only"
      />
      <span className="max-w-40 truncate">{option.label}</span>
      {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
    </label>
  );
}

export function SubscriptionCategoryFilter({
  categories,
  selectedCategories,
  onToggleCategory,
  onClearCategories,
  onApply,
  mode,
  className,
}: SubscriptionCategoryFilterProps) {
  const { t, label } = useI18n();
  const [open, setOpen] = useState(false);
  const [draftCategories, setDraftCategories] = useState<Category[]>(selectedCategories);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setSearchQuery("");
      return;
    }

    if (mode === "drawer") {
      // 移动端抽屉先编辑草稿，点击“应用”后再提交，防止用户滑动筛选时列表在背后频繁重排。
      setDraftCategories(selectedCategories);
      setSearchQuery("");
    }
  }, [mode, open, selectedCategories]);

  const options = useMemo<CategoryFilterOption[]>(() => (
    categories.map((category) => ({
      value: category.value as Category,
      label: label(category.labels),
      color: category.color,
    }))
  ), [categories, label]);
  const selectedOptionLabels = useMemo(() => {
    const optionByValue = new Map(options.map((option) => [option.value, option.label]));
    return selectedCategories.map((category) => optionByValue.get(category) ?? category);
  }, [options, selectedCategories]);
  const triggerLabel =
    selectedCategories.length === 0
      ? t("subscriptions.category.open")
      : selectedCategories.length === 1
        ? selectedOptionLabels[0] ?? selectedCategories[0] ?? t("subscriptions.category.open")
        : t("subscriptions.category.selectedCount", { count: selectedCategories.length });
  const activeCategories = mode === "drawer" ? draftCategories : selectedCategories;
  const visibleOptions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    // 搜索只按本地化标签匹配，category value 是持久化 key，不应该暴露给普通筛选用户。
    if (!query) return options;
    return options.filter((option) => option.label.toLowerCase().includes(query));
  }, [options, searchQuery]);
  const canClearCategories = selectedCategories.length > 0 || draftCategories.length > 0;

  const optionGrid = (
    <div aria-label={t("subscriptions.category.drawerTitle")} className="flex flex-wrap gap-2">
      {visibleOptions.map((option) => (
        <CategoryCheckboxChip
          key={option.value}
          option={option}
          selected={activeCategories.includes(option.value)}
          onToggle={
            mode === "drawer"
              ? () => setDraftCategories((current) => toggleCategoryValue(current, option.value))
              : () => onToggleCategory(option.value)
          }
          {...(mode === "drawer" ? { className: "min-h-11" } : {})}
        />
      ))}
    </div>
  );

  if (mode === "drawer") {
    return (
      <MobileDrawerRoot open={open} onOpenChange={setOpen} shouldScaleBackground={false}>
        <div className={cn("min-w-0", className)} data-testid="mobile-category-filter">
          <MobileDrawerTrigger asChild>
            <Button variant="outline" className="h-11 w-full min-w-0 justify-start border-border bg-secondary px-3">
              <Filter className="h-4 w-4" />
              <span className="truncate">{triggerLabel}</span>
            </Button>
          </MobileDrawerTrigger>
        </div>

        {open && (
          <MobileBottomDrawerContent
            title={t("subscriptions.category.drawerTitle")}
            description={t("subscriptions.category.drawerTitle")}
            descriptionMode="sr-only"
            closeLabel={t("common.close")}
            bodyClassName={null}
          >
            <div className="px-5 pb-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t("subscriptions.category.searchPlaceholder")}
                  className="h-11 border-border bg-secondary pl-10"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
              {visibleOptions.length > 0 ? optionGrid : (
                <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border bg-secondary/40 px-4 text-center text-sm text-muted-foreground">
                  {t("subscriptions.category.emptyMatch")}
                </div>
              )}
            </div>

            <div className="flex gap-3 border-t border-border bg-card px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              {canClearCategories && (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 shrink-0 text-muted-foreground"
                  onClick={() => {
                    onApply([]);
                    setOpen(false);
                  }}
                >
                  {t("subscriptions.category.clearSelection")}
                </Button>
              )}
              <Button
                type="button"
                className="h-11 flex-1 bg-primary text-primary-foreground hover:bg-primary-glow"
                onClick={() => {
                  onApply(draftCategories);
                  setOpen(false);
                }}
              >
                {t("subscriptions.category.apply")}
              </Button>
            </div>
          </MobileBottomDrawerContent>
        )}
      </MobileDrawerRoot>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("shrink-0", className)} data-testid="desktop-category-filter">
        <PopoverTrigger asChild>
          <Button variant="outline" className={subscriptionFilterLayout.desktopCategoryTrigger}>
            <Filter className="h-4 w-4" />
            <span className="truncate">{triggerLabel}</span>
          </Button>
        </PopoverTrigger>
      </div>

      {/* 桌面分类选择即时生效；H5 Drawer 保留草稿确认，避免小屏滑动筛选时背后列表频繁重排。 */}
      <SubscriptionFilterPopoverFrame
        title={t("subscriptions.category.drawerTitle")}
        closeLabel={t("common.close")}
        onClose={() => setOpen(false)}
        contentTestId="desktop-category-filter-popover"
        scrollTestId="desktop-category-filter-scroll"
        footerTestId="desktop-category-filter-footer"
        searchInput={(
          <>
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("subscriptions.category.searchPlaceholder")}
              className="h-10 border-border bg-secondary pl-10"
            />
          </>
        )}
        footer={
          selectedCategories.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              className="h-9 text-muted-foreground"
              onClick={onClearCategories}
            >
              {t("subscriptions.category.clearSelection")}
            </Button>
          ) : undefined
        }
      >
        {visibleOptions.length > 0 ? optionGrid : (
          <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border bg-secondary/40 px-4 text-center text-sm text-muted-foreground">
            {t("subscriptions.category.emptyMatch")}
          </div>
        )}
      </SubscriptionFilterPopoverFrame>
    </Popover>
  );
}
