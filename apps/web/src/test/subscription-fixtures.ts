import type {
  BillingCycle,
  CustomCycleUnit,
  SubscriptionCollectionItem,
} from "@/types/subscription";

type SubscriptionCycleKeys =
  | "billingCycle"
  | "customDays"
  | "customCycleUnit"
  | "oneTimeTermCount"
  | "oneTimeTermUnit";

type RecurringBillingCycle = Exclude<BillingCycle, "custom" | "one-time">;

export type SubscriptionCycleFixtureOverrides =
  | {
      billingCycle?: RecurringBillingCycle;
      customDays?: never;
      customCycleUnit?: never;
      oneTimeTermCount?: never;
      oneTimeTermUnit?: never;
    }
  | {
      billingCycle: "custom";
      customDays?: number;
      customCycleUnit?: CustomCycleUnit;
      oneTimeTermCount?: never;
      oneTimeTermUnit?: never;
    }
  | {
      billingCycle: "one-time";
      customDays?: never;
      customCycleUnit?: never;
      oneTimeTermCount?: never;
      oneTimeTermUnit?: never;
    }
  | {
      billingCycle: "one-time";
      customDays?: never;
      customCycleUnit?: never;
      oneTimeTermCount: number;
      oneTimeTermUnit: CustomCycleUnit;
    };

export type SubscriptionFixtureOverrides<T extends SubscriptionCollectionItem> =
  Partial<Omit<T, SubscriptionCycleKeys>> & SubscriptionCycleFixtureOverrides;

type SubscriptionCycleFixture =
  | {
      billingCycle: RecurringBillingCycle;
      customDays: undefined;
      customCycleUnit: undefined;
      oneTimeTermCount: undefined;
      oneTimeTermUnit: undefined;
    }
  | {
      billingCycle: "custom";
      customDays: number;
      customCycleUnit: CustomCycleUnit;
      oneTimeTermCount: undefined;
      oneTimeTermUnit: undefined;
    }
  | {
      billingCycle: "one-time";
      customDays: undefined;
      customCycleUnit: undefined;
      oneTimeTermCount: undefined;
      oneTimeTermUnit: undefined;
    }
  | {
      billingCycle: "one-time";
      customDays: undefined;
      customCycleUnit: undefined;
      oneTimeTermCount: number;
      oneTimeTermUnit: CustomCycleUnit;
    };

export function subscriptionCycleFixture(
  overrides: SubscriptionCycleFixtureOverrides = {},
): SubscriptionCycleFixture {
  if (overrides.billingCycle === "custom") {
    return {
      billingCycle: "custom",
      customDays: overrides.customDays ?? 30,
      customCycleUnit: overrides.customCycleUnit ?? "day",
      oneTimeTermCount: undefined,
      oneTimeTermUnit: undefined,
    };
  }
  if (overrides.billingCycle === "one-time") {
    if (typeof overrides.oneTimeTermCount === "number" && overrides.oneTimeTermUnit) {
      return {
        billingCycle: "one-time",
        customDays: undefined,
        customCycleUnit: undefined,
        oneTimeTermCount: overrides.oneTimeTermCount,
        oneTimeTermUnit: overrides.oneTimeTermUnit,
      };
    }
    return {
      billingCycle: "one-time",
      customDays: undefined,
      customCycleUnit: undefined,
      oneTimeTermCount: undefined,
      oneTimeTermUnit: undefined,
    };
  }
  return {
    billingCycle: overrides.billingCycle ?? "monthly",
    customDays: undefined,
    customCycleUnit: undefined,
    oneTimeTermCount: undefined,
    oneTimeTermUnit: undefined,
  };
}
