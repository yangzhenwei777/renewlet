/**
 * 下拉菜单设计系统原语。
 *
 * 架构位置：封装 Radix DropdownMenu，用于 Header、表格行操作和更多菜单的统一交互。
 *
 * 注意： 子菜单偏移和勾选图标是全站菜单约定，调整时要检查管理员用户表和订阅卡片操作。
 */
import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";

import { useFloatingPortalContainer } from "@/components/ui/floating-portal-container";
import {
  MobileOverlaySheet,
  resolveMobileSheetDetent,
  shouldSuppressMobileOverlayTriggerEvent,
  useIsMobileOverlay,
  useMobileOverlayOpenLifecycle,
  type MobileSheetDetent,
  type MobileSheetKind,
} from "@/components/ui/mobile-overlay";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { cn } from "@/lib/utils";

type DropdownMenuProps = React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root>;

const DropdownMenuOpenContext = React.createContext<{
  onSheetAnimationEnd: (open: boolean) => void;
  open: boolean;
  present: boolean;
  setOpen: (open: boolean) => void;
  sheetOpen: boolean;
}>({
  onSheetAnimationEnd: () => {},
  open: false,
  present: false,
  setOpen: () => {},
  sheetOpen: false,
});

function DropdownMenu({
  defaultOpen,
  modal: modalProp,
  onOpenChange,
  open: openProp,
  ...props
}: DropdownMenuProps) {
  const isMobileOverlay = useIsMobileOverlay();
  const overlayOpen = useMobileOverlayOpenLifecycle({
    animateClose: isMobileOverlay,
    defaultOpen,
    onOpenChange,
    open: openProp,
  });

  return (
    <DropdownMenuOpenContext.Provider
      value={{
        onSheetAnimationEnd: overlayOpen.onSheetAnimationEnd,
        open: overlayOpen.open,
        present: overlayOpen.present,
        setOpen: overlayOpen.setOpen,
        sheetOpen: overlayOpen.sheetOpen,
      }}
    >
      <DropdownMenuPrimitive.Root
        modal={modalProp ?? isMobileOverlay}
        open={overlayOpen.open}
        onOpenChange={overlayOpen.setOpen}
        {...props}
      />
    </DropdownMenuOpenContext.Provider>
  );
}

DropdownMenu.displayName = DropdownMenuPrimitive.Root.displayName;

const DropdownMenuTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ onClickCapture, onPointerDownCapture, ...props }, ref) => {
  const isMobileOverlay = useIsMobileOverlay();
  const { open, setOpen } = React.useContext(DropdownMenuOpenContext);

  return (
    <DropdownMenuPrimitive.Trigger
      ref={ref}
      {...props}
      onClickCapture={(event) => {
        if (shouldSuppressMobileOverlayTriggerEvent(event)) return;
        if (isMobileOverlay) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(!open);
        }
        onClickCapture?.(event);
      }}
      onPointerDownCapture={(event) => {
        if (shouldSuppressMobileOverlayTriggerEvent(event)) return;
        if (isMobileOverlay) {
          event.preventDefault();
          event.stopPropagation();
        }
        onPointerDownCapture?.(event);
      }}
    />
  );
});
DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName;

const DropdownMenuGroup = DropdownMenuPrimitive.Group;

const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

const DropdownMenuSub = DropdownMenuPrimitive.Sub;

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[state=open]:bg-accent focus:bg-accent",
      inset && "pl-8",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-4 w-4" />
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.SubContent
    ref={ref}
    className={cn(
      "h5-floating-content z-50 min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
      className,
    )}
    {...props}
  />
));
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
    mobileDetent?: MobileSheetDetent;
    mobileKind?: MobileSheetKind;
    mobileTitle?: React.ReactNode;
    mobileCloseLabel?: string;
  }
>(({
  children,
  className,
  mobileCloseLabel,
  mobileDetent = "auto",
  mobileKind = "list",
  mobileTitle,
  "aria-label": ariaLabel,
  onInteractOutside,
  onPointerDownOutside,
  sideOffset = 4,
  ...props
}, ref) => {
  const portalContainer = useFloatingPortalContainer();
  const isMobileOverlay = useIsMobileOverlay();
  const {
    onSheetAnimationEnd,
    present,
    setOpen,
    sheetOpen,
  } = React.useContext(DropdownMenuOpenContext);
  const locale = getApiLocale();
  const optionCount = countDropdownOptions(children);
  const resolvedMobileDetent = resolveMobileSheetDetent({
    itemCount: optionCount,
    kind: mobileKind,
    requestedDetent: mobileDetent,
  });
  const resolvedMobileTitle = mobileTitle
    ?? (typeof ariaLabel === "string"
      ? ariaLabel
      : translate(locale, "common.options", { count: optionCount }));
  const resolvedMobileCloseLabel = mobileCloseLabel ?? translate(locale, "common.close");

  if (portalContainer === null) {
    return null;
  }

  const portalContainerProps = portalContainer === undefined ? {} : { container: portalContainer };

  const content = (
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "h5-floating-content z-50 min-w-32 overflow-hidden border bg-popover p-1 text-popover-foreground shadow-md",
        isMobileOverlay && "h5-mobile-menu-content",
        !isMobileOverlay &&
          "rounded-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      {...(onInteractOutside ? { onInteractOutside } : {})}
      {...(onPointerDownOutside ? { onPointerDownOutside } : {})}
      {...props}
    >
      {children}
    </DropdownMenuPrimitive.Content>
  );

  if (isMobileOverlay) {
    return (
      <MobileOverlaySheet
        open={sheetOpen}
        present={present}
        onOpenChange={setOpen}
        onAnimationEnd={onSheetAnimationEnd}
        container={portalContainer}
        contentRole="menu"
        detent={resolvedMobileDetent}
        kind={mobileKind}
        title={resolvedMobileTitle}
        closeLabel={resolvedMobileCloseLabel}
      >
        {content}
      </MobileOverlaySheet>
    );
  }

  return (
    <DropdownMenuPrimitive.Portal {...portalContainerProps}>
      {content}
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors data-disabled:pointer-events-none data-disabled:opacity-50 focus:bg-accent focus:text-accent-foreground",
      "h5-mobile-option-item",
      inset && "h5-mobile-option-item-leading pl-8",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors data-disabled:pointer-events-none data-disabled:opacity-50 focus:bg-accent focus:text-accent-foreground",
      "h5-mobile-option-item h5-mobile-option-item-leading",
      className,
    )}
    {...(checked === undefined ? {} : { checked })}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors data-disabled:pointer-events-none data-disabled:opacity-50 focus:bg-accent focus:text-accent-foreground",
      "h5-mobile-option-item h5-mobile-option-item-leading",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Circle className="h-2 w-2 fill-current" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-sm font-semibold", inset && "pl-8", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return <span className={cn("ml-auto text-xs tracking-widest opacity-60", className)} {...props} />;
};
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";

function countDropdownOptions(children: React.ReactNode): number {
  let count = 0;

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return;

    if (
      child.type === DropdownMenuItem ||
      child.type === DropdownMenuCheckboxItem ||
      child.type === DropdownMenuRadioItem
    ) {
      count += 1;
      return;
    }

    if (child.props.children) {
      count += countDropdownOptions(child.props.children);
    }
  });

  return count;
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};
