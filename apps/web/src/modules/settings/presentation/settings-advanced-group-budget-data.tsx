import { useLayoutEffect, useRef } from "react";
import { Activity, Coins, CreditCard, FolderKanban, Settings2 } from "lucide-react";
import { FormField } from "@/components/ui/form-field";
import { NumericInput } from "@/components/ui/numeric-input";
import type { SearchableSelectOption } from "@/components/ui/searchable-select";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import { useI18n } from "@/i18n/I18nProvider";
import { ConfigManagerDialog } from "@/modules/custom-config/presentation/config-manager-dialog";
import { isBuiltInPaymentMethodValue } from "@/types/config";
import { type SubscriptionPriceReferenceCurrency } from "@/types/subscription";
import type { SettingsFormController } from "../application/use-settings-form-controller";
import { getLocalSubscriptionPriceReferenceCurrencyPreference } from "../domain/subscription-price-reference-currency-local-preference";
import { ExchangeRatesSection } from "./exchange-rates-section";
import { SETTINGS_SECTION_FRAME_CLASS, SETTINGS_SECTION_SCROLL_CLASS } from "./settings-layout";

export function SettingsAdvancedBudgetDataGroup({
  controller,
  onReady,
}: {
  controller: SettingsFormController;
  onReady?: (() => void) | undefined;
}) {
  const { t, locale } = useI18n();
  const {
    settings,
    customConfig,
    subscriptionFacets,
    categoryUsageCount,
    rates,
    activeRateProvider,
    ratesRefreshPending,
    lastUpdated,
    ratesError,
    ratesErrorDetails,
    ratesWarning,
    reportBasisStatus,
    getCurrencySymbol,
    updateCategories,
    updateStatuses,
    updatePaymentMethods,
    updateSetting,
    monthlyBudgetInput,
    monthlyBudgetError,
    handleMonthlyBudgetInputChange,
    handleRefreshRates,
    handleUpdateCurrencies,
    handleDefaultCurrencyChange,
    handleExchangeRateProviderChange,
  } = controller;
  const readyRef = useRef(false);
  const defaultCurrencyOptions = useManagedCurrencyOptions({
    currencies: customConfig.currencies,
    includeDisabledCurrent: settings.defaultCurrency,
    locale,
  });
  const effectiveSubscriptionPriceReferenceCurrency = settings.subscriptionPriceReferenceCurrency === "default"
    ? settings.defaultCurrency
    : settings.subscriptionPriceReferenceCurrency;
  const explicitSubscriptionPriceReferenceCurrency = settings.subscriptionPriceReferenceCurrency === "default"
    ? null
    : settings.subscriptionPriceReferenceCurrency;
  const managedSubscriptionPriceReferenceCurrencyOptions = useManagedCurrencyOptions({
    currencies: customConfig.currencies,
    includeDisabledCurrent: explicitSubscriptionPriceReferenceCurrency,
    locale,
  });
  const subscriptionPriceReferenceCurrencyOptions: SearchableSelectOption[] = [
    {
      value: "default",
      label: t("settings.subscriptionPriceReferenceCurrencyDefault", { currency: settings.defaultCurrency }),
      keywords: ["default", settings.defaultCurrency],
    },
    ...managedSubscriptionPriceReferenceCurrencyOptions,
  ];
  const localPreference = getLocalSubscriptionPriceReferenceCurrencyPreference()?.currency ?? null;
  const subscriptionPriceReferenceCurrencyLocalPreference = localPreference
    && subscriptionPriceReferenceCurrencyOptions.some((option) => option.value === localPreference && !option.disabled)
    ? localPreference
    : null;

  useLayoutEffect(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    onReady?.();
  }, [onReady]);

  return (
    <>
      <section id="settings-budget" className={SETTINGS_SECTION_FRAME_CLASS}>
        <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.budget")}</h2>
        <div className="grid gap-4">
          <FormField id="monthlyBudget" label={t("settings.monthlyBudget")} description={t("settings.monthlyBudgetHelp")} error={monthlyBudgetError}>
            {(field) => (
              <div className="flex flex-col gap-2 min-[380px]:flex-row min-[380px]:items-center min-[380px]:gap-3">
                <NumericInput
                  id={field.id}
                  name={field.id}
                  allowNegative={false}
                  allowedDecimalSeparators={[".", "。"]}
                  inputMode="decimal"
                  enterKeyHint="done"
                  value={monthlyBudgetInput}
                  onRawValueChange={handleMonthlyBudgetInputChange}
                  className="w-full border-border bg-secondary min-[380px]:w-[min(12.5rem,100%)]"
                  placeholder="1500"
                  thousandSeparator
                  aria-invalid={field.invalid}
                  aria-describedby={field.describedBy}
                />
                <span className="text-sm text-muted-foreground">{getCurrencySymbol(settings.defaultCurrency)} {settings.defaultCurrency} {t("settings.perMonth")}</span>
              </div>
            )}
          </FormField>
        </div>
      </section>

      <section id="settings-data-config" className={SETTINGS_SECTION_FRAME_CLASS}>
        <div className="mb-4 flex items-center gap-2"><Settings2 className="h-5 w-5 text-primary" /><h2 className="text-lg font-semibold text-foreground">{t("settings.dataConfig")}</h2></div>
        <p className="mb-6 text-sm text-muted-foreground">{t("settings.dataConfigDescription")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <ConfigManagerDialog
            title={t("settings.categoryManager")}
            description={t("settings.categoryManagerDescription")}
            items={customConfig.categories}
            onUpdate={updateCategories}
            showColor
            maxItems={200}
            icon={<FolderKanban className="h-4 w-4" />}
            getDeleteBlockReason={(item) => {
              if (customConfig.categories.length <= 1) return t("settings.categoryKeepOne");
              if (subscriptionFacets.isInitialLoading) return t("settings.categoryChecking");
              if (subscriptionFacets.error && !subscriptionFacets.hasData) return t("settings.categoryCheckFailed");
              const usedCount = categoryUsageCount.get(item.value) ?? 0;
              return usedCount > 0 ? t("settings.categoryUsed", { count: usedCount }) : null;
            }}
          />
          <ConfigManagerDialog title={t("settings.statusManager")} description={t("settings.statusManagerDescription")} items={customConfig.statuses} onUpdate={updateStatuses} showColor readOnly icon={<Activity className="h-4 w-4" />} />
          <ConfigManagerDialog title={t("settings.paymentManager")} description={t("settings.paymentManagerDescription")} items={customConfig.paymentMethods} onUpdate={updatePaymentMethods} icon={<CreditCard className="h-4 w-4" />} showIcon maxItems={200} isItemReadOnly={(item) => isBuiltInPaymentMethodValue(item.value)} />
          <ConfigManagerDialog title={t("settings.currencyManager")} description={t("settings.currencyManagerDescription")} items={customConfig.currencies} onUpdate={handleUpdateCurrencies} icon={<Coins className="h-4 w-4" />} toggleMode searchable searchPlaceholder={t("settings.currencySearch")} searchEmptyMessage={t("settings.currencyEmpty")} />
        </div>
      </section>

      <ExchangeRatesSection
        id="settings-exchange"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        settings={settings}
        customConfig={customConfig}
        rates={rates}
        activeRateProvider={activeRateProvider}
        ratesRefreshPending={ratesRefreshPending}
        ratesError={ratesError}
        ratesErrorDetails={ratesErrorDetails}
        ratesWarning={ratesWarning}
        reportBasisStatus={reportBasisStatus}
        lastUpdated={lastUpdated}
        defaultCurrencyOptions={defaultCurrencyOptions}
        subscriptionPriceReferenceCurrencyOptions={subscriptionPriceReferenceCurrencyOptions}
        effectiveSubscriptionPriceReferenceCurrency={effectiveSubscriptionPriceReferenceCurrency}
        subscriptionPriceReferenceCurrencyLocalPreference={subscriptionPriceReferenceCurrencyLocalPreference}
        handleRefreshRates={handleRefreshRates}
        handleDefaultCurrencyChange={handleDefaultCurrencyChange}
        handleSubscriptionPriceReferenceEnabledChange={(checked) => updateSetting("subscriptionPriceReferenceEnabled", checked)}
        handleSubscriptionPriceReferenceCurrencyChange={(value) => updateSetting("subscriptionPriceReferenceCurrency", value as SubscriptionPriceReferenceCurrency)}
        handleExchangeRateProviderChange={handleExchangeRateProviderChange}
      />
    </>
  );
}
