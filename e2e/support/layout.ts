import { expect, type ElementHandle, type Locator, type Page } from "@playwright/test";

export async function getRequiredElementBoundingBox(
  element: ElementHandle<HTMLElement | SVGElement>,
  label: string,
) {
  const box = await element.boundingBox();
  if (!box) {
    throw new Error(`Missing bounding box for ${label}`);
  }
  return box;
}

export async function getRequiredLocatorBoundingBox(locator: Locator, label: string) {
  const element = await locator.elementHandle();
  if (!element) {
    throw new Error(`Missing element for ${label}`);
  }
  return getRequiredElementBoundingBox(element, label);
}

// 这类布局回归不会出现在 role/label 断言里：Radix 包装层、隐藏 input 或 chip field
// 变动都可能让 label 和控件视觉脱节，所以用真实 DOMRect 约束可见间距。
export async function expectLabelControlGap(control: Locator, label: string) {
  await expect(async () => {
    await expect(control, `${label}: control visible before layout measurement`).toBeVisible();
    await control.scrollIntoViewIfNeeded();
    const gap = await control.evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("Control is not an HTMLElement");
      }

      if (!element.id) {
        throw new Error("Control has no id for label lookup");
      }

      const labelElement = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`);
      if (!labelElement) {
        throw new Error(`Missing label for #${element.id}`);
      }

      const labelRect = labelElement.getBoundingClientRect();
      // tag 输入的可见控件是 chip field 外壳，原始 input 只是内部 autosize 光标。
      const visualControl =
        element instanceof HTMLInputElement
          ? element.closest<HTMLElement>('[data-slot="subscription-tag-field"]') ?? element
          : element;
      const controlRect = visualControl.getBoundingClientRect();
      return Math.round((controlRect.top - labelRect.bottom) * 100) / 100;
    });

    expect(gap, `${label}: label/control gap`).toBeGreaterThanOrEqual(7);
    expect(gap, `${label}: label/control gap`).toBeLessThanOrEqual(9);
  }, `${label}: stable label/control gap`).toPass();
}

export async function expectFormFieldRowAlignment(
  row: Locator,
  label: string,
  options: { action?: boolean } = {},
) {
  await expect(row, `${label}: row visible before layout measurement`).toBeVisible();
  await expect.poll(async () => row.evaluate((element, expectAction) => {
    const layout = element.firstElementChild;
    if (!(layout instanceof HTMLElement)) {
      throw new Error("Missing FormFieldRow layout");
    }

    const fields = Array.from(layout.children).filter((child): child is HTMLElement => (
      child instanceof HTMLElement && child.dataset.slot === "form-field"
    ));
    const labelTops = fields.map((field) => {
      const fieldLabel = field.querySelector<HTMLElement>('[data-slot="form-field-label"] label');
      if (!fieldLabel) throw new Error("Missing FormField label");
      return fieldLabel.getBoundingClientRect().top;
    });
    const controlTops = fields.map((field) => {
      const control = field.querySelector<HTMLElement>('[data-slot="form-field-control"]');
      if (!control) throw new Error("Missing FormField control");
      return control.getBoundingClientRect().top;
    });
    const action = layout.querySelector<HTMLElement>(
      ':scope > [data-slot="form-field-row-action"] > [data-slot="form-field-row-action-control"]',
    );
    if (expectAction && !action) throw new Error("Missing FormFieldRow action");
    const actionTop = action?.getBoundingClientRect().top;
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

    return spread(labelTops) <= 1
      && spread(controlTops) <= 1
      && (actionTop === undefined || Math.abs(actionTop - controlTops[0]!) <= 1);
  }, Boolean(options.action)), { message: `${label}: shared field tracks` }).toBe(true);
}

export async function expectFormFieldRowStacked(row: Locator, label: string) {
  await expect(row, `${label}: row visible before mobile layout measurement`).toBeVisible();
  const metrics = await row.evaluate((element) => {
    const layout = element.firstElementChild;
    if (!(layout instanceof HTMLElement)) {
      throw new Error("Missing FormFieldRow layout");
    }
    const children = Array.from(layout.children).filter((child): child is HTMLElement => (
      child instanceof HTMLElement && child.offsetParent !== null
    ));
    const rects = children.map((child) => child.getBoundingClientRect());
    return {
      ordered: rects.every((rect, index) => index === 0 || rect.top >= rects[index - 1]!.bottom - 1),
      overflow: Math.max(0, layout.scrollWidth - layout.clientWidth),
    };
  });

  expect(metrics.ordered, `${label}: fields and action follow mobile DOM order`).toBe(true);
  expect(metrics.overflow, `${label}: row horizontal overflow`).toBeLessThanOrEqual(1);
}

interface LayoutSnapshot {
  header: { x: number };
  content: { x: number };
  saveButton?: { x: number };
  rootOverflowY: string;
  rootScrollbarGutter: string;
  bodyScrollLocked: boolean;
}

export async function captureLayoutSnapshot(
  page: Page,
  targets: {
    content: Locator;
    saveButton?: ElementHandle<HTMLElement | SVGElement>;
  },
): Promise<LayoutSnapshot> {
  // 浮层打开时 Radix 可能把背景内容从可访问树隐藏，role 查询会失效；
  // 用稳定 testid 读取 DOMRect，专门验证 body scroll lock 不会推动固定布局。
  const [header, content, saveButton, scrollState] = await Promise.all([
    getRequiredLocatorBoundingBox(page.getByTestId("app-header"), "header layout target"),
    getRequiredLocatorBoundingBox(targets.content, "content layout target"),
    targets.saveButton ? getRequiredElementBoundingBox(targets.saveButton, "save button layout target") : undefined,
    page.evaluate(() => {
      const root = document.getElementById("root");
      if (!root) {
        throw new Error("Missing #root scroll container");
      }

      const rootStyle = window.getComputedStyle(root);
      return {
        rootOverflowY: rootStyle.overflowY,
        rootScrollbarGutter: rootStyle.scrollbarGutter,
        bodyScrollLocked: document.body.hasAttribute("data-scroll-locked"),
      };
    }),
  ]);

  return {
    header,
    content,
    saveButton,
    ...scrollState,
  };
}

export function expectRootScrollContainer(snapshot: LayoutSnapshot) {
  expect(snapshot.rootOverflowY).toBe("auto");
  expect(snapshot.rootScrollbarGutter).toContain("stable");
}

export async function expectNoHorizontalOverflow(page: Page, label: string) {
  const metrics = await page.evaluate(() => {
    const root = document.getElementById("root");
    if (!root) {
      throw new Error("Missing #root scroll container");
    }

    return {
      rootClientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    };
  });

  expect(metrics.rootScrollWidth - metrics.rootClientWidth, `${label}: #root horizontal overflow`).toBeLessThanOrEqual(1);
  expect(
    metrics.documentScrollWidth - metrics.documentClientWidth,
    `${label}: document horizontal overflow`,
  ).toBeLessThanOrEqual(1);
  expect(metrics.bodyScrollWidth - metrics.bodyClientWidth, `${label}: body horizontal overflow`).toBeLessThanOrEqual(1);
}

export async function expectTouchTarget(locator: Locator, label: string, minSize = 44) {
  const box = await getTouchTargetBoundingBox(locator, label);
  expect(box.width, `${label}: touch target width`).toBeGreaterThanOrEqual(minSize);
  expect(box.height, `${label}: touch target height`).toBeGreaterThanOrEqual(minSize);
}

export async function expectTouchTargetsDoNotOverlap(first: Locator, second: Locator, label: string) {
  const [firstBox, secondBox] = await Promise.all([
    getTouchTargetBoundingBox(first, `${label} first target`),
    getTouchTargetBoundingBox(second, `${label} second target`),
  ]);
  const overlapWidth = Math.max(
    0,
    Math.min(firstBox.x + firstBox.width, secondBox.x + secondBox.width) - Math.max(firstBox.x, secondBox.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(firstBox.y + firstBox.height, secondBox.y + secondBox.height) - Math.max(firstBox.y, secondBox.y),
  );
  expect(overlapWidth * overlapHeight, `${label}: touch target overlap area`).toBe(0);
}

async function getTouchTargetBoundingBox(locator: Locator, label: string) {
  await expect(locator, `${label}: target visible before layout measurement`).toBeVisible();
  const box = await locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Touch target is not an HTMLElement");
    }
    const rect = element.getBoundingClientRect();
    const pseudo = window.getComputedStyle(element, "::after");
    const pseudoWidth = Number.parseFloat(pseudo.width);
    const pseudoHeight = Number.parseFloat(pseudo.height);
    const width = pseudo.content !== "none" && Number.isFinite(pseudoWidth) ? Math.max(rect.width, pseudoWidth) : rect.width;
    const height = pseudo.content !== "none" && Number.isFinite(pseudoHeight) ? Math.max(rect.height, pseudoHeight) : rect.height;
    let left = rect.x - (width - rect.width) / 2;
    let right = left + width;
    let top = rect.y - (height - rect.height) / 2;
    let bottom = top + height;
    let ancestor = element.parentElement;
    while (ancestor) {
      const ancestorStyle = window.getComputedStyle(ancestor);
      const ancestorRect = ancestor.getBoundingClientRect();
      if (ancestorStyle.overflowX !== "visible") {
        left = Math.max(left, ancestorRect.left);
        right = Math.min(right, ancestorRect.right);
      }
      if (ancestorStyle.overflowY !== "visible") {
        top = Math.max(top, ancestorRect.top);
        bottom = Math.min(bottom, ancestorRect.bottom);
      }
      ancestor = ancestor.parentElement;
    }
    left = Math.max(left, 0);
    right = Math.min(right, window.innerWidth);
    top = Math.max(top, 0);
    bottom = Math.min(bottom, window.innerHeight);
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  });
  if (box.width <= 0 || box.height <= 0) {
    throw new Error(`Missing bounding box for ${label}`);
  }
  return box;
}

export async function expectActionNearContainerBottom(
  container: Locator,
  action: Locator,
  label: string,
  maxGap = 64,
) {
  const [containerBox, actionBox] = await Promise.all([
    getRequiredLocatorBoundingBox(container, `${label} container`),
    getRequiredLocatorBoundingBox(action, `${label} action`),
  ]);
  const gap = containerBox.y + containerBox.height - (actionBox.y + actionBox.height);
  expect(gap, `${label}: action-to-bottom gap`).toBeGreaterThanOrEqual(0);
  expect(gap, `${label}: action-to-bottom gap`).toBeLessThanOrEqual(maxGap);
}

export async function expectVerticallyCenteredInViewport(
  page: Page,
  locator: Locator,
  label: string,
  maxOffset = 4,
) {
  await expect.poll(async () => {
    const box = await getRequiredLocatorBoundingBox(locator, label);
    const viewport = page.viewportSize();
    if (!viewport) {
      throw new Error("Missing viewport size");
    }
    return Math.abs((box.y + box.height / 2) - viewport.height / 2);
  }, { message: `${label}: vertical center offset` }).toBeLessThanOrEqual(maxOffset);
}

export async function expectScrollContentNearFooter(
  scrollRegion: Locator,
  label: string,
  maxGap = 24,
) {
  const gap = await scrollRegion.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Scroll region is not an HTMLElement");
    }

    element.scrollTop = element.scrollHeight;

    const footer = element.parentElement?.querySelector<HTMLElement>("[data-subscription-dialog-footer]");
    const lastContent = Array.from(element.children)
      .reverse()
      .find((child): child is HTMLElement => child instanceof HTMLElement && child.offsetParent !== null);

    if (!footer || !lastContent) {
      throw new Error("Missing overlay footer or visible scroll content");
    }

    const footerRect = footer.getBoundingClientRect();
    const contentRect = lastContent.getBoundingClientRect();
    return Math.round((footerRect.top - contentRect.bottom) * 100) / 100;
  });

  expect(gap, `${label}: scroll content to footer gap`).toBeGreaterThanOrEqual(0);
  expect(gap, `${label}: scroll content to footer gap`).toBeLessThanOrEqual(maxGap);
}

export async function expectScrollableRegionReachesTarget(
  scrollRegion: Locator,
  target: Locator,
  label: string,
) {
  await expect(scrollRegion, `${label}: scroll region visible`).toBeVisible();
  await expect(target, `${label}: final target rendered`).toBeVisible();

  const range = await scrollRegion.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(range.scrollHeight, `${label}: content overflows scroll region`).toBeGreaterThan(range.clientHeight);

  await scrollRegion.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(
    () => scrollRegion.evaluate((element) => element.scrollTop),
    { message: `${label}: scroll reaches end` },
  ).toBeGreaterThanOrEqual(range.scrollHeight - range.clientHeight - 1);

  const [scrollRect, targetRect] = await Promise.all([
    scrollRegion.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, top: rect.top };
    }),
    target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, top: rect.top };
    }),
  ]);
  expect(targetRect.top, `${label}: final target top inside scroll region`).toBeGreaterThanOrEqual(scrollRect.top - 1);
  expect(targetRect.bottom, `${label}: final target bottom inside scroll region`).toBeLessThanOrEqual(
    scrollRect.bottom + 1,
  );
}

async function waitForContainingDialogAnimations(target: Locator, label: string) {
  // Vaul 在 data-state=open 的首帧就已可见；绝对几何只能在所属弹窗的真实动画完成后采样。
  await target.evaluate(async (element, animationLabel) => {
    const dialog = element.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error(`Missing dialog for ${animationLabel}`);
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  }, label);
}

export async function expectDetailFooterStableWhileScrolling(
  scrollRegion: Locator,
  finalContent: Locator,
  label: string,
) {
  await expect(scrollRegion, `${label}: detail scroll region visible`).toBeVisible();
  await expect(finalContent, `${label}: final detail content rendered`).toBeVisible();
  await waitForContainingDialogAnimations(scrollRegion, label);
  const before = await scrollRegion.evaluate((element) => {
    const footer = element.parentElement?.querySelector<HTMLElement>("[data-subscription-dialog-footer]");
    if (!footer) throw new Error("Missing subscription detail footer");
    const footerRect = footer.getBoundingClientRect();
    return {
      clientHeight: element.clientHeight,
      footer: {
        bottom: footerRect.bottom,
        left: footerRect.left,
        right: footerRect.right,
        top: footerRect.top,
      },
      scrollHeight: element.scrollHeight,
    };
  });
  expect(before.scrollHeight, `${label}: detail content overflows`).toBeGreaterThan(before.clientHeight);

  await scrollRegion.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(
    () => scrollRegion.evaluate((element) => element.scrollTop),
    { message: `${label}: detail scroll reaches end` },
  ).toBeGreaterThanOrEqual(before.scrollHeight - before.clientHeight - 1);

  const [after, finalContentRect] = await Promise.all([
    scrollRegion.evaluate((element) => {
      const footer = element.parentElement?.querySelector<HTMLElement>("[data-subscription-dialog-footer]");
      if (!footer) throw new Error("Missing subscription detail footer");
      const footerRect = footer.getBoundingClientRect();
      const scrollRect = element.getBoundingClientRect();
      return {
        footer: {
          bottom: footerRect.bottom,
          left: footerRect.left,
          right: footerRect.right,
          top: footerRect.top,
        },
        footerTop: footerRect.top,
        scrollBottom: scrollRect.bottom,
        scrollTop: scrollRect.top,
      };
    }),
    finalContent.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom };
    }),
  ]);

  for (const edge of ["top", "right", "bottom", "left"] as const) {
    expect(Math.abs(after.footer[edge] - before.footer[edge]), `${label}: footer ${edge} offset`).toBeLessThanOrEqual(1);
  }
  expect(finalContentRect.bottom, `${label}: final content reaches visible scroll area`).toBeGreaterThanOrEqual(
    after.scrollTop - 1,
  );
  expect(finalContentRect.bottom, `${label}: final content stays above scroll bottom`).toBeLessThanOrEqual(
    after.scrollBottom + 1,
  );
  expect(finalContentRect.bottom, `${label}: final content stays above fixed footer`).toBeLessThanOrEqual(
    after.footerTop + 1,
  );
}

export async function captureLogoSheetScrollMetrics(sheet: Locator, viewportTestId: string | null) {
  return sheet.evaluate(async (element, testId) => {
    const wrapper = element.parentElement?.closest<HTMLElement>("[data-radix-popper-content-wrapper]") ?? null;
    const dialog = element.closest<HTMLElement>(".h5-dialog-panel");
    const panel =
      element.querySelector<HTMLElement>(".media-candidate-search-panel") ??
      element.querySelector<HTMLElement>(".media-candidate-popover-panel");
    const results = testId
      ? element.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      : element.querySelector<HTMLElement>(".media-candidate-scroll-viewport");
    const content = results?.querySelector<HTMLElement>(".media-candidate-scroll-content");
    if (!results || !content) {
      throw new Error(`Missing Logo sheet scroll viewport or content: ${testId ?? "default"}`);
    }

    const lastButton = Array.from(content.querySelectorAll<HTMLElement>("button[aria-label]")).at(-1);
    if (!lastButton) {
      throw new Error(`Missing Logo sheet last candidate button: ${testId ?? "default"}`);
    }

    results.scrollTop = results.scrollHeight;
    results.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));

    const rect = (target: Element | null) => {
      const box = target?.getBoundingClientRect();
      if (!box) return null;
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        height: Math.round(box.height),
      };
    };

    return {
      dialog: rect(dialog),
      wrapper: rect(wrapper),
      sheet: rect(element),
      panel: rect(panel),
      results: rect(results),
      content: rect(content),
      last: rect(lastButton),
      dialogOverflow: dialog ? window.getComputedStyle(dialog).overflow : null,
      wrapperPosition: wrapper ? window.getComputedStyle(wrapper).position : null,
      wrapperTransform: wrapper ? window.getComputedStyle(wrapper).transform : null,
      sheetOverflow: window.getComputedStyle(element).overflow,
      panelOverflow: panel ? window.getComputedStyle(panel).overflow : null,
      resultsOverflow: window.getComputedStyle(results).overflowY,
      scrollTop: Math.round(results.scrollTop),
      scrollHeight: Math.round(results.scrollHeight),
      clientHeight: Math.round(results.clientHeight),
      lastBottomGap: Math.round(results.getBoundingClientRect().bottom - lastButton.getBoundingClientRect().bottom),
    };
  }, viewportTestId);
}

export async function expectOverlayLeavesTopScrim(
  page: Page,
  overlay: Locator,
  label: string,
  minScrim = 40,
) {
  const box = await getRequiredLocatorBoundingBox(overlay, label);
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("Missing viewport size");
  }

  expect(box.y, `${label}: visible top scrim`).toBeGreaterThanOrEqual(minScrim);
  expect(box.height, `${label}: not full viewport height`).toBeLessThanOrEqual(viewport.height - minScrim);
}

export function expectStableLayout(before: LayoutSnapshot, after: LayoutSnapshot, label: string) {
  // 允许 1px 内的浏览器亚像素差异，但不允许 scroll lock 引起整列横向漂移。
  expect(Math.abs(after.header.x - before.header.x), `${label}: header x offset`).toBeLessThan(1);
  expect(Math.abs(after.content.x - before.content.x), `${label}: main content x offset`).toBeLessThan(1);

  if (before.saveButton && after.saveButton) {
    expect(Math.abs(after.saveButton.x - before.saveButton.x), `${label}: fixed save button x offset`).toBeLessThan(1);
  }
}
