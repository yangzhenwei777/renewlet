import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumericInput } from "@/components/ui/numeric-input";
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import { TimePicker } from "@/components/ui/time-picker";
import { RawErrorResponseDialog } from "@/components/raw-error-response-dialog";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import { useI18n } from "@/i18n/I18nProvider";
import { createTimeZoneSelectOptions } from "@/lib/searchable-options";
import { assertLocalTime } from "@/lib/time/local-time";
import { getSupportedTimeZones } from "@/lib/time/time-zone";
import {
  MAX_REMINDER_DAYS,
  type NotificationChannel,
  type PublicStatusCurrency,
} from "@/types/subscription";
import type { SettingsFormController } from "../application/use-settings-form-controller";
import { NotificationChannelConfigPanel } from "./notification-channel-config-panel";
import { NotificationChannelList } from "./notification-channel-list";
import { NotificationHistoryPanel } from "./notification-history-panel";
import { PublicApiSection } from "./public-api-section";
import { PublicStatusPageSection } from "./public-status-page-section";
import { SETTINGS_SECTION_FRAME_CLASS, SETTINGS_SECTION_SCROLL_CLASS } from "./settings-layout";

export function SettingsAdvancedPublicNotificationsGroup({
  controller,
  onReady,
}: {
  controller: SettingsFormController;
  onReady?: (() => void) | undefined;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const {
    settings,
    secretStatus,
    clearSecret,
    customConfig,
    updateSetting,
    toggleChannel,
    notificationTestErrorDetails,
    notificationTestErrorDetailsOpen,
    setNotificationTestErrorDetailsOpen,
    notificationHistory,
    publicStatusPage,
    publicApi,
    telegramBotCommands,
    testingChannel,
    handleTestConnection,
    externalIntegrationsDisabled,
  } = controller;
  const [selectedNotificationChannel, setSelectedNotificationChannel] = useState<NotificationChannel | null>(null);
  const [notificationReminderDaysInput, setNotificationReminderDaysInput] = useState(String(settings.notificationReminderDays));
  const readyRef = useRef(false);
  const timezoneOptions = createTimeZoneSelectOptions(getSupportedTimeZones());
  const explicitPublicStatusCurrency = settings.publicStatusCurrency === "inherit" ? null : settings.publicStatusCurrency;
  const managedPublicStatusCurrencyOptions = useManagedCurrencyOptions({
    currencies: customConfig.currencies,
    includeDisabledCurrent: explicitPublicStatusCurrency,
    locale,
  });
  const publicStatusCurrencyOptions: SearchableSelectOption[] = [
    {
      value: "inherit",
      label: t("settings.publicStatusCurrencyInherit", { currency: settings.defaultCurrency }),
      keywords: ["inherit", settings.defaultCurrency],
    },
    ...managedPublicStatusCurrencyOptions,
  ];
  const effectivePublicStatusCurrency = settings.publicStatusCurrency === "inherit"
    ? settings.defaultCurrency
    : settings.publicStatusCurrency;
  const activeNotificationChannel = selectedNotificationChannel ?? settings.enabledChannels[0] ?? "telegram";

  useLayoutEffect(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    onReady?.();
  }, [onReady]);

  useEffect(() => {
    setNotificationReminderDaysInput(String(settings.notificationReminderDays));
  }, [settings.notificationReminderDays]);

  const handleNotificationChannelToggle = (channel: NotificationChannel) => {
    setSelectedNotificationChannel(channel);
    toggleChannel(channel);
  };
  const handleNotificationReminderDaysInputChange = (value: string) => {
    setNotificationReminderDaysInput(value);
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_REMINDER_DAYS) return;
    updateSetting("notificationReminderDays", parsed);
  };

  return (
    <>
      <PublicStatusPageSection
        id="settings-public-status"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        status={publicStatusPage.status}
        visibility={publicStatusPage.visibility}
        publicStatusCurrency={settings.publicStatusCurrency}
        effectivePublicStatusCurrency={effectivePublicStatusCurrency}
        publicStatusCurrencyOptions={publicStatusCurrencyOptions}
        isCreating={publicStatusPage.isCreating}
        isDeleting={publicStatusPage.isDeleting}
        isUpdating={publicStatusPage.isUpdating}
        onCreate={publicStatusPage.createOrRotate}
        onCopy={publicStatusPage.copyUrl}
        onDelete={publicStatusPage.revoke}
        onOpenPage={publicStatusPage.openPage}
        onRegenerate={publicStatusPage.regenerate}
        onShowPricesChange={publicStatusPage.updateShowPrices}
        onHideExpiredChange={publicStatusPage.updateHideExpired}
        onHideLifetimeChange={publicStatusPage.updateHideLifetime}
        onBulkPublicVisibility={publicStatusPage.bulkPublicVisibility}
        onManageVisibility={() => navigate("/subscriptions?publicVisibility=manage", { state: { publicVisibilityReturnTo: "/settings#settings-public-status" } })}
        onPublicStatusCurrencyChange={(value) => updateSetting("publicStatusCurrency", value as PublicStatusCurrency)}
      />
      <PublicApiSection id="settings-public-api" className={SETTINGS_SECTION_SCROLL_CLASS} controller={publicApi} />
      <section id="settings-timezone" className={SETTINGS_SECTION_FRAME_CLASS}>
        <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.timezone")}</h2>
        <div className="grid gap-2">
          <Label htmlFor="timezone">{t("settings.timezoneSelect")}</Label>
          <SearchableSelect
            value={settings.timezone}
            onValueChange={(value) => updateSetting("timezone", value)}
            options={timezoneOptions}
            placeholder={t("settings.timezonePlaceholder")}
            searchPlaceholder={t("settings.timezoneSearch")}
            emptyMessage={t("settings.timezoneEmpty")}
            className="w-full max-w-md border-border bg-secondary"
            contentClassName="max-w-md"
            aria-label={t("settings.timezoneSelect")}
          />
          <p className="text-xs text-muted-foreground">{t("settings.timezoneHelp")}</p>
        </div>
      </section>
      <section id="settings-notifications" className={SETTINGS_SECTION_FRAME_CLASS}>
        <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.notifications")}</h2>
        <div className="grid gap-6">
          <div className="grid gap-6">
            <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2 sm:gap-x-6">
              <FormField id="notificationTimeLocal" label={t("settings.notificationTime")} description={t("settings.notificationTimeHelp")}>
                {({ id: fieldId, describedBy }) => <TimePicker id={fieldId} value={settings.notificationTimeLocal} onChange={(value) => updateSetting("notificationTimeLocal", assertLocalTime(value))} className="w-full" ariaLabel={t("settings.notificationTime")} ariaDescribedBy={describedBy} />}
              </FormField>
              <FormField id="notificationReminderDays" label={t("settings.notificationReminderDays")} description={t("settings.notificationReminderDaysHelp")}>
                {({ id: fieldId, describedBy }) => <NumericInput id={fieldId} name="notificationReminderDays" allowNegative={false} decimalScale={0} inputMode="numeric" enterKeyHint="done" value={notificationReminderDaysInput} onRawValueChange={handleNotificationReminderDaysInputChange} className="border-border bg-secondary" aria-describedby={describedBy} />}
              </FormField>
            </FormFieldRow>
            <div className="grid content-start gap-2"><Label>{t("settings.tip")}</Label><p className="text-xs text-muted-foreground">{t("settings.cronTip")}</p></div>
          </div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,280px)_1fr]">
            <NotificationChannelList settings={settings} activeChannel={activeNotificationChannel} onSelect={setSelectedNotificationChannel} onToggle={handleNotificationChannelToggle} disabled={externalIntegrationsDisabled} />
            <NotificationChannelConfigPanel channel={activeNotificationChannel} settings={settings} enabled={settings.enabledChannels.includes(activeNotificationChannel)} updateSetting={updateSetting} testingChannel={testingChannel} onTest={handleTestConnection} disabled={externalIntegrationsDisabled} telegramBotCommands={telegramBotCommands} secretStatus={secretStatus} onClearSecret={clearSecret} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="testPhone">{t("settings.testPhone")}</Label>
            <Input id="testPhone" name="testPhone" type="tel" inputMode="tel" enterKeyHint="done" autoComplete="tel" placeholder={t("settings.testPhonePlaceholder")} value={settings.testPhone} disabled={externalIntegrationsDisabled} onChange={(event) => updateSetting("testPhone", event.target.value)} className="border-border bg-secondary" />
            <p className="text-xs text-muted-foreground">{t("settings.testPhoneHelp")}</p>
          </div>
          <NotificationHistoryPanel controller={notificationHistory} />
        </div>
      </section>
      <RawErrorResponseDialog open={notificationTestErrorDetailsOpen} details={notificationTestErrorDetails} onOpenChange={setNotificationTestErrorDetailsOpen} title={t("rawErrorResponse.title")} description={t("rawErrorResponse.description")} testId="notification-test-raw-error-response-dialog" />
    </>
  );
}
