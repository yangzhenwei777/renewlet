import { expect, type Locator, type Page } from "@playwright/test";

type CloseSideDrawer = () => Promise<unknown>;

export async function expectSideDrawerExitLifecycle(
  page: Page,
  content: Locator,
  close: CloseSideDrawer,
) {
  const overlay = page.locator("[data-side-drawer-overlay]").last();
  await expect(content).toHaveAttribute("data-state", "open");
  await expect(overlay).toHaveAttribute("data-state", "open");
  await expect.poll(() => page.evaluate(() => document.body.hasAttribute("data-scroll-locked"))).toBe(true);

  await content.evaluate((element) => {
    const root = document.documentElement;
    root.removeAttribute("data-e2e-side-drawer-content-exit-started");
    root.removeAttribute("data-e2e-side-drawer-overlay-exit-started");

    const observeExit = (target: Element, marker: string) => {
      const record = (event: Event) => {
        if (event.target !== target || target.getAttribute("data-state") !== "closed" || !target.isConnected) return;
        root.setAttribute(marker, "");
        target.removeEventListener("animationstart", record);
      };
      target.addEventListener("animationstart", record);
    };

    const drawerOverlay = document.querySelector("[data-side-drawer-overlay][data-state='open']");
    if (!drawerOverlay) throw new Error("Missing open side drawer overlay");
    observeExit(element, "data-e2e-side-drawer-content-exit-started");
    observeExit(drawerOverlay, "data-e2e-side-drawer-overlay-exit-started");
  });

  await close();

  await expect.poll(() => page.evaluate(() => ({
    content: document.documentElement.hasAttribute("data-e2e-side-drawer-content-exit-started"),
    overlay: document.documentElement.hasAttribute("data-e2e-side-drawer-overlay-exit-started"),
  }))).toEqual({ content: true, overlay: true });
  await expect(content).not.toBeAttached();
  await expect(overlay).not.toBeAttached();
  await expect.poll(() => page.evaluate(() => document.body.hasAttribute("data-scroll-locked"))).toBe(false);

  await page.evaluate(() => {
    document.documentElement.removeAttribute("data-e2e-side-drawer-content-exit-started");
    document.documentElement.removeAttribute("data-e2e-side-drawer-overlay-exit-started");
  });
}
