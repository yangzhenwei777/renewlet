import { mock } from "node:test";
import { expect, test } from "./support/test";
import { finishLabVitals, installLabVitalsProbe, measureLabVitals, waitForDocumentPaint } from "./support/performance-vitals";
import { labVitalsSampleSchema, labVitalsSnapshotSchema } from "../scripts/browser-performance";

const probePath = "/performance-vitals-probe";

test.beforeEach(async ({ page }) => {
  await installLabVitalsProbe(page);
  await page.route(`**${probePath}`, (route) => route.fulfill({ contentType: "text/html", body: `
    <!doctype html><title>Document vitals probe</title>
    <div id="spacer"></div><h1>Painted document content</h1><button>Navigate</button>
    <script>
      document.querySelector('button').addEventListener('click', () => {
        // 有限的交互负载使自检跨过 Event Timing 的最小阈值，不靠自动化 sleep 伪造延迟。
        const interactionWorkMs = 40;
        const start = performance.now();
        while (performance.now() - start < interactionWorkMs) {}
        history.pushState({}, '', '/performance-vitals-away');
        document.querySelector('h1').textContent = 'Navigated document content';
      });
    </script>` }));
  await page.bringToFront();
});

test.afterEach(() => mock.restoreAll());

test("native hidden snapshot retains absent INP and observes layout shifts", async ({ page }) => {
  await page.goto(probePath);
  await waitForDocumentPaint(page);
  const painted = await page.waitForFunction(() => performance.getEntriesByName("first-contentful-paint").length > 0);
  await painted.dispose();
  await page.locator("#spacer").evaluate((element) => { element.style.height = "120px"; });
  await waitForDocumentPaint(page);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const pagesBefore = page.context().pages().length;
  const snapshot = await finishLabVitals(page);
  expect(snapshot.visibility).toBe("hidden");
  expect(snapshot.timeOrigin).toBe(timeOrigin);
  expect(snapshot.lcpMs).toBeGreaterThan(0);
  expect(snapshot.cls).toBeGreaterThan(0);
  expect(snapshot.inpMs).toBeNull();
  expect(page.context().pages()).toHaveLength(pagesBefore);
  expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
});

test("real click produces document vitals and renderer resource measurements", async ({ page }, testInfo) => {
  let timeOrigin = 0;
  const observation = { ...testInfo, attach: (_name: string, options: Parameters<typeof testInfo.attach>[1]) => testInfo.attach("vitals-probe-observation", options) };
  await measureLabVitals(page, observation, "dashboard", "cold-document", async () => {
    await page.goto(probePath);
    timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await waitForDocumentPaint(page);
    await page.getByRole("button", { name: "Navigate" }).click();
    await expect(page.getByRole("heading")).toHaveText("Navigated document content");
  });
  const body = testInfo.attachments.find((attachment) => attachment.name === "vitals-probe-observation")?.body;
  const sample = labVitalsSampleSchema.parse(JSON.parse(body?.toString() ?? "null"));
  expect(sample.errors).toEqual([]);
  expect(sample.vitals?.inpMs).toBeGreaterThan(0);
  expect(sample.vitals?.lcpMs).toBeGreaterThan(0);
  expect(sample.vitals?.cls).toBe(0);
  expect(sample.resources?.rendererTaskCpuMs).toBeGreaterThan(0);
  expect(sample.resources?.jsHeapUsedBytes).toBeGreaterThan(0);
  expect(sample.vitals?.timeOrigin).toBe(timeOrigin);
});

test("visible snapshots cannot finalize a baseline", async ({ page }) => {
  await page.goto(probePath);
  const snapshot = await page.evaluate(() => window.__renewletLabVitals.snapshot());
  expect(labVitalsSnapshotSchema.safeParse(snapshot).success).toBe(false);
});

test("native hidden flushes interaction reports queued after probe installation", async ({ page }) => {
  await page.goto(probePath);
  await waitForDocumentPaint(page);
  await page.evaluate(() => {
    // 确定性复现忙碌页面没有 idle 时段；官方库仍须通过真实 hidden 排空交互回调。
    let pending = 0;
    window.requestIdleCallback = () => {
      document.documentElement.dataset["pendingIdleReports"] = String(++pending);
      return pending;
    };
    window.cancelIdleCallback = () => {};
  });
  await page.getByRole("button", { name: "Navigate" }).click();
  await page.waitForFunction(() => Number(document.documentElement.dataset["pendingIdleReports"]) >= 2);
  expect(await page.evaluate(() => window.__renewletLabVitals.snapshot().inpMs)).toBeNull();
  const snapshot = await finishLabVitals(page);
  expect(snapshot.inpMs).toBeGreaterThan(0);
  expect(snapshot.lcpMs).toBeGreaterThan(0);
});

test("missing interaction fails the sample and retains its partial measurements", async ({ page }, testInfo) => {
  const observation = { ...testInfo, attach: (_name: string, options: Parameters<typeof testInfo.attach>[1]) => testInfo.attach("vitals-probe-observation", options) };
  await expect(measureLabVitals(page, observation, "dashboard", "cold-document", async () => {
    await page.goto(probePath);
    await waitForDocumentPaint(page);
  })).rejects.toThrow("Missing document vitals");
  const body = testInfo.attachments.find((attachment) => attachment.name === "vitals-probe-observation")?.body;
  const sample = labVitalsSampleSchema.parse(JSON.parse(body?.toString() ?? "null"));
  expect(sample.vitals?.inpMs).toBeNull();
  expect(sample.resources?.jsHeapUsedBytes).toBeGreaterThan(0);
  expect(sample.errors).toEqual(["Missing document vitals after navigation interaction"]);
});

test("failed finalization clears its snapshot and preserves the original error", async ({ page }) => {
  await page.goto(probePath);
  const pagesBefore = page.context().pages().length;
  mock.method(page, "goto", async () => { throw new Error("intentional visibility failure"); });
  await expect(finishLabVitals(page)).rejects.toThrow("intentional visibility failure");
  expect(page.context().pages()).toHaveLength(pagesBefore);
  expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
  expect(await page.evaluate(() => sessionStorage.getItem("renewlet.e2e.document-vitals"))).toBeNull();
});

test("failed journey retains an attachment and detaches its CPU session", async ({ page }, testInfo) => {
  const on = mock.method(page, "on");
  const off = mock.method(page, "off");
  const session = await page.context().newCDPSession(page);
  mock.method(page.context(), "newCDPSession", async () => session);
  const detach = mock.method(session, "detach");
  const observation = { ...testInfo, attach: (_name: string, options: Parameters<typeof testInfo.attach>[1]) => testInfo.attach("vitals-probe-observation", options) };
  await expect(measureLabVitals(page, observation, "dashboard", "cold-document", async () => {
    throw new Error("intentional journey failure");
  })).rejects.toThrow("intentional journey failure");
  expect(detach.mock.callCount()).toBe(1);
  for (const call of on.mock.calls) expect(off.mock.calls.map((removed) => removed.arguments)).toContainEqual(call.arguments);
  const body = testInfo.attachments.find((attachment) => attachment.name === "vitals-probe-observation")?.body;
  const sample = labVitalsSampleSchema.parse(JSON.parse(body?.toString() ?? "null"));
  expect(sample.vitals).toBeNull();
  expect(sample.resources).toBeNull();
  expect(sample.errors).toEqual(["intentional journey failure"]);
});
