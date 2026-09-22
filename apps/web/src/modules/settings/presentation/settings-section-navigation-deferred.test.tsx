import { createRef, forwardRef, useImperativeHandle } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  type SettingsSectionList,
  useSettingsSectionNavigation,
} from "./settings-section-navigation";

const TEST_SECTION_IDS: readonly SettingsSectionId[] = [
  "settings-display",
  "settings-cloud-backup",
  "settings-calendar-feed",
  "settings-notifications",
];
const DEFERRED_SECTION_IDS: readonly SettingsSectionId[] = [
  "settings-cloud-backup",
  "settings-calendar-feed",
  "settings-notifications",
];
const TEST_SECTIONS: SettingsSectionList = SETTINGS_SECTIONS.filter((section) =>
  TEST_SECTION_IDS.some((id) => id === section.id)
);

type NavigationHarnessHandle = {
  markDeferredSectionsReady: () => void;
};

const NavigationHarness = forwardRef<NavigationHarnessHandle>(function NavigationHarness(_, ref) {
  const {
    activeSectionId,
    handleSectionClick,
    markDeferredSectionsReady,
  } = useSettingsSectionNavigation(TEST_SECTIONS, {
    deferredSectionIds: DEFERRED_SECTION_IDS,
  });
  useImperativeHandle(ref, () => ({ markDeferredSectionsReady }), [markDeferredSectionsReady]);

  return (
    <div id="root">
      <nav aria-label="设置目录测试">
        {TEST_SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={activeSectionId === section.id ? "location" : undefined}
            onClick={(event) => {
              event.preventDefault();
              handleSectionClick(section.id);
            }}
          >
            {section.id}
          </a>
        ))}
      </nav>
      {TEST_SECTIONS.map((section) => (
        <section key={section.id} id={section.id}>{section.id}</section>
      ))}
    </div>
  );
});

function setElementRect(element: Element, top: number, height = 160) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: top + height,
      height,
      left: 0,
      right: 960,
      top,
      width: 960,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } satisfies DOMRect),
  });
}

function renderNavigation() {
  const readyRef = createRef<NavigationHarnessHandle>();
  render(<NavigationHarness ref={readyRef} />);
  const root = document.getElementById("root");
  if (!(root instanceof HTMLElement)) throw new Error("Missing settings scroll root");
  setElementRect(root, 0, 800);
  Object.defineProperty(root, "clientHeight", { configurable: true, value: 800 });
  Object.defineProperty(root, "scrollHeight", { configurable: true, value: 3000 });
  Object.defineProperty(root, "scrollTop", { configurable: true, value: 0, writable: true });

  const scrollSpies = new Map<SettingsSectionId, ReturnType<typeof vi.fn>>();
  for (const id of TEST_SECTION_IDS) {
    const section = document.getElementById(id);
    if (!(section instanceof HTMLElement)) throw new Error(`Missing test section: ${id}`);
    const scrollIntoView = vi.fn();
    Object.defineProperty(section, "scrollIntoView", { configurable: true, value: scrollIntoView });
    section.style.scrollMarginTop = "100px";
    scrollSpies.set(id, scrollIntoView);
  }

  return {
    root,
    scrollSpy(id: SettingsSectionId) {
      const spy = scrollSpies.get(id);
      if (!spy) throw new Error(`Missing scroll spy: ${id}`);
      return spy;
    },
    markReady() {
      act(() => readyRef.current?.markDeferredSectionsReady());
    },
  };
}

function setCloudBackupAtAnchor() {
  setElementRect(document.getElementById("settings-display")!, -300);
  setElementRect(document.getElementById("settings-cloud-backup")!, 40);
  setElementRect(document.getElementById("settings-calendar-feed")!, 300);
  setElementRect(document.getElementById("settings-notifications")!, 600);
}

describe("deferred settings section navigation", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
      window.setTimeout(() => callback(performance.now()), 0)
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
      window.clearTimeout(handle);
    });
    window.history.replaceState(null, "", "/settings");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("waits for committed content before scrolling to a deferred section once", async () => {
    const user = userEvent.setup();
    const navigation = renderNavigation();

    await user.click(screen.getByRole("link", { name: "settings-calendar-feed" }));

    expect(window.location.hash).toBe("#settings-calendar-feed");
    expect(screen.getByRole("link", { name: "settings-calendar-feed" })).toHaveAttribute("aria-current", "location");
    expect(navigation.scrollSpy("settings-calendar-feed")).not.toHaveBeenCalled();

    navigation.markReady();
    navigation.markReady();

    await waitFor(() => {
      expect(navigation.scrollSpy("settings-calendar-feed")).toHaveBeenCalledTimes(1);
    });
  });

  it("ignores layout scroll and scrollend while waiting for deferred content", async () => {
    const user = userEvent.setup();
    const navigation = renderNavigation();
    await user.click(screen.getByRole("link", { name: "settings-calendar-feed" }));
    setCloudBackupAtAnchor();

    act(() => {
      navigation.root.dispatchEvent(new Event("scroll"));
      navigation.root.dispatchEvent(new Event("scrollend"));
    });

    expect(screen.getByRole("link", { name: "settings-calendar-feed" })).toHaveAttribute("aria-current", "location");
    expect(screen.getByRole("link", { name: "settings-cloud-backup" })).not.toHaveAttribute("aria-current");
  });

  it("does not resume deferred navigation after user scroll input cancels it", async () => {
    const user = userEvent.setup();
    const navigation = renderNavigation();
    await user.click(screen.getByRole("link", { name: "settings-calendar-feed" }));
    setCloudBackupAtAnchor();

    act(() => {
      navigation.root.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    navigation.markReady();

    expect(screen.getByRole("link", { name: "settings-cloud-backup" })).toHaveAttribute("aria-current", "location");
    expect(navigation.scrollSpy("settings-calendar-feed")).not.toHaveBeenCalled();
  });

  it("scrolls only to the latest deferred section selected before commit", async () => {
    const user = userEvent.setup();
    const navigation = renderNavigation();

    await user.click(screen.getByRole("link", { name: "settings-cloud-backup" }));
    await user.click(screen.getByRole("link", { name: "settings-calendar-feed" }));
    navigation.markReady();

    expect(navigation.scrollSpy("settings-cloud-backup")).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(navigation.scrollSpy("settings-calendar-feed")).toHaveBeenCalledTimes(1);
    });
    expect(window.location.hash).toBe("#settings-calendar-feed");
  });

  it("waits for commit before resolving an initial deferred section hash", async () => {
    window.history.replaceState(null, "", "/settings#settings-calendar-feed");
    const navigation = renderNavigation();

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "settings-calendar-feed" })).toHaveAttribute("aria-current", "location");
    });
    expect(navigation.scrollSpy("settings-calendar-feed")).not.toHaveBeenCalled();

    navigation.markReady();

    await waitFor(() => {
      expect(navigation.scrollSpy("settings-calendar-feed")).toHaveBeenCalledTimes(1);
    });
  });
});
