import type { CDPSession, Page, Request, Response, TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { labVitalsSnapshotSchema, type LabVitalsSample, type LabVitalsSnapshot } from "../../scripts/browser-performance";

interface DocumentVitals {
  snapshot(): Omit<LabVitalsSnapshot, "visibility"> & { visibility: DocumentVisibilityState };
  arm(): number;
  stop(): void;
}

const snapshotKey = "renewlet.e2e.document-vitals";

declare global {
  interface Window {
    __renewletLabVitals: DocumentVitals;
  }
}

function initializeDocumentVitals(vitals: Pick<typeof import("web-vitals"), "onLCP" | "onINP" | "onCLS">, key: string) {
  const unsupported = ["largest-contentful-paint", "event", "first-input", "layout-shift", "paint"]
    .filter((type) => !PerformanceObserver.supportedEntryTypes.includes(type));
  const initialVisibility = document.visibilityState;
  const values: Pick<LabVitalsSnapshot, "lcpMs" | "inpMs" | "cls"> = { lcpMs: null, inpMs: null, cls: null };
  let armed = false;
  window.__renewletLabVitals = {
    snapshot() {
      if (unsupported.length) throw new Error(`Unsupported document metrics: ${unsupported.join(", ")}`);
      if (initialVisibility !== "visible") throw new Error("Vitals document must start in the foreground");
      return { ...values, timeOrigin: performance.timeOrigin, visibility: document.visibilityState };
    },
    arm() {
      sessionStorage.removeItem(key);
      armed = true;
      return performance.timeOrigin;
    },
    stop() {
      armed = false;
      sessionStorage.removeItem(key);
    },
  };
  if (unsupported.length) return;
  // 缺失保留 null；未发生有效交互不能伪造 INP=0，CLS 的会话窗口也只由官方算法决定。
  vitals.onLCP((metric) => { values.lcpMs = metric.value; }, { reportAllChanges: true });
  vitals.onINP((metric) => { values.inpMs = metric.value; }, { reportAllChanges: true, durationThreshold: 16 });
  vitals.onCLS((metric) => { values.cls = metric.value; }, { reportAllChanges: true });
  // 官方库在交互后继续注册 capture 回调；冒泡阶段才能等它们排空，随后在隔离会话暂存旧文档快照。
  window.addEventListener("visibilitychange", (event) => {
    if (armed && event.isTrusted && document.visibilityState === "hidden") {
      sessionStorage.setItem(key, JSON.stringify(window.__renewletLabVitals.snapshot()));
      armed = false;
    }
  });
}

export async function installLabVitalsProbe(page: Page) {
  const library = readFileSync(join(dirname(require.resolve("web-vitals")), "web-vitals.iife.js"), "utf8");
  // 同一次注入保证库先于订阅执行；仅测试文档加载官方 IIFE，生产入口不引入遥测。
  await page.addInitScript({ content: `if (window === window.top) { ${library}\n;(${initializeDocumentVitals.toString()})(webVitals, ${JSON.stringify(snapshotKey)}); }` });
}

export async function waitForDocumentPaint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export async function finishLabVitals(page: Page): Promise<LabVitalsSnapshot> {
  await waitForDocumentPaint(page);
  const timeOrigin = await page.evaluate(() => window.__renewletLabVitals.arm());
  const failures: unknown[] = [];
  let snapshot: LabVitalsSnapshot | undefined;
  try {
    // Playwright 的焦点模拟使切标签仍可见；离开到同源只读 health 文档才产生可信的 hidden，且不加载另一份 SPA。
    await page.goto(new URL("/api/app/health", page.url()).href, { waitUntil: "domcontentloaded" });
    const saved = await page.evaluate((key) => sessionStorage.getItem(key), snapshotKey);
    if (!saved) throw new Error("Missing native hidden document snapshot");
    snapshot = labVitalsSnapshotSchema.parse(JSON.parse(saved));
    if (snapshot.timeOrigin !== timeOrigin) throw new Error("Document snapshot belongs to a different navigation");
  } catch (error) {
    failures.push(error);
  } finally {
    if (!page.isClosed()) await page.evaluate(() => window.__renewletLabVitals.stop()).catch((error: unknown) => { failures.push(error); });
  }
  if (failures.length) throw new AggregateError(failures, failures.map((error) => error instanceof Error ? error.message : String(error)).join("\n"));
  if (!snapshot) throw new Error("Missing hidden document snapshot");
  return snapshot;
}

async function rendererMetrics(session: CDPSession) {
  const { metrics } = await session.send("Performance.getMetrics");
  const read = (name: string) => {
    const value = metrics.find((metric) => metric.name === name)?.value;
    if (value === undefined || !Number.isFinite(value) || value < 0) throw new Error(`Missing renderer metric: ${name}`);
    return value;
  };
  return { taskSeconds: read("TaskDuration"), jsHeapUsedBytes: read("JSHeapUsedSize") };
}

export async function measureLabVitals(
  page: Page,
  testInfo: TestInfo,
  scenario: LabVitalsSample["scenario"],
  cache: LabVitalsSample["cache"],
  journey: () => Promise<void>,
) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Lab vitals require a fixed viewport");
  const sample: LabVitalsSample = {
    project: testInfo.project.name, scenario, cache, iteration: testInfo.repeatEachIndex,
    browser: page.context().browser()?.version() ?? "unknown", viewport,
    journey: "load-route;navigate-away;hide-document", vitals: null, resources: null, errors: [],
  };
  let session: CDPSession | undefined;
  const onResponse = (response: Response) => {
    if (response.status() >= 400) sample.errors.push(`HTTP ${response.status()}: ${response.request().method()} ${new URL(response.url()).pathname}`);
  };
  const onFailed = (request: Request) => {
    const failure = request.failure()?.errorText ?? "unknown request failure";
    // SPA 离开会取消读请求；只有既有 GET 取消语义可接受，其他传输失败必须留在该旅程。
    if (request.method() !== "GET" || failure !== "net::ERR_ABORTED") sample.errors.push(`${request.method()} ${new URL(request.url()).pathname}: ${failure}`);
  };
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  try {
    session = await page.context().newCDPSession(page);
    // threadTicks 只计 renderer 线程执行时间；它既不是墙钟时长，也不是 Go/Workers CPU 或进程峰值内存。
    await session.send("Performance.enable", { timeDomain: "threadTicks" });
    const before = await rendererMetrics(session);
    await journey();
    await waitForDocumentPaint(page);
    const after = await rendererMetrics(session);
    if (after.taskSeconds < before.taskSeconds) throw new Error("Renderer CPU counter reset during journey");
    sample.resources = { rendererTaskCpuMs: (after.taskSeconds - before.taskSeconds) * 1000, jsHeapUsedBytes: after.jsHeapUsedBytes };
    sample.vitals = await finishLabVitals(page);
    if (sample.vitals.lcpMs === null || sample.vitals.inpMs === null || sample.vitals.cls === null) {
      throw new Error("Missing document vitals after navigation interaction");
    }
  } catch (error) {
    sample.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    page.off("response", onResponse);
    page.off("requestfailed", onFailed);
    if (session) await session.detach().catch((error: unknown) => {
      sample.errors.push(error instanceof Error ? error.message : "Renderer session cleanup failed");
    });
    await testInfo.attach("lab-vitals-sample", { body: JSON.stringify(sample), contentType: "application/json" });
  }
  if (sample.errors.length) throw new Error(sample.errors.join("\n"));
}
