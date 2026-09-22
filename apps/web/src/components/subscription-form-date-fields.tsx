import { DateOnlyPickerField } from "@/components/date-only-picker-field";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/I18nProvider";
import { getSubscriptionDateValidationKind } from "@/lib/subscription-form";
import { cn } from "@/lib/utils";
import type { SubscriptionFormErrors, SubscriptionFormFieldUpdater } from "@/components/subscription-form-fields-model";
import type { SubscriptionFormState } from "@/types/subscription-form";

interface SubscriptionFormDateFieldsProps {
  id: (name: string) => string;
  formData: SubscriptionFormState;
  update: SubscriptionFormFieldUpdater;
  errors: SubscriptionFormErrors;
}

export function SubscriptionFormDateFields({ id, formData, update, errors }: SubscriptionFormDateFieldsProps) {
  const { t } = useI18n();
  const startDateId = id("startDate");
  const startDateLabelId = id("startDate-label");
  const startDateValueId = id("startDate-value");
  const startDateHelpId = id("startDate-help");
  const nextBillingDateId = id("nextBillingDate");
  const nextBillingDateLabelId = id("nextBillingDate-label");
  const nextBillingDateValueId = id("nextBillingDate-value");
  const nextBillingDateHelpId = id("nextBillingDate-help");
  const startDateErrorId = id("startDate-error");
  const nextBillingDateErrorId = id("nextBillingDate-error");
  // 当非法到期日被清空后，打开到期日历应落在开始日所在月份，让下一个合法选择直接可见。
  const nextBillingDateCalendarMonth = formData.nextBillingDate ?? formData.startDate;
  const isNextBillingDateDisabled = formData.autoCalculate || formData.billingCycle === "one-time";
  const isOneTimeBuyout = formData.billingCycle === "one-time" && formData.oneTimeMode === "buyout";
  const showAutoCalculate = formData.billingCycle !== "one-time";
  const isRecurringStartDateOptional = formData.billingCycle !== "one-time" && !formData.autoCalculate;
  const requiredStartDateLabel = formData.billingCycle === "one-time"
    ? t("subscription.field.purchaseDate")
    : t("subscription.field.startDate");
  const startDateLabel = isRecurringStartDateOptional
    ? t("subscription.field.startDateOptional")
    : requiredStartDateLabel;
  const nextBillingDateLabel = formData.billingCycle === "one-time"
    ? t("subscription.field.expiryDate")
    : t("subscription.field.nextBillingDate");
  const dateValidationKind = errors.dates ? getSubscriptionDateValidationKind(formData) : null;
  const dateErrorTarget: "start" | "next" | null =
    dateValidationKind === "purchaseDateRequired" || dateValidationKind === "startDateRequiredForAutoCalculate"
      ? "start"
      : dateValidationKind === "nextBillingDateRequired" || dateValidationKind === "dateOrderInvalid"
        ? "next"
        : errors.dates && isNextBillingDateDisabled
          ? "start"
          : errors.dates
            ? "next"
            : null;
  const startDateHasError = dateErrorTarget === "start";
  const nextBillingDateHasError = dateErrorTarget === "next";
  const nextBillingDateHelp =
    formData.billingCycle === "one-time" && formData.oneTimeMode === "term"
      ? t("subscription.oneTimeTermDateHelp")
      : formData.autoCalculate
        ? t("subscription.autoCalculateHelp")
        : null;
  return (
    <div className="grid gap-4 rounded-lg border border-border bg-secondary/30 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Label className="text-base font-medium">{t("subscription.section.dates")}</Label>
        {showAutoCalculate ? (
          <div className="flex items-center gap-2">
            <Label htmlFor={id("autoCalculate")} className="text-sm text-muted-foreground cursor-pointer">
              {t("subscription.autoCalculate")}
            </Label>
            <Switch
              id={id("autoCalculate")}
              checked={formData.autoCalculate}
              onCheckedChange={(checked) => update("autoCalculate", checked)}
            />
          </div>
        ) : null}
      </div>

      <FormFieldRow
        alignAt="sm"
        rowClassName={cn(!isOneTimeBuyout && "sm:grid-cols-2")}
        errors={[
          { id: startDateErrorId, message: startDateHasError ? errors.dates : undefined },
          { id: nextBillingDateErrorId, message: nextBillingDateHasError ? errors.dates : undefined },
        ]}
      >
        <FormField
          id={startDateId}
          label={startDateLabel}
          labelId={startDateLabelId}
          description={isOneTimeBuyout ? t("subscription.oneTimeBuyoutDateHelp") : undefined}
          descriptionId={startDateHelpId}
          error={startDateHasError ? errors.dates : undefined}
          errorId={startDateErrorId}
          renderError={false}
        >
          {(field) => (
            <DateOnlyPickerField
              id={field.id}
              labelId={startDateLabelId}
              valueId={startDateValueId}
              value={formData.startDate}
              onChange={(value) => update("startDate", value)}
              placeholder={t("subscription.placeholder.date")}
              invalid={field.invalid}
              describedBy={field.describedBy}
            />
          )}
        </FormField>

        {!isOneTimeBuyout ? (
          <FormField
            id={nextBillingDateId}
            label={nextBillingDateLabel}
            labelId={nextBillingDateLabelId}
            description={nextBillingDateHelp}
            descriptionId={nextBillingDateHelpId}
            error={nextBillingDateHasError ? errors.dates : undefined}
            errorId={nextBillingDateErrorId}
            renderError={false}
          >
            {(field) => (
              <DateOnlyPickerField
                id={field.id}
                labelId={nextBillingDateLabelId}
                valueId={nextBillingDateValueId}
                value={formData.nextBillingDate}
                onChange={(value) => update("nextBillingDate", value)}
                placeholder={t("subscription.placeholder.date")}
                invalid={field.invalid}
                describedBy={field.describedBy}
                disabled={isNextBillingDateDisabled}
                {...(formData.startDate ? { minDate: formData.startDate } : {})}
                {...(nextBillingDateCalendarMonth ? { defaultMonth: nextBillingDateCalendarMonth } : {})}
              />
            )}
          </FormField>
        ) : null}
      </FormFieldRow>
    </div>
  );
}
