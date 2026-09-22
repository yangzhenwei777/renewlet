/**
 * 自定义配置领域类型。
 *
 * 架构位置：Settings/CustomConfigContext/presentation 共享这些类型，远端 JSON 和 localStorage
 * 必须先经过 normalize-custom-config 再进入这个稳定结构。
 *
 * 注意： ConfigItem.value 会写入订阅记录；重命名或删除时要考虑已有 subscriptions 的引用。
 */
import { 
  BuiltInCategory,
  SUBSCRIPTION_STATUSES,
  SubscriptionStatus, 
  BuiltInPaymentMethod,
  CATEGORY_LABELS, 
  STATUS_LABELS, 
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  CURRENCY_OPTIONS,
  type CurrencyOption,
} from './subscription';
import { localizedLabel, type Locale, type LocalizedLabels } from "@/i18n/locales";
import { orderCurrencyItemsByCommonPriority } from "@/lib/currency-data";

export interface ConfigItem {
  id: string;
  /** 持久化到订阅的业务值，重命名等同于迁移历史订阅引用。 */
  value: string;
  labels: LocalizedLabels;
  color?: string | undefined;
  icon?: string | undefined;
  enabled?: boolean | undefined;
}

/**
 * 自定义配置（每个用户独立一份，保存到 PocketBase `custom_configs.config`）。
 *
 * 用途：
 * - 分类/状态/支付方式/货币：用于下拉选项、统计展示、以及一些 UI 的颜色/图标表现。
 */
export interface CustomConfig {
  /** 分类配置：可排序、可新增/编辑颜色。 */
  categories: ConfigItem[];
  /** 状态配置：只允许排序（与统计逻辑强相关）。 */
  statuses: ConfigItem[];
  /** 支付方式配置：可新增/编辑/排序，并可配置图标。 */
  paymentMethods: ConfigItem[];
  /** 货币配置：可启用/禁用（toggleMode）。 */
  currencies: ConfigItem[];
}

/**
 * 内置支付方式图标（多色 SVG，托管在 /public 下，跨平台部署无需额外依赖）。
 *
 * 说明：
 * - 这些是“官方默认支付方式”的固定图标：不允许在 UI 中删除/修改（仅允许排序）
 * - 用户自定义新增的支付方式可以上传/修改图标（存储到 PocketBase files）
 */
export const DEFAULT_PAYMENT_METHOD_ICONS: Record<BuiltInPaymentMethod, string> = {
  alipay: "/icons/payment-methods/alipay.svg",
  wechat: "/icons/payment-methods/wechat.svg",
  credit_card: "/icons/payment-methods/credit_card.svg",
  debit_card: "/icons/payment-methods/debit_card.svg",
  paypal: "/icons/payment-methods/paypal.svg",
  apple_pay: "/icons/payment-methods/apple_pay.svg",
  google_pay: "/icons/payment-methods/google_pay.svg",
  bank_transfer: "/icons/payment-methods/bank_transfer.svg",
  crypto: "/icons/payment-methods/crypto.svg",
  direct_debit: "/icons/payment-methods/direct_debit.svg",
  money: "/icons/payment-methods/money.svg",
  samsung_pay: "/icons/payment-methods/samsung_pay.svg",
  klarna: "/icons/payment-methods/klarna.svg",
  amazon_pay: "/icons/payment-methods/amazon_pay.svg",
  sepa: "/icons/payment-methods/sepa.svg",
  skrill: "/icons/payment-methods/skrill.svg",
  sofort: "/icons/payment-methods/sofort.svg",
  stripe: "/icons/payment-methods/stripe.svg",
  affirm: "/icons/payment-methods/affirm.svg",
  elo: "/icons/payment-methods/elo.svg",
  facebook_pay: "/icons/payment-methods/facebook_pay.svg",
  giropay: "/icons/payment-methods/giropay.svg",
  ideal: "/icons/payment-methods/ideal.svg",
  union_pay: "/icons/payment-methods/union_pay.svg",
  interac: "/icons/payment-methods/interac.svg",
  paysafe: "/icons/payment-methods/paysafe.svg",
  poli: "/icons/payment-methods/poli.svg",
  qiwi: "/icons/payment-methods/qiwi.svg",
  shop_pay: "/icons/payment-methods/shop_pay.svg",
  venmo: "/icons/payment-methods/venmo.svg",
  verifone: "/icons/payment-methods/verifone.svg",
  webmoney: "/icons/payment-methods/webmoney.svg",
  other: "/icons/payment-methods/other.svg",
};

const DEFAULT_PAYMENT_METHOD_VALUE_SET = new Set<string>(PAYMENT_METHODS as readonly string[]);

/** 判断某个 value 是否为内置支付方式（用于 UI 锁定与数据规范化）。 */
export function isBuiltInPaymentMethodValue(value: string): value is BuiltInPaymentMethod {
  return DEFAULT_PAYMENT_METHOD_VALUE_SET.has(value);
}

export function getConfigItemLabel(item: ConfigItem, locale: Locale): string {
  return localizedLabel(item.labels, locale);
}

const CATEGORY_COLORS: Record<BuiltInCategory, string> = {
  productivity: 'hsl(200 80% 50%)',
  entertainment: 'hsl(280 70% 55%)',
  lifestyle: 'hsl(35 90% 55%)',
  finance: 'hsl(160 84% 45%)',
  streaming: 'hsl(355 78% 58%)',
  music: 'hsl(320 70% 55%)',
  gaming: 'hsl(250 80% 60%)',
  utilities: 'hsl(210 18% 48%)',
  cloud_storage: 'hsl(205 85% 54%)',
  education: 'hsl(45 90% 52%)',
  health_fitness: 'hsl(145 70% 45%)',
  food_dining: 'hsl(18 85% 56%)',
  shopping: 'hsl(330 72% 56%)',
  travel: 'hsl(190 76% 45%)',
  business: 'hsl(225 58% 52%)',
  communication: 'hsl(175 68% 42%)',
  developer_tools: 'hsl(265 68% 58%)',
  design: 'hsl(12 78% 60%)',
  ai_tools: 'hsl(275 76% 62%)',
  security_vpn: 'hsl(350 75% 55%)',
  hosting_domains: 'hsl(32 86% 50%)',
  news_media: 'hsl(215 72% 55%)',
  other: 'hsl(220 12% 55%)',
};

const LEGACY_DEFAULT_CATEGORY_VALUES = ['productivity', 'entertainment', 'lifestyle', 'finance'] as const;
const LEGACY_DEFAULT_CATEGORY_VALUE_SET = new Set<string>(LEGACY_DEFAULT_CATEGORY_VALUES);

const STATUS_COLORS: Record<SubscriptionStatus, string> = {
  trial: 'hsl(45 90% 50%)',
  active: 'hsl(160 84% 45%)',
  expired: 'hsl(0 72% 51%)',
  paused: 'hsl(35 90% 55%)',
  cancelled: 'hsl(350 75% 55%)',
};
const DEFAULT_STATUS_VALUE_SET = new Set<string>(SUBSCRIPTION_STATUSES as readonly string[]);

export const getDefaultCategories = (): ConfigItem[] => {
  return Object.entries(CATEGORY_LABELS).map(([value, itemLabels]) => ({
    id: value,
    value,
    labels: itemLabels,
    color: CATEGORY_COLORS[value as BuiltInCategory],
  }));
};

export const getDefaultStatuses = (): ConfigItem[] => {
  return SUBSCRIPTION_STATUSES.map((value) => ({
    id: value,
    value,
    labels: STATUS_LABELS[value],
    color: STATUS_COLORS[value],
  }));
};

export const getDefaultPaymentMethods = (): ConfigItem[] => {
  return PAYMENT_METHODS.map((value) => ({
    id: value,
    value,
    labels: PAYMENT_METHOD_LABELS[value],
    icon: DEFAULT_PAYMENT_METHOD_ICONS[value],
  }));
};

/**
 * 获取默认货币配置（用于新用户初始化/重置兜底）。
 *
 * 规则：
 * - 货币列表来源：与汇率来源共同支持的货币范围保持一致（默认使用 `CURRENCY_OPTIONS`）
 * - 默认排序：优先把产品级常用 9 个币种置顶，其余保持汇率支持列表原顺序
 * - 默认启用：全部货币都 enabled=true（用户可在 UI 中自行禁用）
 */
export const getDefaultCurrencies = (
  options: readonly CurrencyOption[] = CURRENCY_OPTIONS,
): ConfigItem[] => {
  return orderCurrencyItemsByCommonPriority(options).map((option) => ({
    id: option.value,
    value: option.value,
    labels: option.labels,
    enabled: true,
  }));
};

function makeDefaultCurrencyItem(option: CurrencyOption): ConfigItem {
  return {
    id: option.value,
    value: option.value,
    labels: option.labels,
    enabled: true,
  };
}

export const DEFAULT_CUSTOM_CONFIG: CustomConfig = {
  categories: getDefaultCategories(),
  statuses: getDefaultStatuses(),
  paymentMethods: getDefaultPaymentMethods(),
  currencies: getDefaultCurrencies(),
};

function uniqByValue(items: ConfigItem[]): ConfigItem[] {
  const seen = new Set<string>();
  const normalized: ConfigItem[] = [];
  for (const item of items) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    normalized.push(item);
  }
  return normalized;
}

function isLegacyDefaultCategoryList(items: ConfigItem[]): boolean {
  return items.length === LEGACY_DEFAULT_CATEGORY_VALUES.length
    && items.every((item) => LEGACY_DEFAULT_CATEGORY_VALUE_SET.has(item.value));
}

function appendMissingDefaultCategories(items: ConfigItem[]): ConfigItem[] {
  const seen = new Set(items.map((item) => item.value));
  const defaults = getDefaultCategories();
  return [
    ...items,
    ...defaults.filter((item) => !seen.has(item.value)),
  ];
}

/**
 * 规范化分类列表：
 * - value 必须唯一（重复项保留首次出现）
 * - 至少保留 1 个分类（空列表回退到默认分类）
 * - 旧版默认 4 分类自动补齐为新版默认分类；自定义过的分类列表保持原样
 */
export function normalizeCategories(items: ConfigItem[]): ConfigItem[] {
  const unique = uniqByValue(items);
  if (unique.length === 0) return getDefaultCategories();
  return isLegacyDefaultCategoryList(unique) ? appendMissingDefaultCategories(unique) : unique;
}

/**
 * 规范化状态列表：
 * - 只保留内置状态，并用当前版本的 label/color 覆盖旧配置
 * - 保留旧版本/用户排序，同时补齐新增的内置状态
 */
export function normalizeStatuses(items: ConfigItem[]): ConfigItem[] {
  const defaults = getDefaultStatuses();
  // 状态配置会在登录/设置页反复规范化；Map/Set 让补齐和去重保持 O(n)，同时避免在循环里反复扫描默认列表。
  const defaultByValue = new Map(defaults.map((item) => [item.value, item]));
  const seen = new Set<string>();
  const normalized: ConfigItem[] = [];

  for (const item of items) {
    if (!DEFAULT_STATUS_VALUE_SET.has(item.value) || seen.has(item.value)) continue;
    seen.add(item.value);
    // 状态会参与统计/筛选逻辑，升级时只保留用户排序，不继承旧 label/color，避免 expired 缺色或被旧文案改名后语义漂移。
    const defaultItem = defaultByValue.get(item.value);
    if (!defaultItem) throw new Error(`Missing built-in subscription status: ${item.value}`);
    normalized.push(defaultItem);
  }

  // 旧版本没有 expired；这里追加缺失内置项，让老用户进入状态管理/表单/筛选时都能看到完整状态集。
  for (const item of defaults) {
    if (seen.has(item.value)) continue;
    normalized.push(item);
    seen.add(item.value);
  }

  return normalized;
}

/**
 * 规范化支付方式列表：
 * - 确保内置支付方式始终存在（不允许被删除）
 * - 内置支付方式的 label/icon 固定（不允许被自定义数据覆盖）
 * - 保留用户自定义新增项（可自定义 icon）
 * - 尽量保留用户拖拽后的排序（按传入数组顺序处理）
 */
export function normalizePaymentMethods(items: ConfigItem[]): ConfigItem[] {
  const defaults = getDefaultPaymentMethods();
  const defaultByValue = new Map<string, ConfigItem>(defaults.map((d) => [d.value, d]));

  const seen = new Set<string>();
  const normalized: ConfigItem[] = [];

  for (const item of items) {
    // 持久化字段 value 会写入订阅数据，必须唯一；重复项直接忽略后出现的。
    if (seen.has(item.value)) continue;
    seen.add(item.value);

    const fixed = defaultByValue.get(item.value);
    if (fixed) {
      normalized.push(fixed);
      continue;
    }
    normalized.push(item);
  }

  // 补齐缺失的内置项（按默认顺序追加到末尾）。
  for (const def of defaults) {
    if (seen.has(def.value)) continue;
    normalized.push(def);
    seen.add(def.value);
  }

  return normalized;
}

/**
 * 规范化货币列表（服务端/客户端统一兜底）。
 *
 * 目标：
 * - 货币列表受汇率来源共同支持范围控制：不允许“删掉某些货币”导致跨端不一致
 * - 自动补齐缺失货币（新增项默认 enabled=true）
 * - enabled 字段缺失时默认视为 true（与 UI 行为一致）
 * - 非空列表的顺序就是货币管理持久顺序，不能用支持列表或常用币种再排序
 */
export function normalizeCurrencies(
  items: ConfigItem[],
  options: readonly CurrencyOption[] = CURRENCY_OPTIONS,
): ConfigItem[] {
  if (items.length === 0) {
    return getDefaultCurrencies(options);
  }

  const optionByValue = new Map<string, CurrencyOption>(options.map((o) => [o.value, o]));

  const seen = new Set<string>();
  const normalized: ConfigItem[] = [];

  // 货币管理数组是全站展示顺序事实源；归一化只校正支持范围和 label，不重排用户保存过的顺序。
  for (const item of items) {
    const option = optionByValue.get(item.value);
    if (!option) continue;
    if (seen.has(item.value)) continue;
    seen.add(item.value);

    normalized.push({
      ...item,
      labels: option.labels,
      enabled: item.enabled !== false,
    });
  }

  if (normalized.length === 0) {
    return getDefaultCurrencies(options);
  }

  // 新增支持币种没有用户排序，只能按默认货币管理顺序追加到末尾，避免原始支持列表污染展示顺序。
  for (const option of orderCurrencyItemsByCommonPriority(options)) {
    if (seen.has(option.value)) continue;
    normalized.push(makeDefaultCurrencyItem(option));
    seen.add(option.value);
  }

  return normalized;
}
