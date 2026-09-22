import * as React from "react";
import { X } from "lucide-react";
import { Drawer } from "vaul";

import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

export const MOBILE_OVERLAY_QUERY = "(max-width: 767px)";
const MOBILE_SHEET_LARGE_ITEM_THRESHOLD = 10;
const MOBILE_OVERLAY_EXIT_ANIMATION_MS = 500;

export type MobileSheetDetent = "auto" | "compact" | "large";
export type ResolvedMobileSheetDetent = Exclude<MobileSheetDetent, "auto">;
export type MobileSheetKind = "list" | "calendar" | "panel";

let activeMobileOverlayCount = 0;
type MobileOverlayInteractionPoint = {
  x: number;
  y: number;
};

type MobileOverlayTriggerSuppression = {
  expiresAt: number;
  point?: MobileOverlayInteractionPoint | undefined;
};

let mobileOverlayTriggerSuppression: MobileOverlayTriggerSuppression | undefined;
let clearMobileOverlayTriggerSuppressionTimer: ReturnType<typeof setTimeout> | undefined;
const MOBILE_OVERLAY_TRIGGER_SUPPRESSION_MS = 450;
const MOBILE_OVERLAY_TRIGGER_SUPPRESSION_RADIUS_PX = 24;

function updateMobileOverlayOpenState() {
  if (typeof document === "undefined") return;

  if (activeMobileOverlayCount > 0) {
    document.body.setAttribute("data-mobile-overlay-open", "");
    return;
  }

  document.body.removeAttribute("data-mobile-overlay-open");
}

function registerMobileOverlay() {
  activeMobileOverlayCount += 1;
  updateMobileOverlayOpenState();

  return () => {
    activeMobileOverlayCount = Math.max(0, activeMobileOverlayCount - 1);
    updateMobileOverlayOpenState();
  };
}

export function useIsMobileOverlay() {
  return useMediaQuery(MOBILE_OVERLAY_QUERY);
}

export function useMobileOverlayOpenLifecycle({
  animateClose,
  defaultOpen = false,
  onOpenChange,
  open,
}: {
  animateClose: boolean;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  open?: boolean | undefined;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = open !== undefined;
  const committedOpen = isControlled ? open : uncontrolledOpen;
  const [rootOpenState, setRootOpenState] = React.useState(committedOpen);
  const [sheetOpenState, setSheetOpenState] = React.useState(committedOpen);
  const [presentState, setPresentState] = React.useState(committedOpen);
  const rootOpenRef = React.useRef(rootOpenState);
  const sheetOpenRef = React.useRef(sheetOpenState);
  const presentRef = React.useRef(presentState);
  const pendingCloseNotifyRef = React.useRef(false);
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previousCommittedOpenRef = React.useRef(committedOpen);

  const setRootOpen = React.useCallback((nextOpen: boolean) => {
    rootOpenRef.current = nextOpen;
    setRootOpenState(nextOpen);
  }, []);

  const setSheetOpen = React.useCallback((nextOpen: boolean) => {
    sheetOpenRef.current = nextOpen;
    setSheetOpenState(nextOpen);
  }, []);

  const setPresent = React.useCallback((nextPresent: boolean) => {
    presentRef.current = nextPresent;
    setPresentState(nextPresent);
  }, []);

  const clearCloseTimer = React.useCallback(() => {
    if (!closeTimerRef.current) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
  }, []);

  const commitClosed = React.useCallback(
    (shouldNotify: boolean) => {
      clearCloseTimer();
      pendingCloseNotifyRef.current = false;
      setRootOpen(false);
      setSheetOpen(false);
      setPresent(false);
      if (!isControlled) {
        setUncontrolledOpen(false);
      }
      if (shouldNotify) {
        onOpenChange?.(false);
      }
    },
    [clearCloseTimer, isControlled, onOpenChange, setPresent, setRootOpen, setSheetOpen],
  );

  const finishAnimatedClose = React.useCallback(() => {
    if (sheetOpenRef.current) return;
    commitClosed(pendingCloseNotifyRef.current);
  }, [commitClosed]);

  const scheduleAnimatedClose = React.useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = undefined;
      finishAnimatedClose();
    }, MOBILE_OVERLAY_EXIT_ANIMATION_MS);
  }, [clearCloseTimer, finishAnimatedClose]);

  const openNow = React.useCallback(
    (shouldNotify: boolean) => {
      clearCloseTimer();
      pendingCloseNotifyRef.current = false;
      setPresent(true);
      setRootOpen(true);
      setSheetOpen(true);
      if (!isControlled) {
        setUncontrolledOpen(true);
      }
      if (shouldNotify) {
        onOpenChange?.(true);
      }
    },
    [clearCloseTimer, isControlled, onOpenChange, setPresent, setRootOpen, setSheetOpen],
  );

  const closeWithLifecycle = React.useCallback(
    (shouldNotify: boolean) => {
      if (isControlled && !onOpenChange && shouldNotify) return;
      if (!rootOpenRef.current && !sheetOpenRef.current && !presentRef.current) {
        if (!isControlled) {
          setUncontrolledOpen(false);
        }
        if (shouldNotify) {
          onOpenChange?.(false);
        }
        return;
      }

      if (!animateClose) {
        commitClosed(shouldNotify);
        return;
      }

      // Radix Content 需要在 Vaul closed 动画期间继续挂载；真正提交关闭等 sheet 退出期结束。
      pendingCloseNotifyRef.current ||= shouldNotify;
      setPresent(true);
      setRootOpen(true);
      setSheetOpen(false);
      scheduleAnimatedClose();
    },
    [
      animateClose,
      commitClosed,
      isControlled,
      onOpenChange,
      scheduleAnimatedClose,
      setPresent,
      setRootOpen,
      setSheetOpen,
    ],
  );

  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        openNow(true);
        return;
      }
      closeWithLifecycle(true);
    },
    [closeWithLifecycle, openNow],
  );

  React.useEffect(() => {
    if (previousCommittedOpenRef.current === committedOpen) return;
    previousCommittedOpenRef.current = committedOpen;

    if (committedOpen) {
      openNow(false);
      return;
    }

    closeWithLifecycle(false);
  }, [closeWithLifecycle, committedOpen, openNow]);

  React.useEffect(() => clearCloseTimer, [clearCloseTimer]);

  const handleSheetAnimationEnd = React.useCallback(
    (animationOpen: boolean) => {
      if (animationOpen) return;
      finishAnimatedClose();
    },
    [finishAnimatedClose],
  );

  return {
    onSheetAnimationEnd: handleSheetAnimationEnd,
    open: rootOpenState,
    present: presentState,
    setOpen,
    sheetOpen: sheetOpenState,
  } as const;
}

function MobileOverlayPortalHost({ children }: { children: React.ReactNode }) {
  return (
    <div data-mobile-overlay-portal="" className="contents">
      {children}
    </div>
  );
}

export function resolveMobileSheetDetent({
  itemCount,
  kind = "panel",
  requestedDetent = "auto",
}: {
  itemCount?: number | undefined;
  kind?: MobileSheetKind | undefined;
  requestedDetent?: MobileSheetDetent | undefined;
}): ResolvedMobileSheetDetent {
  if (requestedDetent === "compact" || requestedDetent === "large") {
    return requestedDetent;
  }

  if (kind === "list" && typeof itemCount === "number" && itemCount > MOBILE_SHEET_LARGE_ITEM_THRESHOLD) {
    return "large";
  }

  return "compact";
}

type MobileOverlayInteractionEvent = (Event | React.SyntheticEvent) & {
  changedTouches?: TouchList;
  clientX?: number;
  clientY?: number;
  nativeEvent?: Event & {
    changedTouches?: TouchList;
    clientX?: number;
    clientY?: number;
  };
};

function getMobileOverlayInteractionPoint(
  event: MobileOverlayInteractionEvent | undefined,
): MobileOverlayInteractionPoint | undefined {
  const source = event && "nativeEvent" in event ? event.nativeEvent : event;
  if (!source) return undefined;

  if (typeof source.clientX === "number" && typeof source.clientY === "number") {
    return { x: source.clientX, y: source.clientY };
  }

  const touch = source.changedTouches?.[0];
  if (touch) {
    return { x: touch.clientX, y: touch.clientY };
  }

  return undefined;
}

function isWithinMobileOverlaySuppressionPoint(
  interactionPoint: MobileOverlayInteractionPoint | undefined,
  eventPoint: MobileOverlayInteractionPoint | undefined,
) {
  if (!interactionPoint || !eventPoint) return true;

  return (
    Math.abs(interactionPoint.x - eventPoint.x) <= MOBILE_OVERLAY_TRIGGER_SUPPRESSION_RADIUS_PX &&
    Math.abs(interactionPoint.y - eventPoint.y) <= MOBILE_OVERLAY_TRIGGER_SUPPRESSION_RADIUS_PX
  );
}

function clearExpiredMobileOverlayTriggerSuppression() {
  if (!mobileOverlayTriggerSuppression) return;
  if (Date.now() <= mobileOverlayTriggerSuppression.expiresAt) return;

  mobileOverlayTriggerSuppression = undefined;
  if (clearMobileOverlayTriggerSuppressionTimer) {
    clearTimeout(clearMobileOverlayTriggerSuppressionTimer);
    clearMobileOverlayTriggerSuppressionTimer = undefined;
  }
}

function markMobileOverlayScrimInteraction(event?: MobileOverlayInteractionEvent) {
  // 移动浏览器会在 portal 卸载后补发兼容 click；坐标闸门只拦同一次遮罩点击，不挡用户点别处。
  mobileOverlayTriggerSuppression = {
    expiresAt: Date.now() + MOBILE_OVERLAY_TRIGGER_SUPPRESSION_MS,
    point: getMobileOverlayInteractionPoint(event),
  };

  if (clearMobileOverlayTriggerSuppressionTimer) {
    clearTimeout(clearMobileOverlayTriggerSuppressionTimer);
  }
  clearMobileOverlayTriggerSuppressionTimer = setTimeout(() => {
    mobileOverlayTriggerSuppression = undefined;
    clearMobileOverlayTriggerSuppressionTimer = undefined;
  }, MOBILE_OVERLAY_TRIGGER_SUPPRESSION_MS);
}

function stopMobileOverlayScrimEvent(event: Pick<React.SyntheticEvent, "preventDefault" | "stopPropagation">) {
  event.preventDefault();
  event.stopPropagation();
}

export function shouldSuppressMobileOverlayTriggerEvent(
  event: Pick<React.SyntheticEvent, "preventDefault" | "stopPropagation"> & MobileOverlayInteractionEvent,
) {
  clearExpiredMobileOverlayTriggerSuppression();
  if (!mobileOverlayTriggerSuppression) return false;

  const eventPoint = getMobileOverlayInteractionPoint(event);
  if (!isWithinMobileOverlaySuppressionPoint(mobileOverlayTriggerSuppression.point, eventPoint)) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  return true;
}

function getMobileSheetClassName({
  detent,
  kind,
}: {
  detent: ResolvedMobileSheetDetent;
  kind: MobileSheetKind;
}) {
  return cn(
    "h5-mobile-sheet-content",
    detent === "compact" && "h5-mobile-sheet-compact",
    detent === "large" && "h5-mobile-sheet-large",
    kind === "list" && "h5-mobile-sheet-list",
    kind === "calendar" && "h5-mobile-sheet-calendar",
    kind === "panel" && "h5-mobile-sheet-panel",
  );
}

type MobileOverlaySheetChildProps = {
  className?: string | undefined;
  children?: React.ReactNode;
  "data-mobile-detent"?: string | undefined;
  "data-mobile-kind"?: string | undefined;
  role?: React.AriaRole | undefined;
};

type MobileOverlaySheetProps = {
  children: React.ReactElement<MobileOverlaySheetChildProps>;
  closeLabel: string;
  container?: HTMLElement | null | undefined;
  contentRole?: React.AriaRole;
  description?: React.ReactNode;
  detent: ResolvedMobileSheetDetent;
  kind: MobileSheetKind;
  onAnimationEnd: (open: boolean) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  present: boolean;
  title: React.ReactNode;
  titleLayout?: "flush" | "padded";
  titleMode?: "sr-only" | "visible";
};

function MobileOverlaySheet({
  children,
  closeLabel,
  container,
  contentRole,
  description,
  detent,
  kind,
  onAnimationEnd,
  onOpenChange,
  open,
  present,
  title,
  titleLayout = "padded",
  titleMode = "sr-only",
}: MobileOverlaySheetProps) {
  React.useEffect(() => {
    if (!present) return undefined;
    return registerMobileOverlay();
  }, [present]);

  const child = React.Children.only(children);
  const handleScrimPointerEvent = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // pointer 只建立防穿透闸门，click 再关闭；否则父 Dialog 会先收到 outside pointer。
    markMobileOverlayScrimInteraction(event);
    stopMobileOverlayScrimEvent(event);
  }, []);
  const handleScrimClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    markMobileOverlayScrimInteraction(event);
    stopMobileOverlayScrimEvent(event);
    onOpenChange(false);
  }, [onOpenChange]);
  const content = React.cloneElement(child, {
    "data-mobile-detent": detent,
    "data-mobile-kind": kind,
    className: cn(getMobileSheetClassName({ detent, kind }), child.props.className),
    ...(contentRole === undefined ? {} : { role: contentRole }),
    children: (
      <>
        <Drawer.Handle className="h5-mobile-sheet-handle" />
        {titleMode === "visible" ? (
          <div
            className={cn(
              "h5-mobile-sheet-header flex items-start justify-between gap-3 border-b border-border px-4 py-3",
              titleLayout === "padded" && "-mx-4 -mt-4 mb-4",
            )}
          >
            <div className="min-w-0">
              <Drawer.Title className="truncate text-sm font-semibold text-foreground">
                {title}
              </Drawer.Title>
              {description ? (
                <Drawer.Description className="mt-1 text-xs text-muted-foreground">
                  {description}
                </Drawer.Description>
              ) : null}
            </div>
            <Drawer.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="-mr-2 -mt-1 h-9 w-9 shrink-0 text-muted-foreground"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">{closeLabel}</span>
              </Button>
            </Drawer.Close>
          </div>
        ) : (
          <>
            <Drawer.Title className="sr-only">{title}</Drawer.Title>
            {description ? (
              <Drawer.Description className="sr-only">{description}</Drawer.Description>
            ) : null}
          </>
        )}
        {child.props.children}
      </>
    ),
  });

  if (!present) return null;

  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      onAnimationEnd={onAnimationEnd}
      shouldScaleBackground={false}
      {...(container === undefined ? {} : { container })}
    >
      <Drawer.Portal forceMount>
        <MobileOverlayPortalHost>
          <Drawer.Overlay
            forceMount
            data-mobile-overlay-backdrop=""
            className="h5-mobile-overlay-backdrop fixed inset-0 bg-black/60"
            onClickCapture={handleScrimClick}
            onPointerDownCapture={handleScrimPointerEvent}
            onPointerUpCapture={handleScrimPointerEvent}
          />
          <Drawer.Content forceMount asChild>{content}</Drawer.Content>
        </MobileOverlayPortalHost>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export { MobileOverlaySheet };
