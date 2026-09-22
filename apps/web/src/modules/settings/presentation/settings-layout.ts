import { cn } from "@/lib/utils";

export const settingsLayout = {
  // Settings 锚点、H5 sticky 标题、桌面目录和 #root 滚动面共用这些变量；改 Header 高度时只同步这一处。
  pageGrid:
    "[--settings-mobile-header-offset:calc(8.25rem+env(safe-area-inset-top))] [--settings-mobile-sticky-gap:0.75rem] [--settings-mobile-header-height:5.5rem] [--settings-desktop-sticky-top:7rem] [--settings-desktop-section-scroll-offset:var(--settings-desktop-sticky-top)] [--settings-section-scroll-offset:calc(var(--settings-mobile-header-offset)+var(--settings-mobile-sticky-gap)+var(--settings-mobile-header-height)+0.75rem)] lg:[--settings-section-scroll-offset:var(--settings-desktop-section-scroll-offset)] grid min-w-0 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8",
  content: "grid min-w-0 gap-6 lg:gap-8",
  desktopHeader: "hidden lg:block",
  desktopNav:
    "sticky top-(--settings-desktop-sticky-top) max-h-[calc(var(--app-viewport-height)-var(--settings-desktop-sticky-top)-1rem)] overflow-y-auto rounded-xl border border-border bg-card/70 p-3 shadow-card backdrop-blur",
  mobileHeader:
    "sticky top-[calc(var(--settings-mobile-header-offset)+var(--settings-mobile-sticky-gap))] z-30 min-w-0 rounded-xl border border-border/70 bg-background/95 p-4 shadow-card backdrop-blur-xl lg:hidden",
  mobileHeaderRow: "flex min-w-0 items-start justify-between gap-3",
  mobileHeaderText: "grid min-w-0 gap-1",
  mobileHeaderTitle: "min-w-0 truncate text-2xl font-bold text-foreground",
  mobileHeaderSubtitle: "text-sm leading-5 text-muted-foreground",
  mobileHeaderTrigger:
    "h-10 w-10 shrink-0 rounded-lg border border-border bg-card/80 text-muted-foreground hover:border-primary/40 hover:bg-secondary/80 hover:text-foreground",
  sectionCard: "min-w-0 w-full rounded-xl border border-border bg-card p-4 sm:p-6",
} as const;

export const SETTINGS_SECTION_SCROLL_CLASS = "scroll-mt-(--settings-section-scroll-offset)";
export const SETTINGS_SECTION_FRAME_CLASS = cn(settingsLayout.sectionCard, SETTINGS_SECTION_SCROLL_CLASS);

export function getSettingsSectionClassName(className?: string | undefined) {
  return cn(settingsLayout.sectionCard, className);
}
