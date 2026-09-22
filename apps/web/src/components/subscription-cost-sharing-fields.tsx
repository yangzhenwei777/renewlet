import { useCallback, useEffect, useRef, useState, type Ref, type RefObject } from "react";
import { DateOnlyPickerField } from "@/components/date-only-picker-field";
import { FieldError } from "@/components/ui/field-error";
import { FormField, FormFieldRow, FormFieldRowAction } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumericInput } from "@/components/ui/numeric-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  billingCycleLabelForForm,
  COLLECTION_REMINDER_CUSTOM_VALUE,
  collectionReminderSelectValue,
  collectionReminderSummaryText,
  costSharingTotal,
  defaultCollectionReminder,
  defaultCostSharing,
  defaultCustomCollectionReminderDays,
  MAX_COST_SHARING_MEMBERS,
  newCostSharingId,
  setCostSharing,
  type CostSharingFieldUpdater,
} from "@/components/subscription-cost-sharing-model";
import { useI18n } from "@/i18n/I18nProvider";
import { formatCurrencySymbolAmount, getCurrencyAmountPrefix } from "@/lib/currency";
import type { SearchableSelectOption } from "@/lib/searchable-options";
import { parseMoneyInput, parseNonNegativeIntegerInput, resolveCostSharingJoinedDateRangeForForm } from "@/lib/subscription-form";
import type { CostSharing, CostSharingMember } from "@/types/subscription";
import { INHERIT_REMINDER_DAYS, REMINDER_DAYS_OPTIONS } from "@/types/subscription";
import type { SubscriptionFormState } from "@/types/subscription-form";
import {
  calculateCostSharingMemberAmount,
  calculateCostSharingSummary,
  costSharingMemberJoinedDateIsWithinRange,
  isValidCostSharingCollectionReminderDays,
  type CostSharingCollectionReminder,
} from "@renewlet/shared/cost-sharing";
import { Plus, Trash2, Users } from "lucide-react";

function costSharingAmountsDiffer(a: number, b: number): boolean {
  return Math.abs(a - b) >= 0.01;
}

function CostSharingSummaryGrid({
  memberTotal,
  yourShare,
  recoverableAmount,
  currency,
}: {
  memberTotal: number;
  yourShare: number;
  recoverableAmount: number;
  currency: string;
}) {
  const { t, formatCurrency } = useI18n();

  return (
    <div data-testid="cost-sharing-summary" className="grid gap-2 rounded-md bg-background/60 p-3 text-sm sm:grid-cols-3">
      <div>
        <p className="text-muted-foreground">{t("subscription.costSharing.memberTotal")}</p>
        <p className="font-semibold text-warning">{formatCurrency(memberTotal, currency)}</p>
      </div>
      <div>
        <p className="text-muted-foreground">{t("subscription.costSharing.yourShare")}</p>
        <p className="font-semibold text-primary">{formatCurrency(yourShare, currency)}</p>
      </div>
      <div>
        <p className="text-muted-foreground">{t("subscription.costSharing.recoverableAmount")}</p>
        <p className="font-semibold text-foreground">{formatCurrency(recoverableAmount, currency)}</p>
      </div>
    </div>
  );
}

export function CostSharingFields({
  id,
  formData,
  update,
  error,
  currencyOptions,
  currencyConvert,
  notificationReminderDays,
  collectionReminderAllowed,
  onNestedDialogOpenChange,
}: {
  id: (name: string) => string;
  formData: SubscriptionFormState;
  update: CostSharingFieldUpdater;
  error?: string | undefined;
  currencyOptions: SearchableSelectOption[];
  currencyConvert?: ((amount: number | string, fromCurrency: string, toCurrency: string) => number) | undefined;
  notificationReminderDays: number;
  collectionReminderAllowed: boolean;
  onNestedDialogOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const { t, locale } = useI18n();
  const [memberDialogOpen, setMemberDialogOpenState] = useState(false);
  const manageMembersButtonRef = useRef<HTMLButtonElement>(null);
  const firstMemberNameInputRef = useRef<HTMLInputElement>(null);
  const costSharing = formData.costSharing;
  const total = costSharingTotal(formData);
  const summary = calculateCostSharingSummary(costSharing, total, { baseCurrency: formData.currency, convert: currencyConvert });
  const enabled = Boolean(costSharing?.enabled);
  const collectionReminder = costSharing?.collectionReminder;
  const cycleLabel = billingCycleLabelForForm(formData, locale);
  const collectionReminderSummary = collectionReminderSummaryText(t, collectionReminder, notificationReminderDays, cycleLabel, collectionReminderAllowed);
  const showCustomTotalHint = Boolean(
    costSharing?.splitMode === "custom" && costSharingAmountsDiffer(summary.memberTotal, total),
  );
  const setMemberDialogOpen = useCallback((open: boolean) => {
    // 成员管理器在组件内拥有 open 状态，但仍要上报父层 close guard，避免 Radix 焦点交接期间误关并重置父表单。
    setMemberDialogOpenState(open);
    onNestedDialogOpenChange?.(open);
  }, [onNestedDialogOpenChange]);
  return (
    <div className="grid gap-3 rounded-lg border border-border bg-secondary/30 p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={id("costSharingEnabled")} className="cursor-pointer text-sm font-medium">
            {t("subscription.costSharing.title")}
          </Label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("subscription.costSharing.help")}</p>
        </div>
        <Switch
          id={id("costSharingEnabled")}
          checked={enabled}
          onCheckedChange={(checked) => setCostSharing(update, checked ? { ...(costSharing ?? defaultCostSharing(t)), enabled: true } : undefined, t)}
          aria-label={t("subscription.costSharing.title")}
        />
      </div>

      {enabled && costSharing ? (
        <>
          <FormFieldRow
            alignAt="sm"
            rowClassName="sm:grid-cols-[minmax(0,16rem)_auto] sm:justify-between"
          >
            <FormField id={id("costSharingSplitMode")} label={t("subscription.costSharing.splitMode")}>
              {({ id: fieldId }) => (
                <Select value={costSharing.splitMode} onValueChange={(value) => setCostSharing(update, { ...costSharing, splitMode: value as CostSharing["splitMode"] }, t)}>
                  <SelectTrigger id={fieldId} className="border-border bg-secondary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="equal">{t("subscription.costSharing.equal")}</SelectItem>
                    <SelectItem value="custom">{t("subscription.costSharing.custom")}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormFieldRowAction controlClassName="flex-col gap-2 sm:justify-self-end">
              <Button
                ref={manageMembersButtonRef}
                type="button"
                variant="outline"
                size="sm"
                data-cost-sharing-manage-members-trigger=""
                className="w-fit border-border"
                onClick={() => setMemberDialogOpen(true)}
              >
                <Users className="h-4 w-4" />
                {t("subscription.costSharing.manageMembers")}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t("subscription.costSharing.memberCount", { count: summary.memberCount })}
              </span>
            </FormFieldRowAction>
          </FormFieldRow>

          <CostSharingSummaryGrid
            memberTotal={summary.memberTotal}
            yourShare={summary.yourShare}
            recoverableAmount={summary.recoverableAmount}
            currency={formData.currency}
          />
          {showCustomTotalHint ? (
            <p data-testid="cost-sharing-custom-total-hint" className="text-xs leading-5 text-muted-foreground">
              {t("subscription.costSharing.customTotalMismatchHint")}
            </p>
          ) : null}
          <p data-testid="cost-sharing-collection-reminder-summary" className="min-w-0 text-xs leading-5 text-muted-foreground">
            {collectionReminderSummary}
          </p>
          <FieldError id={id("costSharing-error")} message={error} />
          <CostSharingMemberDialog
            open={memberDialogOpen}
            onOpenChange={setMemberDialogOpen}
            id={id}
            formData={formData}
            update={update}
            currencyOptions={currencyOptions}
            currencyConvert={currencyConvert}
            notificationReminderDays={notificationReminderDays}
            collectionReminderAllowed={collectionReminderAllowed}
            error={error}
            manageMembersButtonRef={manageMembersButtonRef}
            initialMemberNameInputRef={firstMemberNameInputRef}
          />
        </>
      ) : null}
    </div>
  );
}
export function CostSharingMemberManagerView({
  id,
  formData,
  update,
  currencyOptions,
  currencyConvert,
  notificationReminderDays,
  collectionReminderAllowed,
  error,
  initialMemberNameInputRef,
}: {
  id: (name: string) => string;
  formData: SubscriptionFormState;
  update: CostSharingFieldUpdater;
  currencyOptions: SearchableSelectOption[];
  currencyConvert?: ((amount: number | string, fromCurrency: string, toCurrency: string) => number) | undefined;
  notificationReminderDays: number;
  collectionReminderAllowed: boolean;
  error?: string | undefined;
  initialMemberNameInputRef?: Ref<HTMLInputElement> | undefined;
}) {
  const { t, locale, label } = useI18n();
  const costSharing = formData.costSharing ?? defaultCostSharing(t);
  const members = costSharing.members;
  const total = costSharingTotal(formData);
  const summary = calculateCostSharingSummary(costSharing, total, { baseCurrency: formData.currency, convert: currencyConvert });
  const collectionReminder = costSharing.collectionReminder;
  const collectionReminderEnabled = collectionReminderAllowed && Boolean(collectionReminder?.enabled);
  const collectionReminderValue = collectionReminderSelectValue(collectionReminder);
  const collectionReminderCustomDays =
    collectionReminderValue === COLLECTION_REMINDER_CUSTOM_VALUE && collectionReminder?.reminderDays !== undefined
      ? String(collectionReminder.reminderDays)
      : "";
  const [collectionReminderCustomInput, setCollectionReminderCustomInput] = useState(collectionReminderCustomDays);
  const managerErrorId = id("costSharingMembers-error");
  useEffect(() => {
    // 数字输入要允许用户清空重输；只有外部 preset/订阅切换时才把本地草稿同步回持久值。
    setCollectionReminderCustomInput(collectionReminderCustomDays);
  }, [collectionReminderCustomDays]);
  const joinedDateRequired = collectionReminderEnabled && !formData.startDate;
  const joinedDateRange = resolveCostSharingJoinedDateRangeForForm(formData);
  const joinedDateRangeInvalid = members.some((member) => !costSharingMemberJoinedDateIsWithinRange(member, joinedDateRange));
  const displayError = error ?? (joinedDateRangeInvalid ? t("subscription.validation.costSharingMemberJoinedDateRangeInvalid") : undefined);
  const cycleLabel = billingCycleLabelForForm(formData, locale);
  const memberShareInCurrency = (member: CostSharingMember) => {
    const memberCurrency = member.currency ?? formData.currency;
    const baseShare = calculateCostSharingMemberAmount(costSharing, member, total, {
      baseCurrency: formData.currency,
      convert: currencyConvert,
    });
    return currencyConvert ? currencyConvert(baseShare, formData.currency, memberCurrency) : baseShare;
  };
  // 成员编辑直接写入父表单的同一份 costSharing；关闭二级 Dialog 只有导航语义，不存在额外提交或回滚镜像。
  const updateMember = (memberId: string, patch: Partial<CostSharingMember>) => {
    setCostSharing(update, {
      ...costSharing,
      enabled: true,
      members: costSharing.members.map((member) => member.id === memberId ? { ...member, ...patch } : member),
    }, t);
  };
  const updateCollectionReminder = (next: CostSharingCollectionReminder | undefined) => {
    setCostSharing(update, { ...costSharing, enabled: true, collectionReminder: next }, t);
  };
  const removeMember = (memberId: string) => {
    if (costSharing.members.length <= 1) return;
    const nextMembers = costSharing.members.filter((member) => member.id !== memberId);
    setCostSharing(update, {
      ...costSharing,
      enabled: true,
      members: nextMembers,
    }, t);
  };
  const addMember = () => {
    if (costSharing.members.length >= MAX_COST_SHARING_MEMBERS) return;
    setCostSharing(update, {
      ...costSharing,
      enabled: true,
      members: [
        ...costSharing.members,
        {
          id: newCostSharingId(),
          name: t("subscription.costSharing.memberDefault", { index: costSharing.members.length + 1 }),
        },
      ],
    }, t);
  };
  return (
    <div data-testid="cost-sharing-members-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-6 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {t("subscription.costSharing.memberCount", { count: summary.memberCount })}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("subscription.costSharing.manageMembersDescription")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit border-border"
            onClick={addMember}
            disabled={members.length >= MAX_COST_SHARING_MEMBERS}
          >
            <Plus className="h-4 w-4" />
            {t("subscription.costSharing.addMember")}
          </Button>
        </div>
        <div className="mt-3 grid gap-3 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor={id("costSharingCollectionReminderEnabled")} className="cursor-pointer text-sm font-medium">
                {t("subscription.costSharing.collectionReminder")}
              </Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {collectionReminderSummaryText(t, collectionReminder, notificationReminderDays, cycleLabel, collectionReminderAllowed)}
              </p>
            </div>
            <Switch
              id={id("costSharingCollectionReminderEnabled")}
              checked={collectionReminderEnabled}
              disabled={!collectionReminderAllowed}
              onCheckedChange={(checked) => {
                if (!collectionReminderAllowed) return;
                updateCollectionReminder(checked
                  ? { ...(collectionReminder ?? defaultCollectionReminder()), enabled: true }
                  : { ...(collectionReminder ?? defaultCollectionReminder()), enabled: false });
              }}
              aria-label={t("subscription.costSharing.collectionReminder")}
            />
          </div>

          {collectionReminderEnabled ? (
            <div className="grid gap-3 sm:max-w-sm">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor={id("costSharingCollectionReminderDays")}>{t("subscription.costSharing.collectionReminderBefore")}</Label>
                <Select
                  value={collectionReminderValue}
                  onValueChange={(value) => {
                    if (value === COLLECTION_REMINDER_CUSTOM_VALUE) {
                      updateCollectionReminder({
                        ...(collectionReminder ?? defaultCollectionReminder()),
                        enabled: true,
                        reminderDays: defaultCustomCollectionReminderDays(),
                      });
                      return;
                    }
                    const days = Number(value);
                    updateCollectionReminder({
                      ...(collectionReminder ?? defaultCollectionReminder()),
                      enabled: true,
                      reminderDays: isValidCostSharingCollectionReminderDays(days) ? days : INHERIT_REMINDER_DAYS,
                    });
                  }}
                >
                  <SelectTrigger
                    id={id("costSharingCollectionReminderDays")}
                    className="border-border bg-secondary"
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? managerErrorId : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={String(INHERIT_REMINDER_DAYS)}>
                      {t("subscription.costSharing.collectionReminderInherit", { days: notificationReminderDays })}
                    </SelectItem>
                    {REMINDER_DAYS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value.toString()}>
                        {label(option.labels)}
                      </SelectItem>
                    ))}
                    <SelectItem value={COLLECTION_REMINDER_CUSTOM_VALUE}>
                      {t("subscription.costSharing.collectionReminderCustom")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {collectionReminderValue === COLLECTION_REMINDER_CUSTOM_VALUE ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="whitespace-nowrap text-sm text-muted-foreground">
                    {t("subscription.costSharing.collectionReminderBefore")}
                  </span>
                  <NumericInput
                    name={id("costSharingCollectionReminderCustomDays")}
                    allowNegative={false}
                    decimalScale={0}
                    inputMode="numeric"
                    enterKeyHint="next"
                    placeholder={t("subscription.daysPlaceholder")}
                    value={collectionReminderCustomInput}
                    onRawValueChange={(value) => {
                      // 自定义输入允许空字符串过渡；真实 payload 只在可解析数字时同步到 costSharing。
                      setCollectionReminderCustomInput(value);
                      const parsed = parseNonNegativeIntegerInput(value);
                      if (parsed !== null) {
                        updateCollectionReminder({
                          ...(collectionReminder ?? defaultCollectionReminder()),
                          enabled: true,
                          reminderDays: parsed,
                        });
                      }
                    }}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? managerErrorId : undefined}
                    className="w-20 border-border bg-secondary"
                  />
                  <span className="text-sm text-muted-foreground">{t("subscription.daysUnit")}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <FieldError id={managerErrorId} message={displayError} />
        </div>
      </div>
      <div data-testid="cost-sharing-members-scroll" className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="grid gap-2.5">
          {members.map((member, index) => {
            return (
              <FormFieldRow
                key={member.id}
                alignAt="md"
                className="min-w-0 rounded-lg border border-border bg-secondary/30 p-3"
                rowClassName="md:grid-cols-[minmax(11rem,1fr)_minmax(9rem,10rem)_minmax(12rem,14rem)_2.25rem]"
              >
                <FormField
                  id={id(`costSharingMemberName-${member.id}`)}
                  label={t("subscription.costSharing.memberName")}
                  labelClassName="text-xs text-muted-foreground"
                >
                  {({ id: fieldId }) => (
                    <div className="grid min-w-0 gap-1.5">
                      <Input
                        ref={index === 0 ? initialMemberNameInputRef : undefined}
                        id={fieldId}
                        value={member.name}
                        onChange={(event) => updateMember(member.id, { name: event.target.value })}
                        aria-label={t("subscription.costSharing.memberName")}
                        className="h-9 border-border bg-secondary font-medium"
                      />
                      <Label htmlFor={id(`costSharingMemberNote-${member.id}`)} className="sr-only">
                        {t("subscription.costSharing.memberNote")}
                      </Label>
                      <Input
                        id={id(`costSharingMemberNote-${member.id}`)}
                        value={member.note ?? ""}
                        onChange={(event) => updateMember(member.id, { note: event.target.value })}
                        aria-label={t("subscription.costSharing.memberNote")}
                        placeholder={t("subscription.costSharing.memberNotePlaceholder")}
                        className="h-8 border-border bg-secondary text-sm text-muted-foreground placeholder:text-muted-foreground/70"
                      />
                    </div>
                  )}
                </FormField>
                <MemberJoinedDateField
                  id={id}
                  member={member}
                  value={member.joinedDate}
                  onChange={(value) => updateMember(member.id, { joinedDate: value })}
                  label={t("subscription.costSharing.memberJoinedDate")}
                  placeholder={t("subscription.placeholder.date")}
                  invalid={(joinedDateRequired && !member.joinedDate) || !costSharingMemberJoinedDateIsWithinRange(member, joinedDateRange)}
                  describedBy={displayError ? managerErrorId : undefined}
                  minDate={joinedDateRange.minDate ?? undefined}
                  maxDate={joinedDateRange.maxDate ?? undefined}
                  defaultMonth={member.joinedDate ?? joinedDateRange.minDate ?? joinedDateRange.maxDate ?? undefined}
                />
                {costSharing.splitMode === "custom" ? (
                  <FormField
                    id={id(`costSharingMemberAmount-${member.id}`)}
                    label={t("subscription.costSharing.customAmount")}
                    labelClassName="text-xs text-muted-foreground"
                  >
                    {({ id: fieldId }) => (
                      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] gap-1.5">
                        <NumericInput
                          id={fieldId}
                          name={id(`costSharingMemberAmount-${member.id}`)}
                          allowNegative={false}
                          allowedDecimalSeparators={[".", "。"]}
                          inputMode="decimal"
                          placeholder="0.00"
                          prefix={getCurrencyAmountPrefix(member.currency ?? formData.currency, locale)}
                          value={member.customAmount?.toString() ?? ""}
                          onRawValueChange={(value) => updateMember(member.id, { customAmount: value.trim() === "" ? undefined : parseMoneyInput(value) ?? undefined })}
                          className="h-9 min-w-0 border-border bg-secondary px-2 font-semibold sm:text-right"
                          aria-label={t("subscription.costSharing.customAmount")}
                        />
                        <MemberCurrencySelect
                          value={member.currency ?? formData.currency}
                          onValueChange={(value) => updateMember(member.id, { currency: value })}
                          options={currencyOptions}
                          ariaLabel={t("subscription.costSharing.memberCurrency")}
                          placeholder={t("subscription.placeholder.currency")}
                          searchPlaceholder={t("subscription.search.currency")}
                          emptyMessage={t("subscription.empty.currency")}
                        />
                      </div>
                    )}
                  </FormField>
                ) : (
                  <FormField
                    id={id(`costSharingMemberAmount-${member.id}`)}
                    labelSlot={(
                      <span
                        id={id(`costSharingMemberAmount-${member.id}-label`)}
                        className="text-xs text-muted-foreground"
                      >
                        {t("subscription.costSharing.customAmount")}
                      </span>
                    )}
                  >
                    {({ id: fieldId }) => (
                      <div
                        id={fieldId}
                        role="group"
                        aria-labelledby={id(`costSharingMemberAmount-${member.id}-label`)}
                        className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] gap-1.5"
                      >
                        <span className="flex min-h-9 min-w-0 items-center justify-end rounded-md bg-secondary px-2.5 py-2 text-right text-sm font-semibold leading-5 tabular-nums text-foreground">
                          <span className="max-w-full break-all">
                            {formatCurrencySymbolAmount(memberShareInCurrency(member), member.currency ?? formData.currency, locale)}
                          </span>
                        </span>
                        <MemberCurrencySelect
                          value={member.currency ?? formData.currency}
                          onValueChange={(value) => updateMember(member.id, { currency: value })}
                          options={currencyOptions}
                          ariaLabel={t("subscription.costSharing.memberCurrency")}
                          placeholder={t("subscription.placeholder.currency")}
                          searchPlaceholder={t("subscription.search.currency")}
                          emptyMessage={t("subscription.empty.currency")}
                        />
                      </div>
                    )}
                  </FormField>
                )}
                <FormFieldRowAction controlClassName="justify-self-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => removeMember(member.id)}
                    disabled={members.length <= 1}
                    aria-label={t("common.delete")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </FormFieldRowAction>
              </FormFieldRow>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CostSharingMemberDialog({
  open,
  onOpenChange,
  id,
  formData,
  update,
  currencyOptions,
  currencyConvert,
  notificationReminderDays,
  collectionReminderAllowed,
  error,
  manageMembersButtonRef,
  initialMemberNameInputRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  id: (name: string) => string;
  formData: SubscriptionFormState;
  update: CostSharingFieldUpdater;
  currencyOptions: SearchableSelectOption[];
  currencyConvert?: ((amount: number | string, fromCurrency: string, toCurrency: string) => number) | undefined;
  notificationReminderDays: number;
  collectionReminderAllowed: boolean;
  error?: string | undefined;
  manageMembersButtonRef: RefObject<HTMLButtonElement | null>;
  initialMemberNameInputRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t("common.close")}
        dismissMode="explicit"
        layout="frame"
        className="h5-dialog-frame h5-subscription-dialog-panel border-border bg-card p-0 sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          // 覆盖 Radix 默认焦点：打开后从首位成员开始编辑，关闭后显式回到调用入口，维持嵌套 modal 的焦点契约。
          event.preventDefault();
          initialMemberNameInputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          manageMembersButtonRef.current?.focus();
        }}
      >
        <DialogHeader data-subscription-cost-sharing-manager-header="" className="shrink-0 p-6 pb-0">
          <DialogTitle className="text-xl font-semibold">
            {t("subscription.costSharing.manageMembersTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("subscription.costSharing.manageMembersDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="h5-subscription-dialog-form overflow-hidden">
          <CostSharingMemberManagerView
            id={id}
            formData={formData}
            update={update}
            currencyOptions={currencyOptions}
            currencyConvert={currencyConvert}
            notificationReminderDays={notificationReminderDays}
            collectionReminderAllowed={collectionReminderAllowed}
            error={error}
            initialMemberNameInputRef={initialMemberNameInputRef}
          />
          <div
            data-subscription-cost-sharing-manager-footer=""
            className="flex shrink-0 justify-end border-t border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:p-6 md:pt-4"
          >
            <Button
              type="button"
              onClick={() => onOpenChange(false)}
              className="w-full bg-primary text-primary-foreground hover:bg-primary-glow sm:w-auto"
            >
              {t("subscription.costSharing.doneManagingMembers")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MemberJoinedDateField({
  id,
  member,
  value,
  onChange,
  label,
  placeholder,
  invalid,
  describedBy,
  minDate,
  maxDate,
  defaultMonth,
}: {
  id: (name: string) => string;
  member: CostSharingMember;
  value: CostSharingMember["joinedDate"];
  onChange: (value: CostSharingMember["joinedDate"]) => void;
  label: string;
  placeholder: string;
  invalid: boolean;
  describedBy?: string | undefined;
  minDate?: string | undefined;
  maxDate?: string | undefined;
  defaultMonth?: string | undefined;
}) {
  const fieldId = id(`costSharingMemberJoinedDate-${member.id}`);
  const labelId = id(`costSharingMemberJoinedDate-${member.id}-label`);
  const valueId = id(`costSharingMemberJoinedDate-${member.id}-value`);

  return (
    <FormField
      id={fieldId}
      label={label}
      labelId={labelId}
      labelClassName="text-xs text-muted-foreground"
      describedBy={describedBy}
    >
      {({ id: resolvedId, describedBy: resolvedDescribedBy }) => (
        <DateOnlyPickerField
          id={resolvedId}
          labelId={labelId}
          valueId={valueId}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          invalid={invalid}
          describedBy={resolvedDescribedBy}
          minDate={minDate}
          maxDate={maxDate}
          defaultMonth={defaultMonth}
          buttonClassName="h-9 text-sm"
        />
      )}
    </FormField>
  );
}

function MemberCurrencySelect({
  value,
  onValueChange,
  options,
  ariaLabel,
  placeholder,
  searchPlaceholder,
  emptyMessage,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  ariaLabel: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
}) {
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      options={options}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyMessage={emptyMessage}
      className="h-9 border-border bg-secondary px-2 text-sm font-semibold"
      contentClassName="min-w-[16rem]"
      aria-label={ariaLabel}
      renderValue={(option) => (
        <span className="block truncate text-center tracking-wide">{option?.value ?? value}</span>
      )}
      renderOption={(option) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-medium">{option.value}</span>
          <span className="min-w-0 truncate text-muted-foreground">{option.label}</span>
        </span>
      )}
    />
  );
}
