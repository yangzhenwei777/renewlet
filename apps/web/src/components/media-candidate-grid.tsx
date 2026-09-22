import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MediaCandidate, MediaCandidateGroup } from "@/lib/api/schemas/media";
import { MediaThumbnailButton } from "@/components/media-thumbnail-button";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";

const THE_SVG_VARIANT_LABEL_KEYS: Record<string, MessageKey> = {
  "16": "media.variant.16",
  "32": "media.variant.32",
  "64": "media.variant.64",
  color: "media.variant.color",
  dark: "media.variant.dark",
  default: "media.variant.default",
  icon: "media.variant.icon",
  light: "media.variant.light",
  line: "media.variant.line",
  lockup: "media.variant.lockup",
  lockupDark: "media.variant.lockupDark",
  mono: "media.variant.mono",
  wordmark: "media.variant.wordmark",
  wordmarkDark: "media.variant.wordmarkDark",
  wordmarkLight: "media.variant.wordmarkLight",
};

const BUILT_IN_PROVIDER_LABEL_KEYS: Record<string, MessageKey> = {
  dashboardIcons: "media.provider.dashboardIcons",
  selfhst: "media.provider.selfhst",
  thesvg: "media.provider.thesvg",
};

const BUILT_IN_PROVIDER_FILTER_LABEL_KEYS: Record<string, MessageKey> = {
  dashboardIcons: "media.providerFilter.dashboardIcons",
  selfhst: "media.providerFilter.selfhst",
  thesvg: "media.provider.thesvg",
};

const BUILT_IN_PROVIDER_ORDER = ["thesvg", "selfhst", "dashboardIcons"] as const;
const ALL_PROVIDERS_FILTER = "__all__";

type ProviderFilter = typeof ALL_PROVIDERS_FILTER | string;

interface MediaCandidateGridProps {
  /** 后端/Worker 已按契约分组的候选；前端只做 provider 过滤和展示，不重新推断来源。 */
  candidates: MediaCandidateGroup;
  /** 当前选中 URL，可能来自上传资产、外链或任一 provider 候选。 */
  selectedValue?: string | null | undefined;
  /** 选择后由调用方写入具体业务表单。 */
  onSelect: (candidate: MediaCandidate) => void;
  /** 图片加载失败会回传到搜索 hook 的本轮屏蔽集合，避免坏链接继续占位。 */
  onError: (candidate: MediaCandidate) => void;
  size?: "sm" | "md" | undefined;
  columnsClassName?: string | undefined;
}

/** MediaCandidateGrid 渲染统一媒体候选响应，并保留内置 provider 的本地筛选状态。 */
export function MediaCandidateGrid({
  candidates,
  selectedValue,
  onSelect,
  onError,
  size = "md",
  columnsClassName = "grid-cols-4",
}: MediaCandidateGridProps) {
  const { t } = useI18n();
  const [selectedProvider, setSelectedProvider] = useState<ProviderFilter>(ALL_PROVIDERS_FILTER);
  const providerOptions = useMemo(() => providerFilterOptions(candidates.builtIn), [candidates.builtIn]);
  const providerSet = useMemo(() => new Set(providerOptions.map((option) => option.provider)), [providerOptions]);
  const activeProvider = selectedProvider !== ALL_PROVIDERS_FILTER && providerSet.has(selectedProvider)
    ? selectedProvider
    : ALL_PROVIDERS_FILTER;
  const filteredBuiltIn = activeProvider === ALL_PROVIDERS_FILTER
    ? candidates.builtIn
    : candidates.builtIn.filter((candidate) => candidate.provider === activeProvider);
  const showProviderFilters = providerOptions.length > 1;
  const hasCandidateSections = candidates.builtIn.length > 0 || candidates.appStore.length > 0 || candidates.favicon.length > 0;

  useEffect(() => {
    // provider 过滤只对当前响应有效；新搜索缺少旧 provider 时必须回到“全部”，否则用户会看到假空态。
    if (selectedProvider !== ALL_PROVIDERS_FILTER && !providerSet.has(selectedProvider)) {
      setSelectedProvider(ALL_PROVIDERS_FILTER);
    }
  }, [providerSet, selectedProvider]);

  if (!hasCandidateSections) return null;

  return (
    <div className="media-candidate-grid-sections grid gap-2">
      {candidates.builtIn.length > 0 ? (
        <CandidateSection
          title={t("media.builtInIcons")}
          columnsClassName={columnsClassName}
          filters={showProviderFilters ? (
            <BuiltInProviderFilterTags
              options={providerOptions}
              total={candidates.builtIn.length}
              selectedProvider={activeProvider}
              onSelect={setSelectedProvider}
              t={t}
            />
          ) : null}
        >
          {filteredBuiltIn.map((candidate) => (
            <MediaCandidateButton
              key={candidate.id}
              candidate={candidate}
              selected={selectedValue === candidate.url}
              onSelect={onSelect}
              onError={onError}
              size={size}
            />
          ))}
        </CandidateSection>
      ) : null}

      {/* 展示顺序跟 API 的 best 契约一致：内置 SVG 之后才是 App Store，favicon 始终留作弱兜底。 */}
      {candidates.appStore.length > 0 ? (
        <CandidateSection title={t("media.appStoreIcons")} columnsClassName={columnsClassName}>
          {candidates.appStore.map((candidate) => (
            <MediaCandidateButton
              key={candidate.id}
              candidate={candidate}
              selected={selectedValue === candidate.url}
              onSelect={onSelect}
              onError={onError}
              size={size}
            />
          ))}
        </CandidateSection>
      ) : null}

      {candidates.favicon.length > 0 ? (
        <CandidateSection title={t("media.faviconFallback")} columnsClassName={columnsClassName}>
          {candidates.favicon.map((candidate) => (
            <MediaCandidateButton
              key={candidate.id}
              candidate={candidate}
              selected={selectedValue === candidate.url}
              onSelect={onSelect}
              onError={onError}
              size={size}
            />
          ))}
        </CandidateSection>
      ) : null}
    </div>
  );
}

function BuiltInProviderFilterTags({
  options,
  total,
  selectedProvider,
  onSelect,
  t,
}: {
  options: ProviderFilterOption[];
  total: number;
  selectedProvider: ProviderFilter;
  onSelect: (provider: ProviderFilter) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <div
      role="group"
      className="media-provider-filter-scroll -mx-1 overflow-x-auto px-1"
      aria-label={t("media.providerFilter.ariaLabel")}
    >
      <div className="flex w-max max-w-full gap-1.5 pb-1 sm:w-auto sm:flex-wrap sm:pb-0">
        <ProviderFilterTag
          label={t("media.providerFilter.all")}
          count={total}
          selected={selectedProvider === ALL_PROVIDERS_FILTER}
          onClick={() => onSelect(ALL_PROVIDERS_FILTER)}
        />
        {options.map((option) => (
          <ProviderFilterTag
            key={option.provider}
            label={providerFilterLabel(option.provider, t)}
            count={option.count}
            selected={selectedProvider === option.provider}
            onClick={() => onSelect(option.provider)}
          />
        ))}
      </div>
    </div>
  );
}

function ProviderFilterTag({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected
          ? "border-primary/40 bg-primary/10 text-primary shadow-sm"
          : "border-border bg-secondary/60 text-muted-foreground hover:border-primary/30 hover:bg-primary/10 hover:text-foreground",
      )}
    >
      <span className="whitespace-nowrap">{label}</span>
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[10px] leading-none",
          selected ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function MediaCandidateButton({
  candidate,
  selected,
  onSelect,
  onError,
  size,
}: {
  candidate: MediaCandidate;
  selected: boolean;
  onSelect: (candidate: MediaCandidate) => void;
  onError: (candidate: MediaCandidate) => void;
  size: "sm" | "md";
}) {
  const { t } = useI18n();
  const label = mediaCandidateLabel(candidate, t);
  return (
    <MediaThumbnailButton
      src={candidate.url}
      alt={label}
      tooltip={label}
      selected={selected}
      onClick={() => onSelect(candidate)}
      onError={() => onError(candidate)}
      size={size}
    />
  );
}

interface ProviderFilterOption {
  provider: string;
  count: number;
}

function providerFilterOptions(candidates: readonly MediaCandidate[]): ProviderFilterOption[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.provider, (counts.get(candidate.provider) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([provider, count]) => ({ provider, count }))
    .sort((left, right) => providerRank(left.provider) - providerRank(right.provider) || left.provider.localeCompare(right.provider));
}

function providerRank(provider: string): number {
  const index = BUILT_IN_PROVIDER_ORDER.indexOf(provider as (typeof BUILT_IN_PROVIDER_ORDER)[number]);
  return index === -1 ? BUILT_IN_PROVIDER_ORDER.length : index;
}

function mediaCandidateLabel(candidate: MediaCandidate, t: (key: MessageKey, params?: Record<string, string | number>) => string): string {
  if (!candidate.variant) return candidate.label;
  const variantKey = THE_SVG_VARIANT_LABEL_KEYS[candidate.variant];
  const variantLabel = variantKey ? t(variantKey) : candidate.variant;
  if (candidate.source === "builtIn") {
    return t("media.providerVariantCandidateLabel", { label: candidate.label, provider: providerLabel(candidate.provider, t), variant: variantLabel });
  }
  return t("media.variantCandidateLabel", { label: candidate.label, variant: variantLabel });
}

function providerLabel(provider: string, t: (key: MessageKey, params?: Record<string, string | number>) => string): string {
  const providerKey = BUILT_IN_PROVIDER_LABEL_KEYS[provider];
  return providerKey ? t(providerKey) : provider;
}

function providerFilterLabel(provider: string, t: (key: MessageKey, params?: Record<string, string | number>) => string): string {
  const providerKey = BUILT_IN_PROVIDER_FILTER_LABEL_KEYS[provider];
  return providerKey ? t(providerKey) : provider;
}

function CandidateSection({
  title,
  filters,
  children,
  columnsClassName,
}: {
  title: string;
  filters?: ReactNode;
  children: ReactNode;
  columnsClassName: string;
}) {
  return (
    <section className="grid gap-2">
      <p className="text-xs text-muted-foreground">{title}</p>
      {filters}
      <div className={`grid gap-2 p-1 ${columnsClassName}`}>{children}</div>
    </section>
  );
}
