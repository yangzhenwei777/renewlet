import { labelsFromCatalog } from "@/i18n/label-messages";
import { labels, type LocalizedLabels } from "@/i18n/locales";
import type { ConfigItem } from "@/types/config";
import { CATEGORY_LABELS } from "@/types/subscription";
import { makeConfigItem, slugValue } from "./import-export-model";

const WALLOS_NO_CATEGORY_KEYS = new Set(["no category", "无分类", "無分類"]);

export const WALLOS_DEFAULT_CURRENCIES: Array<{ id: string; symbol: string; code: string }> = [
  { id: "1", symbol: "€", code: "EUR" },
  { id: "2", symbol: "$", code: "USD" },
  { id: "3", symbol: "¥", code: "JPY" },
  { id: "4", symbol: "лв", code: "BGN" },
  { id: "5", symbol: "Kč", code: "CZK" },
  { id: "6", symbol: "kr", code: "DKK" },
  { id: "7", symbol: "£", code: "GBP" },
  { id: "8", symbol: "Ft", code: "HUF" },
  { id: "9", symbol: "zł", code: "PLN" },
  { id: "10", symbol: "lei", code: "RON" },
  { id: "11", symbol: "kr", code: "SEK" },
  { id: "12", symbol: "Fr", code: "CHF" },
  { id: "13", symbol: "kr", code: "ISK" },
  { id: "14", symbol: "kr", code: "NOK" },
  { id: "15", symbol: "₽", code: "RUB" },
  { id: "16", symbol: "₺", code: "TRY" },
  { id: "17", symbol: "$", code: "AUD" },
  { id: "18", symbol: "R$", code: "BRL" },
  { id: "19", symbol: "$", code: "CAD" },
  { id: "20", symbol: "¥", code: "CNY" },
  { id: "21", symbol: "HK$", code: "HKD" },
  { id: "22", symbol: "Rp", code: "IDR" },
  { id: "23", symbol: "₪", code: "ILS" },
  { id: "24", symbol: "₹", code: "INR" },
  { id: "25", symbol: "₩", code: "KRW" },
  { id: "26", symbol: "Mex$", code: "MXN" },
  { id: "27", symbol: "RM", code: "MYR" },
  { id: "28", symbol: "NZ$", code: "NZD" },
  { id: "29", symbol: "₱", code: "PHP" },
  { id: "30", symbol: "S$", code: "SGD" },
  { id: "31", symbol: "฿", code: "THB" },
  { id: "32", symbol: "R", code: "ZAR" },
  { id: "33", symbol: "₴", code: "UAH" },
  { id: "34", symbol: "NT$", code: "TWD" },
];

export const WALLOS_DEFAULT_CURRENCY_BY_ID = new Map<string, string>(
  WALLOS_DEFAULT_CURRENCIES.map((item) => [item.id, item.code]),
);

export const WALLOS_SYMBOL_DEFAULT_CURRENCY = new Map<string, string>([
  ["¥", "CNY"],
  ["$", "USD"],
]);

const WALLOS_PAYMENT_METHOD_BY_NAME: Record<string, string> = {
  alipay: "alipay",
  wechat: "wechat",
  "wechat pay": "wechat",
  "credit card": "credit_card",
  "debit card": "debit_card",
  paypal: "paypal",
  "apple pay": "apple_pay",
  "google pay": "google_pay",
  "bank transfer": "bank_transfer",
  crypto: "crypto",
  cryptocurrency: "crypto",
  "direct debit": "direct_debit",
  money: "money",
  cash: "money",
  "samsung pay": "samsung_pay",
  klarna: "klarna",
  "amazon pay": "amazon_pay",
  amazonpay: "amazon_pay",
  sepa: "sepa",
  skrill: "skrill",
  sofort: "sofort",
  stripe: "stripe",
  affirm: "affirm",
  elo: "elo",
  "facebook pay": "facebook_pay",
  facebookpay: "facebook_pay",
  "meta pay": "facebook_pay",
  metapay: "facebook_pay",
  giropay: "giropay",
  "giro pay": "giropay",
  ideal: "ideal",
  "i deal": "ideal",
  "union pay": "union_pay",
  unionpay: "union_pay",
  interac: "interac",
  paysafe: "paysafe",
  poli: "poli",
  qiwi: "qiwi",
  shoppay: "shop_pay",
  "shop pay": "shop_pay",
  venmo: "venmo",
  verifone: "verifone",
  webmoney: "webmoney",
  "web money": "webmoney",
  other: "other",
};

// Wallos 默认分类在其源码中以英文落库；这里只为固定来源补双语 label，不改 Renewlet 内置分类，也不猜用户自定义翻译。
const WALLOS_DEFAULT_CATEGORY_LABELS = new Map<string, LocalizedLabels>([
  ["entertainment", CATEGORY_LABELS.entertainment],
  ["music", CATEGORY_LABELS.music],
  ["utilities", CATEGORY_LABELS.utilities],
  ["food & beverages", labelsFromCatalog("wallos.category.foodBeverages")],
  ["health & wellbeing", labelsFromCatalog("wallos.category.healthWellbeing")],
  ["productivity", CATEGORY_LABELS.productivity],
  ["banking", labelsFromCatalog("wallos.category.banking")],
  ["transport", labelsFromCatalog("wallos.category.transport")],
  ["education", CATEGORY_LABELS.education],
  ["insurance", labelsFromCatalog("wallos.category.insurance")],
  ["gaming", CATEGORY_LABELS.gaming],
  ["news & magazines", labelsFromCatalog("wallos.category.newsMagazines")],
  ["software", labelsFromCatalog("wallos.category.software")],
  ["technology", labelsFromCatalog("wallos.category.technology")],
  ["cloud services", labelsFromCatalog("wallos.category.cloudServices")],
  ["charity & donations", labelsFromCatalog("wallos.category.charityDonations")],
]);

export function wallosCategoryFromName(name: string): { value: string; item?: ConfigItem } {
  const label = name.trim();
  const key = normalizedWallosCategoryName(label);
  if (!label || WALLOS_NO_CATEGORY_KEYS.has(key)) return { value: "other" };
  const value = slugValue("wallos_category", label);
  return { value, item: makeWallosCategoryConfigItem(value, label) };
}

export function wallosPaymentMethodValue(name: string): string | undefined {
  const label = name.trim();
  const normalized = label.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return WALLOS_PAYMENT_METHOD_BY_NAME[normalized] ?? (label ? slugValue("wallos_payment", label) : undefined);
}

function makeWallosCategoryConfigItem(value: string, label: string): ConfigItem {
  const itemLabels = WALLOS_DEFAULT_CATEGORY_LABELS.get(normalizedWallosCategoryName(label)) ?? labels(label, label);
  return {
    id: value,
    value,
    labels: { ...itemLabels },
  };
}

function normalizedWallosCategoryName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
