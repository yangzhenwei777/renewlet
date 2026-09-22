import {
  SelectedAdvancedFilterScroller,
  type SubscriptionAdvancedFilterOption,
} from "@/components/subscription-advanced-filter";
import { SelectedTagScroller } from "@/components/subscription-tag-filter-drawer";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import type { SubscriptionAdvancedFilterState } from "@/modules/subscriptions/domain/subscription-filters";
import type { BillingCycle } from "@/types/subscription";

interface SubscriptionFilterFeedbackProps {
  selectedTags: string[];
  onRemoveTag: (tag: string) => void;
  filters: SubscriptionAdvancedFilterState;
  onChangeAdvancedFilters: (filters: SubscriptionAdvancedFilterState) => void;
  billingCycleOptions: Array<SubscriptionAdvancedFilterOption<BillingCycle>>;
  paymentMethodOptions: SubscriptionAdvancedFilterOption[];
  currencyOptions: SubscriptionAdvancedFilterOption[];
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  tagTestId: string;
  advancedTestId: string;
  testId: string;
  className?: string;
}

export function SubscriptionFilterFeedback({
  selectedTags,
  onRemoveTag,
  filters,
  onChangeAdvancedFilters,
  billingCycleOptions,
  paymentMethodOptions,
  currencyOptions,
  hasActiveFilters,
  onClearFilters,
  tagTestId,
  advancedTestId,
  testId,
  className,
}: SubscriptionFilterFeedbackProps) {
  const { t } = useI18n();

  if (!hasActiveFilters) return null;

  return (
    <div data-testid={testId} className={cn("flex min-w-0 items-start gap-3", className)}>
      <div className="grid min-w-0 flex-1 gap-2">
        <SelectedTagScroller selectedTags={selectedTags} onRemoveTag={onRemoveTag} testId={tagTestId} />
        <SelectedAdvancedFilterScroller
          filters={filters}
          onChange={onChangeAdvancedFilters}
          billingCycleOptions={billingCycleOptions}
          paymentMethodOptions={paymentMethodOptions}
          currencyOptions={currencyOptions}
          testId={advancedTestId}
        />
      </div>
      {/* 清除入口属于已应用筛选反馈区；放回主工具条会在条件出现/消失时重新分配控件宽度。 */}
      <Button variant="ghost" size="sm" onClick={onClearFilters} className="shrink-0 text-muted-foreground">
        {t("subscriptions.clearFilters")}
      </Button>
    </div>
  );
}
