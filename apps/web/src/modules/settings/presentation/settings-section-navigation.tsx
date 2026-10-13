import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useRouter } from '@/lib/router';
import { Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  SideDrawerClose,
  SideDrawerContent,
  SideDrawerDescription,
  SideDrawerRoot,
  SideDrawerTitle,
  SideDrawerTrigger,
} from '@/components/ui/side-drawer';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n/I18nProvider';
import { settingsLayout } from './settings-layout';

const LAYOUT_SETTLE_MAX_MS = 2_000;
const LAYOUT_SETTLE_STABLE_FRAMES = 2;
const BOTTOM_EDGE_TOLERANCE_PX = 4;

export const SETTINGS_SECTIONS = [
  { id: "settings-account", labelKey: "settings.sectionNav.account" },
  { id: "settings-access-security", labelKey: "settings.sectionNav.accessSecurity" },
  { id: "settings-appearance", labelKey: "settings.sectionNav.appearance" },
  { id: "settings-display", labelKey: "settings.sectionNav.display" },
  { id: "settings-icon-sources", labelKey: "settings.sectionNav.iconSources" },
  { id: "settings-uploaded-icons", labelKey: "settings.sectionNav.uploadedIcons" },
  { id: "settings-ai-recognition", labelKey: "settings.sectionNav.aiRecognition" },
  { id: "settings-budget", labelKey: "settings.sectionNav.budget" },
  { id: "settings-data-config", labelKey: "settings.sectionNav.dataConfig" },
  { id: "settings-cloud-backup", labelKey: "settings.sectionNav.cloudBackup" },
  { id: "settings-exchange", labelKey: "settings.sectionNav.exchange" },
  { id: "settings-calendar-feed", labelKey: "settings.sectionNav.calendarFeed" },
  { id: "settings-public-status", labelKey: "settings.sectionNav.publicStatus" },
  { id: "settings-public-api", labelKey: "settings.sectionNav.publicApi" },
  { id: "settings-timezone", labelKey: "settings.sectionNav.timezone" },
  { id: "settings-notifications", labelKey: "settings.sectionNav.notifications" },
] as const;

export type SettingsSectionDefinition = typeof SETTINGS_SECTIONS[number];
export type SettingsSectionId = SettingsSectionDefinition["id"];
export type SettingsSectionList = readonly SettingsSectionDefinition[];

export function createSettingsSections({
  canManageAccessSecurity,
}: {
  canManageAccessSecurity: boolean;
}): SettingsSectionList {
  return canManageAccessSecurity
    ? SETTINGS_SECTIONS
    : SETTINGS_SECTIONS.filter((section) => section.id !== "settings-access-security");
}

/**
 * 延迟区块先定位到稳定骨架，再在真实内容提交后做有限校正；远程数据不能成为目录点击的阻塞条件。
 */
type ProgrammaticNavigation = {
  targetId: SettingsSectionId;
  initialFrame: number | null;
  settleFrame: number | null;
  settleDeadline: number;
  stableFrames: number;
  lastAnchorTop: number | null;
  needsCorrection: boolean;
  awaitingDeferredCommit: boolean;
  hasScrollEvent: boolean;
  phase: "targetSelected" | "moduleCommitted" | "layoutSettling" | "complete";
};
type SettingsSectionNavigationOptions = {
  deferredSectionIds?: readonly SettingsSectionId[] | undefined;
};
type SettingsSectionNavigationProps = {
  sections: SettingsSectionList;
  activeSectionId: SettingsSectionId;
  onSectionClick: (id: SettingsSectionId) => void;
  onSectionIntent?: ((id: SettingsSectionId) => void) | undefined;
};

function getSectionFromHash(hash: string, sections: SettingsSectionList): SettingsSectionId | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  return sections.some((section) => section.id === id) ? (id as SettingsSectionId) : null;
}

function scrollToSettingsSection(id: SettingsSectionId, behavior: ScrollBehavior = "smooth") {
  const section = document.getElementById(id);
  if (!section) return false;
  const root = getAppScrollRoot();
  const reducedMotion = typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const resolvedBehavior = reducedMotion ? "auto" : behavior;

  // scrollIntoView 在移动端抽屉退场、body 锁定和嵌套滚动上下文同时发生时，可能只更新窗口滚动位置。
  // #root 是应用唯一滚动面，按真实 DOMRect 计算一次目标 scrollTop，确保点击反馈不依赖浏览器选中的祖先容器。
  const rootRect = root?.getBoundingClientRect();
  const sectionRect = rootRect ? section.getBoundingClientRect() : null;
  const scrollMarginTop = parseCssLengthToPx(window.getComputedStyle(section).scrollMarginTop) ?? 0;
  if (root && rootRect && sectionRect) {
    const nextScrollTop = Math.max(0, root.scrollTop + sectionRect.top - rootRect.top - scrollMarginTop);
    // 目录点击可能同时关闭移动端抽屉；同步写入先锁定目标位置，避免抽屉的滚动锁取消尚未完成的 smooth 动画。
    root.scrollTop = nextScrollTop;
    // 保留原生锚点语义；nearest 在已定位的 #root 上不会重新选择 body 或打断同步定位，测试和辅助技术也能观察到标准滚动调用。
    section.scrollIntoView({ block: "nearest", behavior: "auto" });
  } else {
    section.scrollIntoView({ block: "start", behavior: resolvedBehavior });
  }
  return true;
}

function getAppScrollRoot() {
  return typeof document === "undefined" ? null : document.getElementById("root");
}

function parseCssLengthToPx(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.startsWith("calc(") && normalized.endsWith(")")) {
    return parseCssCalcLengthToPx(normalized.slice(5, -1));
  }
  if (normalized.startsWith("env(")) return 0;

  const match = /^(-?\d+(?:\.\d+)?)(px|rem)$/.exec(normalized);
  if (!match) return null;
  const valueNumber = Number.parseFloat(match[1] ?? "0");
  const unit = match[2];
  if (unit === "px") return valueNumber;
  return valueNumber * getRootFontSizePx();
}

function parseCssCalcLengthToPx(expression: string): number | null {
  const terms = expression
    .replace(/\benv\([^)]*\)/g, "0px")
    .match(/[+-]?\s*[^+-]+/g);
  if (!terms) return null;

  let total = 0;
  for (const term of terms) {
    const value = parseCssLengthToPx(term.replace(/\s+/g, ""));
    if (value === null) return null;
    total += value;
  }
  return total;
}

function getRootFontSizePx(): number {
  const rootFontSize = window.getComputedStyle(document.documentElement).fontSize;
  return parseCssLengthToPx(rootFontSize) ?? 16;
}

function getSectionElement(id: SettingsSectionId) {
  const element = document.getElementById(id);
  return element instanceof HTMLElement ? element : null;
}

function getFirstRenderedSection(sections: SettingsSectionList) {
  for (const section of sections) {
    const element = getSectionElement(section.id);
    if (element) return element;
  }
  return null;
}

function getAnchorLinePx(root: HTMLElement, sections: SettingsSectionList) {
  const firstSection = getFirstRenderedSection(sections);
  const scrollMarginTop = firstSection
    ? parseCssLengthToPx(window.getComputedStyle(firstSection).scrollMarginTop) ?? 0
    : 0;
  return root.getBoundingClientRect().top + scrollMarginTop;
}

function isRootScrolledToBottom(root: HTMLElement) {
  return root.scrollHeight > root.clientHeight + BOTTOM_EDGE_TOLERANCE_PX
    && root.scrollHeight - root.scrollTop - root.clientHeight <= BOTTOM_EDGE_TOLERANCE_PX;
}

function resolveActiveSectionFromAnchor(root: HTMLElement, sections: SettingsSectionList): SettingsSectionId {
  const firstSectionId = sections[0]?.id ?? SETTINGS_SECTIONS[0].id;
  if (root.clientHeight <= 0) return firstSectionId;

  const lastSection = sections[sections.length - 1];
  if (isRootScrolledToBottom(root)) return lastSection?.id ?? firstSectionId;

  // 激活锚点直接复用 section 的真实 scroll-margin，避免点击定位和滚动高亮使用两套顶部基准。
  const anchorLine = getAnchorLinePx(root, sections);
  let activeSectionId: SettingsSectionId = firstSectionId;

  for (const section of sections) {
    const element = getSectionElement(section.id);
    if (!element) continue;
    if (element.getBoundingClientRect().top <= anchorLine) {
      activeSectionId = section.id;
      continue;
    }
    break;
  }

  return activeSectionId;
}

function getNextSectionId(id: SettingsSectionId, sections: SettingsSectionList) {
  const currentIndex = sections.findIndex((section) => section.id === id);
  const nextSection = sections[currentIndex + 1];
  return nextSection?.id ?? null;
}

function isAnchorStillWithinSection(root: HTMLElement, id: SettingsSectionId, sections: SettingsSectionList) {
  if (resolveActiveSectionFromAnchor(root, sections) !== id) return false;
  const nextSectionId = getNextSectionId(id, sections);
  if (!nextSectionId) return true;
  const nextSection = getSectionElement(nextSectionId);
  if (!nextSection) return true;
  return nextSection.getBoundingClientRect().top > getAnchorLinePx(root, sections);
}

export function useSettingsSectionNavigation(
  sections: SettingsSectionList = SETTINGS_SECTIONS,
  options: SettingsSectionNavigationOptions = {},
) {
  const firstSectionId = sections[0]?.id ?? SETTINGS_SECTIONS[0].id;
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>(firstSectionId);
  const location = useLocation();
  const navigate = useNavigate();
  const deferredSectionIds = options.deferredSectionIds;
  const programmaticNavigationRef = useRef<ProgrammaticNavigation | null>(null);
  const locationHashHandledRef = useRef<string | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scheduleLayoutCorrectionRef = useRef<() => void>(() => undefined);

  const applyAnchorActiveSection = useCallback(() => {
    const root = getAppScrollRoot();
    if (root) setActiveSectionId(resolveActiveSectionFromAnchor(root, sections));
  }, [sections]);

  const scheduleAnchorActiveSection = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (!programmaticNavigationRef.current) applyAnchorActiveSection();
    });
  }, [applyAnchorActiveSection]);

  const endProgrammaticNavigation = useCallback((options: { applyAnchorSection?: boolean } = {}) => {
    const navigation = programmaticNavigationRef.current;
    if (navigation?.initialFrame !== null && navigation?.initialFrame !== undefined) {
      window.cancelAnimationFrame(navigation.initialFrame);
    }
    if (navigation?.settleFrame !== null && navigation?.settleFrame !== undefined) {
      window.cancelAnimationFrame(navigation.settleFrame);
    }
    if (navigation) navigation.phase = "complete";
    programmaticNavigationRef.current = null;
    if (options.applyAnchorSection) applyAnchorActiveSection();
  }, [applyAnchorActiveSection]);

  const scheduleLayoutCorrection = useCallback(() => {
    const navigation = programmaticNavigationRef.current;
    if (!navigation || navigation.phase !== "layoutSettling" || navigation.settleFrame !== null) return;

    navigation.settleFrame = window.requestAnimationFrame(() => {
      navigation.settleFrame = null;
      const currentNavigation = programmaticNavigationRef.current;
      if (currentNavigation !== navigation || navigation.phase !== "layoutSettling") return;

      const now = performance.now();
      const root = getAppScrollRoot();
      if (!root || now >= navigation.settleDeadline) {
        endProgrammaticNavigation();
        return;
      }

      const section = getSectionElement(navigation.targetId);
      if (!section) {
        scheduleLayoutCorrectionRef.current();
        return;
      }

      const anchorTop = section.getBoundingClientRect().top;
      if (navigation.needsCorrection && !isAnchorStillWithinSection(root, navigation.targetId, sections)) {
        scrollToSettingsSection(navigation.targetId, "auto");
        navigation.stableFrames = 0;
        navigation.needsCorrection = false;
      } else if (navigation.lastAnchorTop !== null && Math.abs(anchorTop - navigation.lastAnchorTop) <= 0.5) {
        navigation.stableFrames += 1;
      } else {
        navigation.stableFrames = 0;
      }
      navigation.lastAnchorTop = anchorTop;

      if (navigation.stableFrames >= LAYOUT_SETTLE_STABLE_FRAMES && navigation.hasScrollEvent) {
        endProgrammaticNavigation();
      } else {
        scheduleLayoutCorrectionRef.current();
      }
    });
  }, [endProgrammaticNavigation, sections]);

  useEffect(() => {
    scheduleLayoutCorrectionRef.current = scheduleLayoutCorrection;
  }, [scheduleLayoutCorrection]);

  const beginProgrammaticNavigation = useCallback((id: SettingsSectionId, updateLocation = true) => {
    endProgrammaticNavigation();
    const targetElement = getSectionElement(id);
    // 只有命中仍处于 aria-busy 的骨架才等待真实模块 commit；已经提交的分组可直接进入有限校正，避免重复点击白等 2 秒。
    const navigation: ProgrammaticNavigation = {
      targetId: id,
      initialFrame: null,
      settleFrame: null,
      settleDeadline: performance.now() + LAYOUT_SETTLE_MAX_MS,
      stableFrames: 0,
      lastAnchorTop: null,
      needsCorrection: false,
      awaitingDeferredCommit: (deferredSectionIds?.includes(id) ?? false)
        && (targetElement?.getAttribute("aria-busy") === "true" || !targetElement),
      hasScrollEvent: false,
      phase: "targetSelected",
    };
    programmaticNavigationRef.current = navigation;
    setActiveSectionId(id);
    if (updateLocation) {
      const hash = `#${id}`;
      locationHashHandledRef.current = hash;
      // 每次目录选择保留独立 history entry，后退可以回到上一个设置区块；刷新和直接打开仍由 hash 恢复。
      navigate({ hash });
    }
    // 先定位已有骨架，让点击在当前帧就有反馈；懒加载提交后再由 ResizeObserver/回调触发有限校正。
    if (scrollToSettingsSection(id)) {
      navigation.phase = "moduleCommitted";
    }
    const commitTargetWhenRendered = () => {
      navigation.initialFrame = null;
      if (programmaticNavigationRef.current !== navigation) return;
      if (!getSectionElement(id)) {
        if (performance.now() >= navigation.settleDeadline) {
          endProgrammaticNavigation();
          return;
        }
        navigation.initialFrame = window.requestAnimationFrame(commitTargetWhenRendered);
        return;
      }
      if (navigation.phase === "targetSelected") {
        scrollToSettingsSection(id);
        navigation.phase = "moduleCommitted";
      }
      if (navigation.phase === "moduleCommitted" && navigation.awaitingDeferredCommit) {
        if (performance.now() >= navigation.settleDeadline) endProgrammaticNavigation();
        else navigation.initialFrame = window.requestAnimationFrame(commitTargetWhenRendered);
        return;
      }
      if (navigation.phase === "moduleCommitted") navigation.phase = "layoutSettling";
      scheduleLayoutCorrection();
    };
    navigation.initialFrame = window.requestAnimationFrame(commitTargetWhenRendered);
  }, [deferredSectionIds, endProgrammaticNavigation, navigate, scheduleLayoutCorrection]);

  const markDeferredSectionsReady = useCallback(() => {
    const navigation = programmaticNavigationRef.current;
    if (!navigation) return;
    if (deferredSectionIds && !deferredSectionIds.includes(navigation.targetId)) return;
    navigation.phase = "moduleCommitted";
    navigation.awaitingDeferredCommit = false;
    navigation.needsCorrection = true;
    navigation.stableFrames = 0;
    navigation.lastAnchorTop = null;
    if (navigation.initialFrame !== null) {
      window.cancelAnimationFrame(navigation.initialFrame);
      navigation.initialFrame = null;
    }
    navigation.phase = "layoutSettling";
    scheduleLayoutCorrection();
  }, [deferredSectionIds, scheduleLayoutCorrection]);

  useEffect(() => {
    const sectionId = getSectionFromHash(location.hash, sections);
    if (!sectionId || locationHashHandledRef.current === location.hash) {
      locationHashHandledRef.current = null;
      return;
    }
    const frame = window.requestAnimationFrame(() => beginProgrammaticNavigation(sectionId, false));
    return () => window.cancelAnimationFrame(frame);
  }, [beginProgrammaticNavigation, location.hash, sections]);

  useEffect(() => {
    const restoreHashAfterHistoryNavigation = () => {
      const hash = window.location.hash;
      const sectionId = getSectionFromHash(hash, sections);
      if (!sectionId) return;
      // React Router 的 hash-only history entry 在部分浏览器只触发 popstate，不一定重新提交 location；
      // 直接接住原生回退，保证目录高亮和滚动恢复与 URL 同步。
      locationHashHandledRef.current = hash;
      window.requestAnimationFrame(() => {
        if (window.location.hash !== hash) return;
        locationHashHandledRef.current = hash;
        beginProgrammaticNavigation(sectionId, false);
      });
    };

    window.addEventListener("popstate", restoreHashAfterHistoryNavigation);
    window.addEventListener("hashchange", restoreHashAfterHistoryNavigation);
    return () => {
      window.removeEventListener("popstate", restoreHashAfterHistoryNavigation);
      window.removeEventListener("hashchange", restoreHashAfterHistoryNavigation);
    };
  }, [beginProgrammaticNavigation, sections]);

  useEffect(() => {
    if (!sections.some((section) => section.id === activeSectionId)) {
      setActiveSectionId(firstSectionId);
    }
  }, [activeSectionId, firstSectionId, sections]);

  useEffect(() => {
    const root = getAppScrollRoot();
    if (!root) return;

    const cancelForUserScroll = () => {
      if (!programmaticNavigationRef.current) return;
      endProgrammaticNavigation({ applyAnchorSection: true });
    };
    const handleScrollEnd = () => {
      const navigation = programmaticNavigationRef.current;
      if (!navigation || navigation.phase === "targetSelected" || navigation.phase === "complete") return;
      navigation.hasScrollEvent = true;
      navigation.needsCorrection = true;
      navigation.stableFrames = 0;
      scheduleLayoutCorrection();
    };
    const handleScroll = () => {
      const navigation = programmaticNavigationRef.current;
      if (!navigation) {
        scheduleAnchorActiveSection();
        return;
      }
      if (navigation.phase === "targetSelected" || navigation.phase === "complete") return;
      navigation.hasScrollEvent = true;
      // 自动滚动产生的 scroll 事件不能结束校正；只有用户输入会通过 cancelForUserScroll 中断。
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "ArrowDown"
        || event.key === "ArrowUp"
        || event.key === "PageDown"
        || event.key === "PageUp"
        || event.key === "Home"
        || event.key === "End"
        || event.key === " "
      ) {
        cancelForUserScroll();
      }
    };

    // #root 是唯一滚动面；scroll 事件每帧解析一次真实 DOM 位置，避免 IO 阈值没变化时 active 卡在上一段。
    scheduleAnchorActiveSection();
    root.addEventListener("wheel", cancelForUserScroll, { passive: true, capture: true });
    root.addEventListener("touchstart", cancelForUserScroll, { passive: true, capture: true });
    root.addEventListener("touchmove", cancelForUserScroll, { passive: true, capture: true });
    root.addEventListener("pointerdown", cancelForUserScroll, { passive: true, capture: true });
    root.addEventListener("scroll", handleScroll, { passive: true });
    root.addEventListener("scrollend", handleScrollEnd);
    window.addEventListener("keydown", handleKeyDown, true);

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        const navigation = programmaticNavigationRef.current;
        if (navigation && navigation.phase !== "complete") {
          navigation.needsCorrection = true;
          navigation.stableFrames = 0;
          navigation.lastAnchorTop = null;
        }
        scheduleLayoutCorrection();
      });
      const rootContent = document.querySelector<HTMLElement>('[data-testid="settings-section-content"]');
      if (rootContent) observer.observe(rootContent);
      for (const section of sections) {
        const element = getSectionElement(section.id);
        if (element) observer.observe(element);
      }
      resizeObserverRef.current = observer;
    }

    return () => {
      root.removeEventListener("wheel", cancelForUserScroll, { capture: true });
      root.removeEventListener("touchstart", cancelForUserScroll, { capture: true });
      root.removeEventListener("touchmove", cancelForUserScroll, { capture: true });
      root.removeEventListener("pointerdown", cancelForUserScroll, { capture: true });
      root.removeEventListener("scroll", handleScroll);
      root.removeEventListener("scrollend", handleScrollEnd);
      window.removeEventListener("keydown", handleKeyDown, true);
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      endProgrammaticNavigation();
    };
  }, [endProgrammaticNavigation, scheduleAnchorActiveSection, scheduleLayoutCorrection, sections]);

  const handleSectionClick = useCallback((id: SettingsSectionId) => {
    beginProgrammaticNavigation(id);
  }, [beginProgrammaticNavigation]);

  return { activeSectionId, handleSectionClick, markDeferredSectionsReady };
}

function SettingsSectionNavLink({
  section,
  active,
  onSectionClick,
  onSectionIntent,
  variant,
}: {
  section: SettingsSectionDefinition;
  active: boolean;
  onSectionClick: (id: SettingsSectionId) => void;
  onSectionIntent?: ((id: SettingsSectionId) => void) | undefined;
  variant: "desktop" | "mobileDrawer";
}) {
  const { t } = useI18n();
  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onSectionClick(section.id);
  };

  return (
    <a
      href={`#${section.id}`}
      aria-current={active ? "location" : undefined}
      onClick={handleClick}
      onPointerEnter={() => onSectionIntent?.(section.id)}
      onPointerDown={() => onSectionIntent?.(section.id)}
      onFocus={() => onSectionIntent?.(section.id)}
      className={cn(
        "group relative transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        variant === "desktop"
          ? "block rounded-lg px-3 py-2 text-sm font-medium"
          : "flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium",
        active && variant === "desktop" && "bg-primary/10 text-primary",
        !active && variant === "desktop" && "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
        active && variant === "mobileDrawer" && "bg-primary/10 text-primary",
        !active && variant === "mobileDrawer" && "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
      )}
    >
      {variant === "desktop" && active ? (
        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
      ) : null}
      {variant === "mobileDrawer" && active ? (
        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
      ) : null}
      <span className="min-w-0 truncate">{t(section.labelKey)}</span>
    </a>
  );
}

export function DesktopSettingsSectionNav({
  sections,
  activeSectionId,
  onSectionClick,
  onSectionIntent,
}: SettingsSectionNavigationProps) {
  const { t } = useI18n();

  return (
    <nav
      aria-label={t("settings.sectionNavLabel")}
      className={settingsLayout.desktopNav}
      data-testid="settings-section-nav-desktop"
    >
      <div className="grid gap-3">
        <p className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("settings.sectionNavTitle")}
        </p>
        <div className="grid gap-1">
          {sections.map((section) => (
            <SettingsSectionNavLink
              key={section.id}
              section={section}
              active={activeSectionId === section.id}
              onSectionClick={onSectionClick}
              onSectionIntent={onSectionIntent}
              variant="desktop"
            />
          ))}
        </div>
      </div>
    </nav>
  );
}

export function MobileSettingsSectionDrawer({
  sections,
  activeSectionId,
  onSectionClick,
  onSectionIntent,
  open,
  onOpenChange,
}: SettingsSectionNavigationProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const handleSectionClick = (id: SettingsSectionId) => {
    onSectionClick(id);
    onOpenChange(false);
  };

  return (
    <SideDrawerRoot open={open} onOpenChange={onOpenChange}>
      <MobileSettingsPageHeader />
      <SideDrawerContent
        side="left"
        className="w-[min(18rem,calc(100vw-3.5rem))] rounded-r-xl bg-card/95 backdrop-blur-xl"
        data-testid="settings-section-nav-drawer"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 pb-3 pt-[calc(1rem+env(safe-area-inset-top))]">
          <div className="min-w-0">
            <SideDrawerTitle className="text-base font-semibold text-foreground">
              {t("settings.sectionNavTitle")}
            </SideDrawerTitle>
            <SideDrawerDescription className="sr-only">
              {t("settings.sectionNavLabel")}
            </SideDrawerDescription>
          </div>
          <SideDrawerClose asChild>
            <Button variant="ghost" size="icon" className="-mr-2 -mt-2 h-11 w-11 text-muted-foreground">
              <X className="h-4 w-4" />
              <span className="sr-only">{t("common.close")}</span>
            </Button>
          </SideDrawerClose>
        </div>

        <nav aria-label={t("settings.sectionNavLabel")} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <ul className="grid gap-1">
            {sections.map((section) => (
              <li key={section.id}>
                <SettingsSectionNavLink
                  section={section}
                  active={activeSectionId === section.id}
                  onSectionClick={handleSectionClick}
                  onSectionIntent={onSectionIntent}
                  variant="mobileDrawer"
                />
              </li>
            ))}
          </ul>
        </nav>
      </SideDrawerContent>
    </SideDrawerRoot>
  );
}

function MobileSettingsPageHeader() {
  const { t } = useI18n();

  return (
    <div
      className={settingsLayout.mobileHeader}
      data-testid="settings-mobile-page-header"
    >
      <div className={settingsLayout.mobileHeaderRow}>
        <div className={settingsLayout.mobileHeaderText}>
          <h1 className={settingsLayout.mobileHeaderTitle}>{t("settings.title")}</h1>
          <p className={settingsLayout.mobileHeaderSubtitle} data-testid="settings-mobile-page-subtitle">
            {t("settings.subtitle")}
          </p>
        </div>
        <SideDrawerTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(settingsLayout.mobileHeaderTrigger, "min-h-11 min-w-11")}
            aria-label={t("settings.sectionNavOpen")}
          >
            <Menu className="h-4 w-4" />
          </Button>
        </SideDrawerTrigger>
      </div>
    </div>
  );
}

export function useUnsavedChangesGuard(enabled: boolean, onConfirmLeave: () => void) {
  const router = useRouter();
  const [pendingUrl, setPendingUrl] = useState<URL | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const nextUrl = new URL(anchor.href, window.location.href);
      if (nextUrl.origin !== window.location.origin) return;
      const currentUrl = new URL(window.location.href);
      if (
        nextUrl.pathname === currentUrl.pathname
        && nextUrl.search === currentUrl.search
        && nextUrl.hash === currentUrl.hash
      ) {
        return;
      }
      // 设置目录只改 hash，属于页内定位；不应触发“离开设置页”的未保存确认。
      if (nextUrl.pathname === currentUrl.pathname && nextUrl.search === currentUrl.search) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setPendingUrl(nextUrl);
    };

    // beforeunload 只能显示浏览器通用文案；站内 SPA 导航在这里转成 Renewlet 风格确认弹窗。
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [enabled]);

  useEffect(() => {
    if (enabled) return;
    setPendingUrl(null);
  }, [enabled]);

  const cancelLeave = useCallback(() => {
    setPendingUrl(null);
  }, []);

  const confirmLeave = useCallback(() => {
    if (!pendingUrl) return;
    const nextPath = `${pendingUrl.pathname}${pendingUrl.search}${pendingUrl.hash}`;
    setPendingUrl(null);
    onConfirmLeave();
    router.push(nextPath);
  }, [router, onConfirmLeave, pendingUrl]);

  return {
    pendingLeave: pendingUrl !== null,
    cancelLeave,
    confirmLeave,
  };
}
