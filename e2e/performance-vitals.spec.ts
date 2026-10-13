import { expect, test } from "./support/test";
import { installPerformanceProbe, observeHttpCache, waitForPerformanceContent } from "./support/performance-browser";
import { installLabVitalsProbe, measureLabVitals, waitForDocumentPaint } from "./support/performance-vitals";
import { performanceEnvironmentSchema, performancePages } from "../scripts/browser-performance";

const routes = {
  dashboard: "/", subscriptions: "/subscriptions", statistics: "/statistics", calendar: "/calendar", settings: "/settings",
} as const;

test.use({ cacheExchangeRates: true });

test.beforeEach(async ({ page }, testInfo) => {
  const environment = performanceEnvironmentSchema.parse(testInfo.config.metadata["performance"]);
  await installPerformanceProbe(page, environment.fixtureDay);
  await installLabVitalsProbe(page);
  await page.bringToFront();
});

for (const route of performancePages) {
  for (const cache of ["cold-document", "warm-document"] as const) {
    test(`document vitals ${route}: ${cache}`, async ({ page }, testInfo) => {
      if (cache === "warm-document") {
        await page.goto(routes[route], { waitUntil: "domcontentloaded" });
        await waitForPerformanceContent(page, route);
        await page.goto("about:blank");
      }
      const observer = cache === "warm-document" ? await observeHttpCache(page) : undefined;
      try {
        await measureLabVitals(page, testInfo, route, cache, async () => {
          await page.goto(routes[route], { waitUntil: "domcontentloaded" });
          await waitForPerformanceContent(page, route);
          // 内容条件在 rAF 内成立时可能尚未 paint；首个交互前保留一次真实呈现机会，避免提前截断 LCP。
          await waitForDocumentPaint(page);
          const away = route === "dashboard" ? "subscriptions" : "dashboard";
          await page.locator(`header a[href="${routes[away]}"]:visible`).first().click();
          await waitForPerformanceContent(page, away);
        });
      } finally {
        if (observer) {
          const cacheHits = await observer.stop();
          await testInfo.attach("lab-vitals-http-cache", { body: JSON.stringify({ route, cacheHits }), contentType: "application/json" });
          expect(cacheHits.length, "warm vitals document must reuse cached asset bodies").toBeGreaterThan(0);
        }
      }
    });
  }
}
