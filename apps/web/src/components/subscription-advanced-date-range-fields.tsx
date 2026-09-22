import { DateOnlyPickerField } from "@/components/date-only-picker-field";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/I18nProvider";
import type { SubscriptionAdvancedFilterState } from "@/modules/subscriptions/domain/subscription-filters";

export interface SubscriptionAdvancedDateRangeFieldsProps {
  filters: SubscriptionAdvancedFilterState;
  onChange: (patch: Partial<SubscriptionAdvancedFilterState>) => void;
  mobile: boolean;
}

export function SubscriptionAdvancedDateRangeFields({
  filters,
  onChange,
  mobile,
}: SubscriptionAdvancedDateRangeFieldsProps) {
  const { t } = useI18n();
  const size = mobile ? "large" : "default";

  // 日期按钮只更新高级筛选草稿，最终提交仍由外层“确定”统一触发。
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label id="advanced-next-billing-from-label" htmlFor="advanced-next-billing-from" className="text-xs font-medium text-muted-foreground">
          {t("subscriptions.advanced.nextBillingFrom")}
        </Label>
        <DateOnlyPickerField
          id="advanced-next-billing-from"
          labelId="advanced-next-billing-from-label"
          valueId="advanced-next-billing-from-value"
          value={filters.nextBillingFrom}
          onChange={(value) => onChange({ nextBillingFrom: value ?? "" })}
          placeholder={t("subscription.placeholder.date")}
          displayStyle="short"
          {...(filters.nextBillingTo ? { maxDate: filters.nextBillingTo, defaultMonth: filters.nextBillingTo } : {})}
          clearable
          clearLabel={t("subscriptions.advanced.clearNextBillingFrom")}
          size={size}
          testId="advanced-next-billing-from-picker"
        />
      </div>
      <div className="space-y-1.5">
        <Label id="advanced-next-billing-to-label" htmlFor="advanced-next-billing-to" className="text-xs font-medium text-muted-foreground">
          {t("subscriptions.advanced.nextBillingTo")}
        </Label>
        <DateOnlyPickerField
          id="advanced-next-billing-to"
          labelId="advanced-next-billing-to-label"
          valueId="advanced-next-billing-to-value"
          value={filters.nextBillingTo}
          onChange={(value) => onChange({ nextBillingTo: value ?? "" })}
          placeholder={t("subscription.placeholder.date")}
          displayStyle="short"
          {...(filters.nextBillingFrom ? { minDate: filters.nextBillingFrom, defaultMonth: filters.nextBillingFrom } : {})}
          clearable
          clearLabel={t("subscriptions.advanced.clearNextBillingTo")}
          size={size}
          testId="advanced-next-billing-to-picker"
        />
      </div>
    </div>
  );
}
