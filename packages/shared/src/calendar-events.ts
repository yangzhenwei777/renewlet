/**
 * 日历事件 mapper 只产出 Renewlet 稳定事件形状，不依赖 ICS 序列化库。
 *
 * 浏览器端在线日历链接也会使用这里的 UID/描述规则；不要把需要安全上下文的
 * ICS 序列化依赖重新引回本模块。
 */
import type { MoneyString } from "./money";

/** ICS 中的单个续费事件；date 始终是 YYYY-MM-DD，不是 datetime。 */
export interface RenewalCalendarEvent {
  uid: string;
  kind: "renewal" | "expiry";
  date: string;
  summary: string;
  description: string;
  categories?: string;
  url?: string;
  reminderDays?: number;
}

/** 生成日历事件所需的订阅窄视图，避免日历模块依赖完整 API subscription。 */
export interface RenewalCalendarSubscription {
  id: string;
  name: string;
  price: MoneyString;
  currency: string;
  billingCycle: string;
  oneTimeTermCount?: number | undefined;
  category: string;
  paymentMethod?: string | undefined;
  nextBillingDate: string;
  website?: string | undefined;
  notes?: string | undefined;
}

export interface RenewalCalendarEventLabels {
  amount: string;
  billingCycle: string;
  category: string;
  paymentMethod?: string | undefined;
}

/** 文案由调用方按用户 locale 传入，mapper 只负责稳定事件结构，不依赖运行时 i18n。 */
export interface RenewalCalendarEventText {
  amount: (value: { amount: string; currency: string }) => string;
  billingCycle: (cycle: string) => string;
  category: (category: string) => string;
  paymentMethod: (paymentMethod: string) => string;
  notes: (notes: string) => string;
}

export interface RenewalCalendarEventMapperOptions {
  subscription: RenewalCalendarSubscription;
  labels: RenewalCalendarEventLabels;
  reminderDays?: number | undefined;
  text: RenewalCalendarEventText;
}

export function buildRenewalCalendarEvent(options: RenewalCalendarEventMapperOptions): RenewalCalendarEvent {
  const { subscription, labels, reminderDays, text } = options;
  const kind = subscription.billingCycle === "one-time" ? "expiry" : "renewal";
  const lines = [
    text.amount({ amount: labels.amount, currency: subscription.currency }),
    text.billingCycle(labels.billingCycle),
    text.category(labels.category),
  ];
  if (labels.paymentMethod) {
    lines.push(text.paymentMethod(labels.paymentMethod));
  }
  if (subscription.notes?.trim()) {
    lines.push(text.notes(subscription.notes.trim()));
  }

  const event: RenewalCalendarEvent = {
    uid: `renewlet-${kind}-${subscription.id}@renewlet`,
    kind,
    date: subscription.nextBillingDate,
    summary: subscription.name,
    description: lines.join("\n"),
    categories: labels.category,
  };
  if (typeof reminderDays === "number") {
    event.reminderDays = reminderDays;
  }
  if (subscription.website) {
    event.url = subscription.website;
  }
  return event;
}
