import { matchesSearchableOption } from "@/lib/searchable-options";

export interface SubscriptionAdvancedFilterOption<T extends string = string> {
  value: T;
  label: string;
  keywords?: string[];
}

export interface AdvancedOptionListSections<T extends string = string> {
  allOptions: Array<SubscriptionAdvancedFilterOption<T>>;
}

interface AdvancedOptionListSectionParams<T extends string = string> {
  options: readonly SubscriptionAdvancedFilterOption<T>[];
}

interface AdvancedOptionListSearchParams<T extends string = string> {
  options: readonly SubscriptionAdvancedFilterOption<T>[];
  searchQuery: string;
}

interface AdvancedSelectionPreviewParams<T extends string = string> {
  values: readonly T[];
  options: readonly SubscriptionAdvancedFilterOption<T>[];
  separator: string;
  overflowLabel: (count: number) => string;
}

const ADVANCED_SELECTION_PREVIEW_LIMIT = 3;

export function getAdvancedOptionLabel(
  options: readonly SubscriptionAdvancedFilterOption[],
  value: string,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

export function getAdvancedOptionListSections<T extends string = string>({
  options,
}: AdvancedOptionListSectionParams<T>): AdvancedOptionListSections<T> {
  return { allOptions: [...options] };
}

export function getAdvancedSelectionPreview<T extends string = string>({
  values,
  options,
  separator,
  overflowLabel,
}: AdvancedSelectionPreviewParams<T>): string | undefined {
  if (values.length === 0) return undefined;

  const labels = values.map((value) => getAdvancedOptionLabel(options, value));
  const visibleLabels = labels.slice(0, ADVANCED_SELECTION_PREVIEW_LIMIT);
  const preview = visibleLabels.join(separator);
  const overflowCount = labels.length - visibleLabels.length;
  if (overflowCount <= 0) return preview;
  return `${preview} ${overflowLabel(overflowCount)}`;
}

export function getAdvancedOptionListSearchResults<T extends string = string>({
  options,
  searchQuery,
}: AdvancedOptionListSearchParams<T>): Array<SubscriptionAdvancedFilterOption<T>> {
  const trimmedSearch = searchQuery.trim();
  if (!trimmedSearch) return [];

  // 搜索只过滤当前可选全集，不能重排货币/支付方式这类由用户配置决定的业务顺序。
  return options.filter((option) => matchesSearchableOption(option, trimmedSearch));
}
