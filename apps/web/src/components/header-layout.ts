import { cn } from "@/lib/utils";

export const headerLayout = {
  shell: "sticky top-0 z-50 border-b border-border bg-card/80 backdrop-blur-xl relative",
  inner: "mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4",
  primaryCluster: "flex min-w-0 items-center gap-3 lg:gap-5 xl:gap-8",
  brandCluster: "flex min-w-0 items-center gap-3",
  brandTextGroup: "grid min-w-0 gap-1",
  brandTitleLink:
    "block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  brandTitle: "truncate text-xl font-extrabold tracking-tight text-foreground",
  desktopNav: "hidden min-w-0 items-center gap-1 lg:flex",
  desktopNavIcon: "h-4 w-4 shrink-0",
  desktopNavLabel: "whitespace-nowrap",
  desktopNavSkeletonLabel: "h-4 w-16",
  actions: "flex min-w-0 shrink-0 items-center justify-end gap-2",
  mobileNav: "flex border-t border-border lg:hidden",
  mobileNavIcon: "h-5 w-5",
} as const;

const headerDesktopNavLinkBase =
  "flex h-10 w-auto items-center justify-start gap-2 rounded-lg px-3 text-sm font-medium transition-colors xl:px-4";

const headerDesktopNavSkeletonItem =
  "flex h-10 w-auto items-center justify-start gap-2 rounded-lg px-3 xl:px-4";

const headerMobileNavLinkBase = "flex flex-1 flex-col items-center gap-1 py-3 text-xs font-medium transition-colors";

export function getHeaderDesktopNavLinkClass(isActive: boolean) {
  return cn(
    headerDesktopNavLinkBase,
    isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
  );
}

export function getHeaderDesktopNavSkeletonItemClass() {
  return headerDesktopNavSkeletonItem;
}

export function getHeaderMobileNavLinkClass(isActive: boolean) {
  return cn(headerMobileNavLinkBase, isActive ? "text-primary" : "text-muted-foreground");
}
