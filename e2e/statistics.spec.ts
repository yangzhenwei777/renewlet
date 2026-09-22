// 统计页 E2E 保护 Recharts 容器尺寸和焦点样式；图表空尺寸警告在 jsdom 中不可见，必须用浏览器控制台捕获。
import type { ConsoleMessage } from "@playwright/test";
import { expect, test } from "./support/test";
import { createSubscription, uniqueE2EName } from "./support/subscriptions";

test("desktop statistics charts render without Recharts size warnings", async ({ page }, testInfo) => {
  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
  await createSubscription(page, {
    name: uniqueE2EName(testInfo, "Stats Chart"),
    price: "12",
  });

  const chartWarnings: string[] = [];
  const collectRechartsWarning = (message: ConsoleMessage) => {
    const text = message.text();
    if (
      text.includes("The width(") &&
      text.includes("height(") &&
      text.includes("chart should be greater than 0")
    ) {
      chartWarnings.push(text);
    }
  };

  page.on("console", collectRechartsWarning);
  await page.goto("/statistics");
  await expect(page.getByRole("heading", { name: "统计分析", level: 1 })).toBeVisible();

  const chartFrames = page.getByTestId("statistics-chart-frame");
  await expect(chartFrames).toHaveCount(3);
  const chartFrameMetrics = await chartFrames.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }),
  );

  for (const metric of chartFrameMetrics) {
    expect(metric.width, "statistics chart frame width").toBeGreaterThan(0);
    expect(metric.height, "statistics chart frame height").toBeGreaterThan(0);
  }

  const firstChartFrame = chartFrames.first();
  const firstChartSurface = firstChartFrame.locator(".recharts-surface");
  const firstChartSector = firstChartFrame.locator(".recharts-pie-sector").first();
  const firstChartSectorPath = firstChartFrame.locator(".recharts-sector").first();
  await expect(firstChartSurface).toHaveCount(1);
  await expect(firstChartSector).toBeVisible();
  await expect(firstChartSectorPath).toBeVisible();

  const readChartFocusState = async () =>
    await firstChartFrame.evaluate((frame) => {
      const selectors = [".recharts-surface", ".recharts-layer", ".recharts-pie", ".recharts-pie-sector", ".recharts-sector"];
      const activeElement = document.activeElement;
      const activeChartElement = activeElement instanceof Element && frame.contains(activeElement) ? activeElement : null;
      const frameStyle = window.getComputedStyle(frame);

      return {
        activeClassName: activeChartElement?.getAttribute("class") ?? "",
        activeFocusVisible: activeChartElement?.matches(":focus-visible") ?? false,
        activeInsideChartFrame: activeChartElement !== null,
        frameBoxShadow: frameStyle.boxShadow,
        frameOutlineStyle: frameStyle.outlineStyle,
        nodes: selectors.map((selector) => {
          const element = frame.querySelector(selector);
          const style = element ? window.getComputedStyle(element) : null;

          return {
            selector,
            exists: element !== null,
            focused: element === activeElement,
            focusVisible: element?.matches(":focus-visible") ?? false,
            outlineStyle: style?.outlineStyle ?? "",
            boxShadow: style?.boxShadow ?? "",
          };
        }),
      };
    });
  const expectNoLocalChartFocusBox = (
    state: Awaited<ReturnType<typeof readChartFocusState>>,
    context: string,
  ) => {
    for (const node of state.nodes.filter((item) => item.exists)) {
      expect(node.outlineStyle, `${context}: ${node.selector} should not show a browser focus rectangle`).toBe("none");
      expect(node.boxShadow, `${context}: ${node.selector} should not draw a local focus shadow`).toBe("none");
    }
  };

  const sectorBox = await firstChartSectorPath.boundingBox();
  expect(sectorBox, "chart sector path should expose a painted bounding box").not.toBeNull();
  if (!sectorBox) throw new Error("chart sector path should expose a painted bounding box");
  await page.mouse.click(sectorBox.x + sectorBox.width - 8, sectorBox.y + sectorBox.height / 2);
  const pointerFocusState = await readChartFocusState();

  expect(pointerFocusState.activeFocusVisible, "pointer click should not trigger keyboard focus styling").toBe(false);
  expect(pointerFocusState.frameBoxShadow, "pointer click should not show the keyboard focus ring").toBe("none");
  expectNoLocalChartFocusBox(pointerFocusState, "pointer click");

  await firstChartSector.evaluate((sector) => {
    if (sector instanceof HTMLElement || sector instanceof SVGElement) {
      sector.focus();
    }
  });
  const sectorFocusState = await readChartFocusState();
  expect(sectorFocusState.activeInsideChartFrame, "programmatic sector focus should stay inside the chart").toBe(true);
  expect(sectorFocusState.activeClassName).toContain("recharts-pie-sector");
  expect(sectorFocusState.frameBoxShadow, "sector focus should not show the keyboard frame ring").toBe("none");
  expectNoLocalChartFocusBox(sectorFocusState, "programmatic sector focus");

  await page.evaluate(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement || activeElement instanceof SVGElement) {
      activeElement.blur();
    }
  });

  let reachedChartByKeyboard = false;
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press("Tab");
    reachedChartByKeyboard = await firstChartSurface.evaluate((surface) => surface === document.activeElement);
    if (reachedChartByKeyboard) break;
  }
  expect(reachedChartByKeyboard, "statistics chart should stay reachable from the keyboard").toBe(true);

  const keyboardFocusState = await readChartFocusState();
  const surfaceFocusState = keyboardFocusState.nodes.find((node) => node.selector === ".recharts-surface");

  expect(surfaceFocusState?.focusVisible, "keyboard navigation should use :focus-visible").toBe(true);
  expect(keyboardFocusState.frameBoxShadow, "keyboard focus should move to the chart frame ring").not.toBe("none");
  expect(keyboardFocusState.frameOutlineStyle, "keyboard focus should not use the browser SVG outline").toBe("none");
  expectNoLocalChartFocusBox(keyboardFocusState, "keyboard chart focus");
  expect(chartWarnings).toEqual([]);
  page.off("console", collectRechartsWarning);
});
