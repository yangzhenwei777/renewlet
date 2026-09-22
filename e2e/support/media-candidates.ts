import type { Page } from "@playwright/test";

type LogoCandidateFixture = {
  id: string;
  kind: "logo";
  source: "builtIn" | "favicon";
  provider: string;
  label: string;
  variant: string | null;
  url: string;
  confidence: "exact" | "strong" | "medium" | "weak";
  autoAssignable: boolean;
  matchedQuery: string;
  rank: number;
};

function makeLogoCandidate(index: number): LogoCandidateFixture {
  const source = index < 16 ? "builtIn" : "favicon";
  const fill = index % 2 === 0 ? "#14b8a6" : "#6366f1";
  const svg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${fill}"/><text x="32" y="40" text-anchor="middle" font-family="Arial" font-size="20" font-weight="700" fill="white">${index + 1}</text></svg>`,
  );
  return {
    id: `e2e-logo-${index + 1}`,
    kind: "logo",
    source,
    provider: source === "builtIn" ? "e2e-built-in" : "e2e-favicon",
    label: `Linear ${index + 1}`,
    variant: source === "builtIn" ? "default" : null,
    url: `data:image/svg+xml,${svg}`,
    confidence: source === "builtIn" ? "strong" : "weak",
    autoAssignable: false,
    matchedQuery: "Linear",
    rank: index,
  };
}

export async function installLogoCandidateRoute(page: Page, count = 40) {
  const candidates = Array.from({ length: count }, (_, index) => makeLogoCandidate(index));
  await page.route("**/api/app/media/candidates", async (route) => {
    const body = route.request().postDataJSON() as { items?: Array<{ id?: string }> } | null;
    const itemId = body?.items?.[0]?.id ?? "search";
    const builtIn = candidates.filter((candidate) => candidate.source === "builtIn");
    const favicon = candidates.filter((candidate) => candidate.source === "favicon");
    // E2E mock 必须完整贴合 shared media schema；appStore 即使为空也要出站，避免前端把 mock 漂移误判为真实搜索失败。
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          items: [
            {
              id: itemId,
              autoCandidate: null,
              candidates: {
                best: builtIn[0] ?? favicon[0] ?? null,
                builtIn,
                appStore: [],
                favicon,
              },
            },
          ],
        },
      }),
    });
  });
}
