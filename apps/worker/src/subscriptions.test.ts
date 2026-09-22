// Worker 订阅 mapper 测试保护 D1 行契约，避免新增字段在 create/update/import/export 边界漂移。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  subscriptionCollectionContractFixture,
  subscriptionNormalizationFixtures,
} from "@renewlet/shared/contract-fixtures";
import { isValidDateOnly, type DateOnly } from "@renewlet/shared/runtime";
import type { ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { readSuccessData } from "./api-test-helpers";
import { toApiSubscription, toApiSubscriptionCollectionItem } from "./db";
import { normalizeSubscriptionBodyForStorage, toSubscriptionRow, updateSubscription, type SubscriptionBody } from "./subscriptions";
import type { Env, SubscriptionRow } from "./types";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

const USER_ID = "usr_subscription_owner";

function dateOnly(value: string): DateOnly {
  if (!isValidDateOnly(value)) throw new Error(`Invalid test date: ${value}`);
  return value as DateOnly;
}

function subscriptionBody(overrides: Partial<SubscriptionBody> = {}): SubscriptionBody {
  return {
    name: "Three Year Plan",
    logo: null,
    price: "360",
    currency: "USD",
    billingCycle: "monthly",
    customDays: null,
    customCycleUnit: null,
    oneTimeTermCount: null,
    oneTimeTermUnit: null,
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: null,
    startDate: "2026-05-14",
    nextBillingDate: "2029-05-14",
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: null,
    website: null,
    notes: null,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    ...overrides,
  };
}

describe("Cloudflare subscription mapper", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset();
    authMocks.requireAuth.mockResolvedValue({
      user: { id: USER_ID },
      session: { id: "ses" },
    });
  });

  it.each(subscriptionNormalizationFixtures)("matches shared normalization fixture $name", (fixture) => {
    const body = subscriptionBody(fixture.input);
    const row = toSubscriptionRow("sub_fixture", "usr_fixture", body, "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");
    const apiSubscription = toApiSubscription(row);

    expect(row.custom_days).toBe(fixture.expected.customDays);
    expect(row.custom_cycle_unit).toBe(fixture.expected.customCycleUnit);
    expect(row.one_time_term_count).toBe(fixture.expected.oneTimeTermCount);
    expect(row.one_time_term_unit).toBe(fixture.expected.oneTimeTermUnit);
    expect(apiSubscription.autoRenew).toBe(fixture.expected.autoRenew);
    expect(apiSubscription.autoCalculateNextBillingDate).toBe(fixture.expected.autoCalculateNextBillingDate);
  });

  it.each(subscriptionCollectionContractFixture.collectionItems)(
    "maps the shared collection cycle fixture $id",
    (fixture) => {
      const row = toSubscriptionRow(fixture.id, USER_ID, subscriptionBody({
        name: fixture.name,
        logo: fixture.logo ?? null,
        price: fixture.price,
        currency: fixture.currency,
        billingCycle: fixture.billingCycle,
        customDays: fixture.customDays ?? null,
        customCycleUnit: fixture.customCycleUnit ?? null,
        oneTimeTermCount: fixture.oneTimeTermCount ?? null,
        oneTimeTermUnit: fixture.oneTimeTermUnit ?? null,
        category: fixture.category,
        status: fixture.status,
        pinned: fixture.pinned,
        publicHidden: fixture.publicHidden,
        paymentMethod: fixture.paymentMethod ?? null,
        startDate: fixture.startDate,
        nextBillingDate: fixture.nextBillingDate,
        autoRenew: fixture.autoRenew,
        autoCalculateNextBillingDate: fixture.autoCalculateNextBillingDate,
        trialEndDate: fixture.trialEndDate ?? null,
        reminderDays: fixture.reminderDays,
        costSharing: fixture.costSharing ?? null,
      }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");

      expect(toApiSubscriptionCollectionItem(row)).toEqual(fixture);
    },
  );

  it("persists and exposes custom cycle units", () => {
    const row = toSubscriptionRow("sub_custom", "usr_custom", subscriptionBody({
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "year",
    }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");

    expect(row.custom_days).toBe(3);
    expect(row.custom_cycle_unit).toBe("year");
    expect(toApiSubscription(row)).toMatchObject({
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "year",
    });
  });

  it("rejects custom subscriptions without an explicit cycle unit", () => {
    expect(() => normalizeSubscriptionBodyForStorage(subscriptionBody({
      billingCycle: "custom",
      customDays: 45,
      customCycleUnit: null,
    }))).toThrow();
  });

  it("clears custom fields for fixed cycles", () => {
    const row = toSubscriptionRow("sub_monthly", "usr_custom", subscriptionBody({
      billingCycle: "monthly",
      customDays: 45,
      customCycleUnit: "week",
    }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");

    const apiSubscription = toApiSubscription(row);

    expect(row.custom_days).toBeNull();
    expect(row.custom_cycle_unit).toBeNull();
    expect(apiSubscription).not.toHaveProperty("customDays");
    expect(apiSubscription).not.toHaveProperty("customCycleUnit");
  });

  it("persists one-time fixed terms and exposes them through the API mapper", () => {
    const row = toSubscriptionRow("sub_one_time", "usr_custom", subscriptionBody({
      billingCycle: "one-time",
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
      customDays: 45,
      customCycleUnit: "week",
      autoCalculateNextBillingDate: true,
    }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");

    expect(row.custom_days).toBeNull();
    expect(row.custom_cycle_unit).toBeNull();
    expect(row.one_time_term_count).toBe(6);
    expect(row.one_time_term_unit).toBe("month");
    expect(row.auto_renew).toBe(0);
    expect(row.auto_calculate_next_billing_date).toBe(0);
    expect(toApiSubscription(row)).toMatchObject({
      billingCycle: "one-time",
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
      autoRenew: false,
      autoCalculateNextBillingDate: false,
    });
  });

  it("defaults D1 rows to manual renewal while preserving explicit auto renewal", () => {
    const manual = toSubscriptionRow("sub_manual", "usr_custom", subscriptionBody(), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");
    const auto = toSubscriptionRow("sub_auto", "usr_custom", subscriptionBody({
      autoRenew: true,
    }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");

    expect(manual.auto_renew).toBe(0);
    expect(toApiSubscription(manual)).toMatchObject({
      autoRenew: false,
    });
    expect(auto.auto_renew).toBe(1);
    expect(toApiSubscription(auto)).toMatchObject({
      autoRenew: true,
    });
  });

  it("persists disabled reminder days through the API mapper", () => {
    const row = toSubscriptionRow("sub_quiet", "usr_custom", subscriptionBody({
      reminderDays: -2,
    }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");

    expect(row.reminder_days).toBe(-2);
    expect(toApiSubscription(row)).toMatchObject({
      reminderDays: -2,
    });
  });

  it("accepts manual recurring subscriptions without a start date", () => {
    const body = normalizeSubscriptionBodyForStorage(subscriptionBody({
      startDate: null,
      nextBillingDate: "2026-06-21",
      autoCalculateNextBillingDate: false,
    }));
    const row = toSubscriptionRow("sub_unknown_start", "usr_custom", body, "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");

    expect(row.start_date).toBeNull();
    expect(toApiSubscription(row)).toMatchObject({
      startDate: null,
      nextBillingDate: "2026-06-21",
      autoCalculateNextBillingDate: false,
    });
  });

  it("rejects D1 rows that expose non date-only subscription response dates", () => {
    const row = toSubscriptionRow("sub_bad_date", "usr_custom", subscriptionBody(), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");

    expect(() => toApiSubscription({
      ...row,
      next_billing_date: "2029-05-14T00:00:00Z",
    })).toThrow();
    expect(() => toApiSubscription({
      ...row,
      trial_end_date: "05/14/2029",
    })).toThrow();
  });

  it("rejects missing start dates when automatic date calculation needs a start anchor", () => {
    expect(() => normalizeSubscriptionBodyForStorage(subscriptionBody({
      startDate: null,
      autoCalculateNextBillingDate: true,
    }))).toThrow();
  });

  it("rejects one-time subscriptions without a purchase date", () => {
    expect(() => normalizeSubscriptionBodyForStorage(subscriptionBody({
      billingCycle: "one-time",
      startDate: null,
      nextBillingDate: "2026-06-21",
      autoCalculateNextBillingDate: false,
    }))).toThrow();
  });

  it("persists public hidden through the API mapper", () => {
    const row = toSubscriptionRow("sub_private", "usr_custom", subscriptionBody({
      publicHidden: true,
    }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");

    expect(row.public_hidden).toBe(1);
    expect(toApiSubscription(row)).toMatchObject({
      publicHidden: true,
    });
  });

  it("round-trips cost sharing through the D1 row mapper", () => {
    const costSharing = {
      enabled: true,
      splitMode: "custom" as const,
      collectionReminder: { enabled: true, reminderDays: -1 },
      members: [
        { id: "partner", name: "Partner", currency: "USD", customAmount: "40", joinedDate: dateOnly("2026-05-08") },
        { id: "child", name: "Child", currency: "USD", customAmount: "60", joinedDate: dateOnly("2026-05-08") },
      ],
    };
    const row = toSubscriptionRow("sub_shared", "usr_custom", subscriptionBody({
      price: "100",
      startDate: "2026-05-08",
      nextBillingDate: "2026-06-08",
      costSharing,
    }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z", {
      settings: { timezone: "UTC", notificationReminderDays: 3 },
      referenceDate: "2026-06-05",
    });

    expect(row.cost_sharing_json).toBeDefined();
    expect(JSON.parse(row.cost_sharing_json ?? "{}")).toEqual(costSharing);
    expect(row.cost_sharing_collection_reminder_enabled).toBe(1);
    expect(row.cost_sharing_next_collection_reminder_date).toBe("2026-06-05");
    expect(toApiSubscription(row)).toMatchObject({ costSharing });
  });

  it("does not persist enabled collection reminders for one-time buyout rows", () => {
    const costSharing = {
      enabled: true,
      splitMode: "equal" as const,
      collectionReminder: { enabled: true, reminderDays: -1 },
      members: [{ id: "partner", name: "Partner", currency: "USD", joinedDate: dateOnly("2026-05-08") }],
    };

    expect(() => normalizeSubscriptionBodyForStorage(subscriptionBody({
      billingCycle: "one-time",
      autoCalculateNextBillingDate: false,
      oneTimeTermCount: null,
      oneTimeTermUnit: null,
      costSharing,
    }))).toThrow();

    const buyoutRow = toSubscriptionRow("sub_buyout", "usr_custom", subscriptionBody({
      billingCycle: "one-time",
      autoCalculateNextBillingDate: false,
      oneTimeTermCount: null,
      oneTimeTermUnit: null,
      costSharing,
    }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z", {
      settings: { timezone: "UTC", notificationReminderDays: 3 },
      referenceDate: "2026-06-05",
    });
    const fixedTermRow = toSubscriptionRow("sub_fixed_term", "usr_custom", subscriptionBody({
      billingCycle: "one-time",
      autoCalculateNextBillingDate: false,
      startDate: "2026-05-08",
      nextBillingDate: "2026-06-08",
      oneTimeTermCount: 1,
      oneTimeTermUnit: "month",
      costSharing,
    }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z", {
      settings: { timezone: "UTC", notificationReminderDays: 3 },
      referenceDate: "2026-06-05",
    });

    expect(buyoutRow.cost_sharing_collection_reminder_enabled).toBe(0);
    expect(buyoutRow.cost_sharing_next_collection_reminder_date).toBeNull();
    expect(fixedTermRow.cost_sharing_collection_reminder_enabled).toBe(1);
    expect(fixedTermRow.cost_sharing_next_collection_reminder_date).toBe("2026-06-05");
  });

  it("normalizes dirty tags_json while applying a subscription PATCH", async () => {
    const existing = {
      ...toSubscriptionRow("sub_dirty_tags", USER_ID, subscriptionBody({
        tags: ["legacy"],
        pinned: true,
        trialEndDate: "2026-06-20",
        extra: { import: { source: "wallos", sourceId: "wallos-1" } },
      }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z"),
      tags_json: "{dirty-json",
    } satisfies SubscriptionRow;
    let updateValues: unknown[] | null = null;
    let schedulerMutationValues: unknown[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            bind: (...values: unknown[]) => ({
              first: async <T>() => {
                if (sql.includes("FROM subscriptions")) return existing as T;
                if (sql.includes("SUM(CASE WHEN auto_renew")) return { auto_renew_count: 0, repeat_reminder_count: 0 } as T;
                return null;
              },
              all: async <T>() => {
                if (sql.includes("FROM subscriptions")) {
                  return { success: true, meta: {}, results: [existing] as T[] } as D1Result<T>;
                }
                return { success: true, meta: {}, results: [] as T[] } as D1Result<T>;
            },
            run: async () => {
              if (sql.includes("UPDATE subscriptions SET")) {
                updateValues = values;
              }
              if (sql.includes("UPDATE subscription_scheduler_state SET")) {
                schedulerMutationValues = values;
              }
              return { success: true, meta: { changes: 1 }, results: [] } as unknown as D1Result;
              },
            }),
          };
          return statement;
        },
        batch: async (statements: D1PreparedStatement[]) => {
          for (const statement of statements) {
            await statement.run();
          }
          return statements.map(() => ({ success: true, meta: { changes: 1 }, results: [] }) as unknown as D1Result);
        },
      } as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    } satisfies Env;

    const response = await updateSubscription(new Request("https://renewlet.test/api/app/subscriptions/sub_dirty_tags", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ notes: "updated" }),
    }), env, "sub_dirty_tags");
    const body = await readSuccessData<{ subscription: ApiSubscription }>(response);

    expect(response.status).toBe(200);
    expect(body.subscription.tags).toEqual([]);
    expect(body.subscription.pinned).toBe(true);
    expect(body.subscription.trialEndDate).toBe("2026-06-20");
    expect(body.subscription.extra).toEqual({ import: { source: "wallos", sourceId: "wallos-1" } });
    expect(updateValues?.[21]).toBe("[]");
    expect(schedulerMutationValues.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(schedulerMutationValues.at(-1)).toBe(USER_ID);
  });

  it("clears one-time term fields for recurring subscriptions", () => {
    const row = toSubscriptionRow("sub_monthly", "usr_custom", subscriptionBody({
      billingCycle: "monthly",
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
    }), "2026-06-05T00:00:00.000Z", "2026-06-05T00:00:00.000Z");

    const apiSubscription = toApiSubscription(row);

    expect(row.one_time_term_count).toBeNull();
    expect(row.one_time_term_unit).toBeNull();
    expect(apiSubscription).not.toHaveProperty("oneTimeTermCount");
    expect(apiSubscription).not.toHaveProperty("oneTimeTermUnit");
  });

  it("adds subscription columns through standalone migrations only", () => {
    // D1 migration 必须保持增量拆分；一键部署和本地 migration 都依赖旧库逐步补列，而不是重建初始表。
    const initialMigration = readFileSync(resolve("migrations/0001_initial.sql"), "utf8");
    const customUnitMigration = readFileSync(resolve("migrations/0007_subscription_custom_cycle_unit.sql"), "utf8");
    const oneTimeTermMigration = readFileSync(resolve("migrations/0008_subscription_one_time_term.sql"), "utf8");
    const publicStatusMigration = readFileSync(resolve("migrations/0009_public_status.sql"), "utf8");
    const autoRenewMigration = readFileSync(resolve("migrations/0010_subscription_auto_renew.sql"), "utf8");
    const logoIndexMigration = readFileSync(resolve("migrations/0014_subscription_logo_index.sql"), "utf8");
    const notificationIndexesMigration = readFileSync(resolve("migrations/0016_notification_scheduler_indexes.sql"), "utf8");
    const schedulerStateMigration = readFileSync(resolve("migrations/0017_subscription_scheduler_state.sql"), "utf8");
    const costSharingMigration = readFileSync(resolve("migrations/0018_subscription_cost_sharing.sql"), "utf8");
    const costSharingCurrentUserPayerMigration = readFileSync(resolve("migrations/0019_subscription_cost_sharing_current_user_payer.sql"), "utf8");
    const nullableStartDateMigration = readFileSync(resolve("migrations/0024_nullable_subscription_start_date.sql"), "utf8");
    const filterIndexesMigration = readFileSync(resolve("migrations/0026_subscription_filter_indexes.sql"), "utf8");
    const statsSourceMigration = readFileSync(resolve("migrations/0031_subscription_stats_source_updated_at.sql"), "utf8");
    const costSharingCollectionReminderMigration = readFileSync(resolve("migrations/0034_cost_sharing_collection_reminders.sql"), "utf8");
    const cycleFieldsMigration = readFileSync(resolve("migrations/0037_subscription_cycle_fields.sql"), "utf8");

    expect(initialMigration).not.toContain("custom_cycle_unit");
    expect(initialMigration).not.toContain("one_time_term");
    expect(initialMigration).not.toContain("public_hidden");
    expect(initialMigration).not.toContain("public_status_pages");
    expect(initialMigration).not.toContain("auto_renew");
    expect(initialMigration).not.toContain("cost_sharing_json");
    expect(initialMigration).not.toContain("cost_sharing_collection_reminder");
    expect(customUnitMigration.trim()).toBe("ALTER TABLE subscriptions ADD COLUMN custom_cycle_unit TEXT;");
    expect(oneTimeTermMigration.trim()).toBe([
      "ALTER TABLE subscriptions ADD COLUMN one_time_term_count INTEGER;",
      "ALTER TABLE subscriptions ADD COLUMN one_time_term_unit TEXT;",
    ].join("\n"));
    expect(publicStatusMigration).toContain("ALTER TABLE subscriptions ADD COLUMN public_hidden INTEGER NOT NULL DEFAULT 0;");
    expect(publicStatusMigration).toContain("CREATE TABLE IF NOT EXISTS public_status_pages");
    expect(autoRenewMigration).toContain("ALTER TABLE subscriptions ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0;");
    expect(autoRenewMigration).toContain("UPDATE subscriptions SET auto_renew = 0 WHERE billing_cycle = 'one-time';");
    expect(logoIndexMigration.trim()).toBe("CREATE INDEX IF NOT EXISTS idx_subscriptions_user_logo ON subscriptions (user_id, logo);");
    expect(notificationIndexesMigration).toContain("CREATE INDEX IF NOT EXISTS idx_subscriptions_user_auto_renew_due");
    expect(notificationIndexesMigration).toContain("CREATE INDEX IF NOT EXISTS idx_subscriptions_user_reminder_due");
    expect(notificationIndexesMigration).toContain("CREATE INDEX IF NOT EXISTS idx_subscriptions_user_trial_reminder");
    expect(notificationIndexesMigration).toContain("CREATE INDEX IF NOT EXISTS idx_subscriptions_user_repeat_reminder");
    expect(schedulerStateMigration).toContain("CREATE TABLE IF NOT EXISTS subscription_scheduler_state");
    expect(schedulerStateMigration).toContain("DROP INDEX IF EXISTS idx_subscriptions_user_auto_renew_due");
    expect(schedulerStateMigration).toContain("ON subscriptions (user_id, auto_renew, next_billing_date, id)");
    expect(schedulerStateMigration).toContain("DROP INDEX IF EXISTS idx_subscriptions_user_reminder_due");
    expect(schedulerStateMigration).toContain("ON subscriptions (user_id, next_billing_date, id)");
    expect(schedulerStateMigration).toContain("DROP INDEX IF EXISTS idx_subscriptions_user_trial_reminder");
    expect(schedulerStateMigration).toContain("ON subscriptions (user_id, trial_end_date, id)");
    expect(schedulerStateMigration).toContain("DROP INDEX IF EXISTS idx_subscriptions_user_repeat_reminder");
    expect(schedulerStateMigration).toContain("ON subscriptions (user_id, repeat_reminder_enabled, next_billing_date, id)");
    expect(schedulerStateMigration).toContain("idx_subscriptions_user_repeat_trial_reminder");
    expect(schedulerStateMigration).not.toContain("_v2");
    expect(schedulerStateMigration).not.toContain("legacy");
    expect(costSharingMigration.trim()).toBe("ALTER TABLE subscriptions ADD COLUMN cost_sharing_json TEXT NOT NULL DEFAULT '{}';");
    expect(costSharingCurrentUserPayerMigration).toContain("json_remove(cost_sharing_json, '$.payerMemberId', '$.selfMemberId')");
    expect(costSharingCurrentUserPayerMigration).toContain("json_remove(value, '$.included')");
    expect(costSharingCurrentUserPayerMigration).toContain("json_extract(value, '$.id') != json_extract(cost_sharing_json, '$.selfMemberId')");
    expect(nullableStartDateMigration).toContain("CREATE TABLE subscriptions_new");
    expect(nullableStartDateMigration).toContain("INSERT INTO subscriptions_new");
    expect(nullableStartDateMigration).toContain("ALTER TABLE subscriptions_new RENAME TO subscriptions");
    expect(nullableStartDateMigration).toContain("start_date TEXT,");
    expect(nullableStartDateMigration).toContain("CREATE INDEX IF NOT EXISTS idx_subscriptions_user_auto_renew_due");
    expect(nullableStartDateMigration).toContain("idx_subscriptions_user_repeat_trial_reminder");
    expect(filterIndexesMigration).toContain("idx_subscriptions_user_category_order");
    expect(filterIndexesMigration).toContain("ON subscriptions (user_id, category, created_at DESC, id DESC)");
    expect(filterIndexesMigration).toContain("idx_subscriptions_user_billing_cycle_order");
    expect(filterIndexesMigration).toContain("idx_subscriptions_user_currency_order");
    expect(filterIndexesMigration).toContain("idx_subscriptions_user_payment_method_order");
    expect(filterIndexesMigration).toContain("idx_subscriptions_user_pinned_order");
    expect(filterIndexesMigration).toContain("idx_subscriptions_user_public_hidden_order");
    expect(filterIndexesMigration).toContain("idx_subscriptions_user_reminder_mode_order");
    expect(filterIndexesMigration).toContain("idx_subscriptions_user_repeat_reminder_order");
    expect(statsSourceMigration).toContain("ALTER TABLE subscription_user_stats ADD COLUMN source_updated_at TEXT NOT NULL DEFAULT '';");
    expect(costSharingCollectionReminderMigration).toContain("ALTER TABLE subscriptions ADD COLUMN cost_sharing_collection_reminder_enabled INTEGER NOT NULL DEFAULT 0;");
    expect(costSharingCollectionReminderMigration).toContain("ALTER TABLE subscriptions ADD COLUMN cost_sharing_next_collection_reminder_date TEXT;");
    expect(costSharingCollectionReminderMigration).toContain("json_remove(cost_sharing_json, '$.collectionReminder.intervalMonths')");
    expect(costSharingCollectionReminderMigration).toContain("cost_sharing_next_collection_reminder_date = CASE");
    expect(costSharingCollectionReminderMigration).toContain("AND (billing_cycle != 'one-time' OR one_time_term_count IS NOT NULL)");
    expect(costSharingCollectionReminderMigration).toContain("CREATE INDEX IF NOT EXISTS idx_subscriptions_user_cost_sharing_collection_due");
    expect(costSharingCollectionReminderMigration).toContain("idx_subscriptions_user_reminder_date_due");
    expect(costSharingCollectionReminderMigration).toContain("idx_subscriptions_user_trial_reminder_date_due");
    expect(cycleFieldsMigration).toContain("SET custom_cycle_unit = 'day'");
    expect(cycleFieldsMigration).toContain("WHERE billing_cycle != 'custom'");
    expect(cycleFieldsMigration).toContain("WHERE billing_cycle != 'one-time'");
  });
});
