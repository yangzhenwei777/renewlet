import { describe, expect, it } from "vitest";
import { CronBudget, CronBudgetExceeded, CRON_SUBSCRIPTION_PAGE_SIZE } from "./cron-budget";
import { claimCronAccount, cronCheckpoint, cronClaimGuard, enqueueDueCronAccounts, releaseCronClaim } from "./cron-progress";
import { planAutoRenewalPage } from "./subscription-renewal";
import { subscriptionDerivedBulkMutationPlan } from "./subscription-derived-state";
import { subscriptionRow } from "./subscription-d1-test-support";
import { createCronFixture as fixture, scheduledAt, settings } from "./cron-test-support";



describe("Cron progress and Free SQL budget", () => {
  it.each([20, 100, 150, 1000])("fairly resumes %i accounts without replacing the original window", async (size) => {
    const { db, env, ids } = fixture(size);
    try {
      const actual: string[] = [];
      for (let tick = 0; tick < size; tick++) {
        const budget = new CronBudget();
        const bounded = { ...env, DB: budget.database(env.DB) };
        const now = new Date(scheduledAt.getTime() + tick * 60_000);
        await enqueueDueCronAccounts(bounded, now);
        const claim = await claimCronAccount(bounded, now);
        if (!claim) throw new Error("Missing due account");
        expect(Date.parse(claim.scheduled_at_utc)).toBe(scheduledAt.getTime());
        actual.push(claim.user_id);
        await releaseCronClaim(bounded, claim);
        expect(budget.used.sql).toBe(3);
      }
      expect(actual).toEqual(ids);
      expect(db.prepare("SELECT COUNT(*) AS n FROM cron_progress").get()?.["n"]).toBe(size);
    } finally { db.close(); }
  });

  it("allows only one claim, fences superseded writes and cascades account deletion", async () => {
    const { db, env, ids } = fixture(1);
    try {
      await enqueueDueCronAccounts(env, scheduledAt);
      const claims = await Promise.all(Array.from({ length: 8 }, () => claimCronAccount(env, scheduledAt)));
      const winners = claims.filter((claim) => claim !== null);
      expect(winners).toHaveLength(1);
      const original = winners[0];
      if (!original) throw new Error("Missing winner");
      const resumed = await claimCronAccount(env, new Date(scheduledAt.getTime() + 16 * 60_000));
      if (!resumed) throw new Error("Expired lease did not recover");
      expect(resumed.claim_token).not.toBe(original.claim_token);
      expect(resumed.scheduled_at_utc).toBe(original.scheduled_at_utc);
      await expect(env.DB.batch([cronClaimGuard(env, original), cronCheckpoint(env, original, "notification")])).rejects.toThrow();
      expect(db.prepare("SELECT phase, claim_token FROM cron_progress").get()).toMatchObject({ phase: "renewal", claim_token: resumed.claim_token });
      db.prepare("DELETE FROM users WHERE id = ?").run(ids[0] ?? "");
      expect(db.prepare("SELECT COUNT(*) AS n FROM cron_progress").get()?.["n"]).toBe(0);
    } finally { db.close(); }
  });

  it("uses an owner-scoped ID range without sorting renewal candidates", async () => {
    const { db } = fixture(1);
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM subscriptions
        WHERE user_id = ? AND id > ? AND auto_renew = 1
          AND billing_cycle IN ('weekly', 'monthly', 'quarterly', 'semi-annual', 'annual', 'custom')
          AND next_billing_date < ? AND status IN ('active', 'trial') ORDER BY id LIMIT ?`)
        .all("usr-0000", "sub-0500", "2026-09-08", 50).map((row) => String(row["detail"]));
      expect(plan.some((step) => /SEARCH subscriptions.*user_id=\?.*id>\?/.test(step))).toBe(true);
      expect(plan.some((step) => /SCAN subscriptions|TEMP B-TREE/.test(step))).toBe(false);
    } finally { db.close(); }
  });

  it("counts every batch statement and keeps SQL available for a checkpoint", async () => {
    const { db, env } = fixture(1);
    try {
      const budget = new CronBudget();
      const business = budget.database(env.DB, 2);
      await business.batch(Array.from({ length: 48 }, () => business.prepare("SELECT 1")));
      expect(budget.used.sql).toBe(48);
      expect(() => business.prepare("SELECT 1").first()).toThrow(CronBudgetExceeded);
      const progress = budget.database(env.DB);
      await progress.batch([progress.prepare("SELECT 1"), progress.prepare("SELECT 1")]);
      expect(budget.used.sql).toBe(50);
      expect(() => progress.prepare("SELECT 1").first()).toThrow(CronBudgetExceeded);
    } finally { db.close(); }
  });

  it("renews 1000 subscriptions across restarts, committing facts and cursor together", async () => {
    const { db, env, ids } = fixture(1);
    const userId = ids[0];
    if (!userId) throw new Error("Missing owner");
    try {
      for (let start = 0; start < 1000; start += 100) {
        const mutations = Array.from({ length: 100 }, (_, index) => ({
          before: null,
          after: subscriptionRow(`sub-${String(start + index).padStart(4, "0")}`, { user_id: userId, auto_renew: 1, start_date: "2026-08-01", next_billing_date: "2026-08-01" }),
          kind: "create" as const,
        }));
        const plan = subscriptionDerivedBulkMutationPlan(env, mutations, settings, scheduledAt);
        await env.DB.batch([...plan.beforeFact, plan.fact, ...plan.afterFact]);
      }
      await enqueueDueCronAccounts(env, scheduledAt);
      let updated = 0;
      for (let tick = 0; tick < 21; tick++) {
        const budget = new CronBudget();
        const bounded = { ...env, DB: budget.database(env.DB) };
        const claim = await claimCronAccount(bounded, new Date(scheduledAt.getTime() + tick * 60_000));
        if (!claim) throw new Error("Missing renewal continuation");
        const page = await planAutoRenewalPage(bounded, userId, settings, new Date(claim.scheduled_at_utc), claim.subscription_after_id, CRON_SUBSCRIPTION_PAGE_SIZE);
        const statements = [cronClaimGuard(bounded, claim), ...page.statements, cronCheckpoint(bounded, claim, page.complete ? "notification" : "renewal", page.afterId)];
        if (tick === 0) {
          db.exec("CREATE TRIGGER fail_cron_checkpoint BEFORE UPDATE ON cron_progress WHEN NEW.claim_token IS NULL BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END");
          await expect(bounded.DB.batch(statements)).rejects.toThrow("fixture interruption");
          expect(db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE next_billing_date != '2026-08-01'").get()?.["n"]).toBe(0);
          expect(db.prepare("SELECT subscription_after_id FROM cron_progress").get()?.["subscription_after_id"]).toBe("");
          db.exec("DROP TRIGGER fail_cron_checkpoint");
        }
        await bounded.DB.batch(statements);
        updated += page.updated;
        expect(budget.used.sql).toBeLessThanOrEqual(50);
      }
      expect(updated).toBe(1000);
      expect(db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE next_billing_date = '2026-10-01'").get()?.["n"]).toBe(1000);
      expect(db.prepare("SELECT COUNT(*) AS n FROM subscription_list_index WHERE next_billing_date = '2026-10-01'").get()?.["n"]).toBe(1000);
      expect(db.prepare("SELECT phase FROM cron_progress").get()?.["phase"]).toBe("notification");
    } finally { db.close(); }
  });
});
