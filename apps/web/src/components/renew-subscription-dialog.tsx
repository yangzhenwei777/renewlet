import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import { Loader2 } from "lucide-react";
import {
  createRenewSubscriptionLoadingSlots,
  RenewSubscriptionScaffold,
} from "@/components/renew-subscription-scaffold";
import { Button } from "@/components/ui/button";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { NumericInput } from "@/components/ui/numeric-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DateOnlyPickerField } from "@/components/date-only-picker-field";
import { useCustomConfigState } from "@/contexts/CustomConfigContext";
import { useI18n } from "@/i18n/I18nProvider";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import { useDeferredDialogInitialFocus } from "@/hooks/use-deferred-dialog-initial-focus";
import { compareDateOnly, type DateOnly } from "@/lib/time/date-only";
import { parseMoneyInput } from "@/lib/subscription-form";
import type { Subscription, SubscriptionCollectionItem } from "@/types/subscription";
import { advanceSubscriptionRenewal, calculateNextBillingDate } from "@renewlet/shared/subscription-renewal";
import type { SubscriptionRenewBody } from "@renewlet/shared/schemas/subscriptions";

type RenewMode = SubscriptionRenewBody["mode"];

interface RenewFormState {
  mode: RenewMode;
  price: string;
  currency: string;
  startDate: DateOnly | null;
  nextBillingDate: DateOnly;
  autoCalculateNextBillingDate: boolean;
}

interface RenewFormErrors {
  price?: string | undefined;
  currency?: string | undefined;
  startDate?: string | undefined;
  nextBillingDate?: string | undefined;
}

export interface RenewSubscriptionDialogProps {
  subscription: Subscription | null;
  loadingPreview: SubscriptionCollectionItem | null;
  open: boolean;
  today: DateOnly;
  submitting: boolean;
  error?: string | null | undefined;
  restoreFocusRef?: RefObject<HTMLElement | null> | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: SubscriptionRenewBody) => Promise<void> | void;
  loading?: boolean | undefined;
}

function defaultContinueNextBillingDate(subscription: Subscription, today: DateOnly): DateOnly {
  // continue 只能预览后端按原锚点会推进到哪里；用户在该模式下不能把日期当作新开始日提交。
  const result = advanceSubscriptionRenewal({
    billingCycle: subscription.billingCycle,
    status: subscription.status,
    startDate: subscription.startDate,
    nextBillingDate: subscription.nextBillingDate,
    autoRenew: subscription.autoRenew,
    autoCalculateNextBillingDate: subscription.autoCalculateNextBillingDate,
    customDays: subscription.customDays,
    customCycleUnit: subscription.customCycleUnit,
  }, today, "manual");
  return result?.nextBillingDate as DateOnly | undefined ?? subscription.nextBillingDate;
}

function defaultRestartNextBillingDate(subscription: Subscription, startDate: DateOnly): DateOnly {
  return calculateNextBillingDate(
    startDate,
    subscription.billingCycle,
    subscription.customDays,
    undefined,
    subscription.customCycleUnit,
  ) as DateOnly;
}

function createInitialState(subscription: Subscription, today: DateOnly): RenewFormState {
  const mode: RenewMode = subscription.status === "expired" ? "restart" : "continue";
  return {
    mode,
    price: subscription.price,
    currency: subscription.currency,
    startDate: today,
    nextBillingDate: mode === "restart" ? defaultRestartNextBillingDate(subscription, today) : defaultContinueNextBillingDate(subscription, today),
    autoCalculateNextBillingDate: mode === "restart",
  };
}

function hasRenewBodyDates(value: SubscriptionRenewBody): value is SubscriptionRenewBody & { startDate: string } {
  return value.mode !== "restart" || typeof value.startDate === "string";
}

export function RenewSubscriptionDialogContent({
  subscription,
  open,
  today,
  submitting,
  error,
  onOpenChange,
  onSubmit,
  loading,
  loadingPreview,
}: RenewSubscriptionDialogProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const { config } = useCustomConfigState();
  const { t, locale, formatDateOnly } = useI18n();
  const [form, setForm] = useState<RenewFormState | null>(() => (
    open && subscription ? createInitialState(subscription, today) : null
  ));
  const [errors, setErrors] = useState<RenewFormErrors>({});
  const includeDisabledCurrent = form?.currency ?? subscription?.currency ?? null;
  const currencyOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    ...(includeDisabledCurrent ? { includeDisabledCurrent } : {}),
    locale,
  });

  useLayoutEffect(() => {
    if (!open || !subscription) return;
    setForm(createInitialState(subscription, today));
    setErrors({});
  }, [open, subscription, today]);

  const setField = useCallback(<K extends keyof RenewFormState>(key: K, value: RenewFormState[K]) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
    setErrors((current) => ({ ...current, [key]: undefined }));
  }, []);

  const switchMode = useCallback((mode: RenewMode) => {
    if (!subscription) return;
    setForm((current) => {
      const base = current ?? createInitialState(subscription, today);
      if (mode === "continue") {
        // continue 的日期只展示后端将采用的推进结果；restart 草稿日期不会进入该模式的提交 payload。
        return {
          ...base,
          mode,
          nextBillingDate: defaultContinueNextBillingDate(subscription, today),
          autoCalculateNextBillingDate: false,
        };
      }
      const startDate = base.startDate ?? today;
      return {
        ...base,
        mode,
        startDate,
        nextBillingDate: defaultRestartNextBillingDate(subscription, startDate),
        autoCalculateNextBillingDate: true,
      };
    });
    setErrors({});
  }, [subscription, today]);

  const handleRestartStartDateChange = useCallback((value: DateOnly | undefined) => {
    if (!subscription || !value) return;
    setForm((current) => {
      if (!current) return current;
      return {
        ...current,
        startDate: value,
        nextBillingDate: current.autoCalculateNextBillingDate ? defaultRestartNextBillingDate(subscription, value) : current.nextBillingDate,
      };
    });
    setErrors((current) => ({ ...current, startDate: undefined, nextBillingDate: undefined }));
  }, [subscription]);

  const handleNextBillingDateChange = useCallback((value: DateOnly | undefined) => {
    if (!value) return;
    setForm((current) => current ? {
      ...current,
      nextBillingDate: value,
      // restart 下手动改下次扣费日就是用户覆盖自动推算锚点，提交时必须保存这个选择。
      autoCalculateNextBillingDate: current.mode === "restart" ? false : current.autoCalculateNextBillingDate,
    } : current);
    setErrors((current) => ({ ...current, nextBillingDate: undefined }));
  }, []);

  const validate = useCallback((value: RenewFormState): RenewFormErrors => {
    const nextErrors: RenewFormErrors = {};
    if (parseMoneyInput(value.price) === null) {
      nextErrors.price = t("subscription.validation.amountInvalid");
    }
    if (!currencyOptions.some((option) => option.value === value.currency && option.disabled !== true)) {
      nextErrors.currency = t("subscription.renew.validation.currencyRequired");
    }
    if (value.mode === "restart" && !value.startDate) {
      nextErrors.startDate = t("subscription.renew.validation.startDateRequired");
    }
    if (value.mode === "restart" && value.startDate && compareDateOnly(value.nextBillingDate, value.startDate) < 0) {
      nextErrors.nextBillingDate = t("subscription.validation.dateOrderInvalid");
    }
    return nextErrors;
  }, [currencyOptions, t]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || submitting) return;
    const nextErrors = validate(form);
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      // 错误元素要等 React 提交 aria-invalid 后再查找；否则会把焦点留在提交按钮上。
      window.requestAnimationFrame(() => {
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus();
      });
      return;
    }
    const price = parseMoneyInput(form.price);
    if (!price) return;
    const payload: SubscriptionRenewBody = {
      mode: form.mode,
      price,
      currency: form.currency,
      startDate: form.mode === "restart" ? form.startDate : null,
      nextBillingDate: form.nextBillingDate,
      autoCalculateNextBillingDate: form.mode === "restart" ? form.autoCalculateNextBillingDate : false,
    };
    if (!hasRenewBodyDates(payload)) return;
    await onSubmit(payload);
  };

  const titleSubscription = subscription ?? loadingPreview;
  const title = titleSubscription
    ? t("subscription.renew.title", { name: titleSubscription.name })
    : t("subscription.renew");
  const description = t("subscription.renew.description");
  const currentForm = form ?? (subscription ? createInitialState(subscription, today) : null);
  const resolveInitialFocus = useCallback(
    () => formRef.current?.querySelector<HTMLElement>('[role="radio"][data-state="checked"]') ?? null,
    [],
  );
  useDeferredDialogInitialFocus(
    open,
    !loading && currentForm !== null,
    subscription?.id ?? "renew-subscription",
    resolveInitialFocus,
  );
  const restartMode = currentForm?.mode === "restart" || (currentForm === null && loadingPreview?.status === "expired");
  const submitLabel = restartMode ? t("subscription.renew.restartSubmit") : t("subscription.renew.submit");
  const modeDescription = useMemo(() => {
    if (!currentForm) return "";
    return currentForm.mode === "continue"
      ? t("subscription.renew.modeContinueHelp")
      : t("subscription.renew.modeRestartHelp");
  }, [currentForm, t]);

  const loadingSlots = loading
    ? createRenewSubscriptionLoadingSlots({ label: t("common.loading"), restartMode })
    : null;
  if (!loading && !currentForm) return null;

  return (
    <RenewSubscriptionScaffold
      formRef={formRef}
      onSubmit={submit}
      noValidate
      data-testid={loading ? "renew-subscription-data-loading" : undefined}
      heading={title}
      description={description}
      mode={loadingSlots?.mode ?? (currentForm ? (
        <FormField id="renew-mode" label={t("subscription.renew.mode")} description={modeDescription}>
          {(field) => (
            <RadioGroup
              value={currentForm.mode}
              onValueChange={(value) => switchMode(value as RenewMode)}
              aria-describedby={field.describedBy}
              className="grid gap-2 sm:grid-cols-2"
            >
              {(["continue", "restart"] as const).map((mode) => {
                const optionId = `renew-mode-${mode}`;
                return (
                  <label
                    key={mode}
                    htmlFor={optionId}
                    className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border border-border bg-secondary p-3 text-sm transition-colors hover:bg-accent"
                  >
                    <RadioGroupItem id={optionId} value={mode} className="mt-0.5 shrink-0" />
                    <span className="grid min-w-0 gap-1">
                      <span className="font-medium text-foreground">
                        {mode === "continue" ? t("subscription.renew.modeContinue") : t("subscription.renew.modeRestart")}
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {mode === "continue" ? t("subscription.renew.modeContinueShort") : t("subscription.renew.modeRestartShort")}
                      </span>
                    </span>
                  </label>
                );
              })}
            </RadioGroup>
          )}
        </FormField>
      ) : null)}
      pricing={loadingSlots?.pricing ?? (currentForm ? (
        <FormFieldRow
          alignAt="sm"
          rowClassName="sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)]"
          errors={[
            { id: "renew-price-error", message: errors.price },
            { id: "renew-currency-error", message: errors.currency },
          ]}
        >
          <FormField id="renew-price" label={t("subscription.field.price")} error={errors.price} renderError={false}>
            {(field) => (
              <NumericInput
                id={field.id}
                value={currentForm.price}
                onRawValueChange={(value) => setField("price", value)}
                decimalScale={6}
                allowNegative={false}
                thousandSeparator
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                className="h-11 border-border bg-secondary"
              />
            )}
          </FormField>
          <FormField id="renew-currency" label={t("subscription.field.currency")} error={errors.currency} renderError={false}>
            {(field) => (
              <SearchableSelect
                id={field.id}
                value={currentForm.currency}
                onValueChange={(value) => setField("currency", value)}
                options={currencyOptions}
                placeholder={t("subscription.placeholder.currency")}
                searchPlaceholder={t("subscription.search.currency")}
                emptyMessage={t("subscription.empty.currency")}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                className="h-11 border-border bg-secondary"
              />
            )}
          </FormField>
        </FormFieldRow>
      ) : null)}
      schedule={loadingSlots?.schedule ?? (currentForm ? (
        <>
          {restartMode ? (
            <FormFieldRow
              alignAt="sm"
              rowClassName="sm:grid-cols-2"
              errors={[
                { id: "renew-start-date-error", message: errors.startDate },
                { id: "renew-next-billing-date-error", message: errors.nextBillingDate },
              ]}
            >
              <FormField
                id="renew-start-date"
                label={t("subscription.field.startDate")}
                labelId="renew-start-date-label"
                error={errors.startDate}
                renderError={false}
              >
                {(field) => (
                  <DateOnlyPickerField
                    id={field.id}
                    labelId="renew-start-date-label"
                    valueId="renew-start-date-value"
                    value={currentForm.startDate ?? undefined}
                    onChange={handleRestartStartDateChange}
                    placeholder={t("subscription.placeholder.date")}
                    describedBy={field.describedBy}
                    invalid={field.invalid}
                    minDate={today}
                    defaultMonth={currentForm.startDate ?? today}
                    size="large"
                  />
                )}
              </FormField>
              <FormField
                id="renew-next-billing-date"
                label={t("subscription.field.nextBillingDate")}
                labelId="renew-next-billing-date-label"
                error={errors.nextBillingDate}
                renderError={false}
              >
                {(field) => (
                  <DateOnlyPickerField
                    id={field.id}
                    labelId="renew-next-billing-date-label"
                    valueId="renew-next-billing-date-value"
                    value={currentForm.nextBillingDate}
                    onChange={handleNextBillingDateChange}
                    placeholder={t("subscription.placeholder.date")}
                    describedBy={field.describedBy}
                    invalid={field.invalid}
                    minDate={currentForm.startDate ?? today}
                    defaultMonth={currentForm.nextBillingDate}
                    size="large"
                  />
                )}
              </FormField>
            </FormFieldRow>
          ) : (
            <div className="grid gap-3 rounded-md border border-border bg-secondary/40 p-3 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <p className="text-xs leading-5 text-muted-foreground">{t("subscription.renew.currentNextBillingDate")}</p>
                  <p className="font-medium text-foreground">{subscription ? formatDateOnly(subscription.nextBillingDate) : "-"}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs leading-5 text-muted-foreground">{t("subscription.renew.continueNextBillingDate")}</p>
                  <p className="font-medium text-foreground">{formatDateOnly(currentForm.nextBillingDate)}</p>
                </div>
              </div>
            </div>
          )}
        </>
      ) : null)}
      actions={loadingSlots?.actions ?? (currentForm ? (
        <>
          {error ? (
            <p className="w-full min-w-0 wrap-break-word text-center text-sm text-destructive sm:mr-auto sm:w-auto sm:text-left">
              {error}
            </p>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="w-full border-border sm:w-auto" disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={submitting} className="w-full bg-primary text-primary-foreground hover:bg-primary-glow sm:w-auto">
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {submitLabel}
          </Button>
        </>
      ) : null)}
    />
  );
}
