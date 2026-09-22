import { describe, expect, it } from "vitest";
import { subscriptionFacetsQueryPlan } from "./subscription-facets";

describe("subscription facets query plan", () => {
  it("keeps every aggregate owner-scoped", () => {
    const plan = subscriptionFacetsQueryPlan("usr_facets_owner");

    for (const query of Object.values(plan)) {
      expect(query.sql).toContain("user_id = ?");
      expect(query.params).toEqual(["usr_facets_owner"]);
    }
    expect(plan.counts.sql).toContain("public_hidden = 0");
    expect(plan.categories.sql).toContain("GROUP BY category");
    expect(plan.tags.sql).toContain("GROUP BY tag");
  });
});
