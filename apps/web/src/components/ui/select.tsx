/**
 * 选择器设计系统原语。
 *
 * 架构位置：封装 Radix Select，并对长文本加 Tooltip，保证设置页和订阅表单的紧凑布局可读。
 *
 * 注意： Portal/positioning 需与 Dialog/Popover 保持兼容；修改后重点检查移动端弹窗内选择器。
 */
import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { cn } from "@/lib/utils";

const SelectOpenContext = React.createContext<{
  onSheetAnimationEnd: (open: boolean) => void;
  open: boolean;
  present: boolean;
  setOpen: (open: boolean) => void;
  sheetOpen: boolean;
  value: string;
  valueLabels: ReadonlyMap<string, React.ReactNode>;
}>({
  onSheetAnimationEnd: () => {},
  open: false,
  present: false,
  setOpen: () => {},
  sheetOpen: false,
  value: "",
  valueLabels: new Map(),
});

function Select({
  defaultOpen,
  defaultValue,
  children,
  onOpenChange,
  onValueChange,
  open: openProp,
  value: valueProp,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Root>) {
  const isMobileOverlay = useIsMobileOverlay();
  const overlayOpen = useMobileOverlayOpenLifecycle({
    animateClose: isMobileOverlay,
    defaultOpen,
    onOpenChange,
    open: openProp,
  });
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue ?? "");
  const isValueControlled = valueProp !== undefined;
  const value = valueProp ?? uncontrolledValue;
  const valueLabels = React.useMemo(() => collectSelectItemLabels(children), [children]);

  const setValue = React.useCallback(
    (nextValue: string) => {
      if (!isValueControlled) {
        setUncontrolledValue(nextValue);
      }
      onValueChange?.(nextValue);
    },
    [isValueControlled, onValueChange],
  );

  return (
    <SelectOpenContext.Provider
      value={{
        onSheetAnimationEnd: overlayOpen.onSheetAnimationEnd,
        open: overlayOpen.open,
        present: overlayOpen.present,
        setOpen: overlayOpen.setOpen,
        sheetOpen: overlayOpen.sheetOpen,
        value,
        valueLabels,
      }}
    >
      <SelectPrimitive.Root
        open={overlayOpen.open}
        onOpenChange={overlayOpen.setOpen}
        value={value}
        onValueChange={setValue}
        {...props}
      >
        {children}
      </SelectPrimitive.Root>
    </SelectOpenContext.Provider>
  );
}

Select.displayName = SelectPrimitive.Root.displayName;

const SelectGroup = SelectPrimitive.Group;

const SelectValue = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Value>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Value>
>(({ children, ...props }, ref) => {
  const { value, valueLabels } = React.useContext(SelectOpenContext);
  // Vaul 移动 sheet 关闭态会卸载 Content；trigger 文案不能依赖 Radix ItemText 的 DOM portal。
  const registeredLabel = value ? valueLabels.get(value) : undefined;

  return (
    <SelectPrimitive.Value ref={ref} {...props}>
      {children === undefined ? registeredLabel : children}
    </SelectPrimitive.Value>
  );
});
SelectValue.displayName = SelectPrimitive.Value.displayName;

type SelectTriggerProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & {
  tooltipContent?: string | undefined;
};

function isSelectValueOverflowing(node: HTMLElement) {
  const valueNode = node.querySelector("span") as HTMLElement | null;
  const target = valueNode ?? node;
  return target.scrollWidth > target.clientWidth + 1 || target.scrollHeight > target.clientHeight + 1;
}

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({
  className,
  children,
  onClickCapture,
  onPointerDownCapture,
  tooltipContent,
  ...props
}, ref) => {
  const triggerRef = React.useRef<React.ElementRef<typeof SelectPrimitive.Trigger> | null>(null);
  const [isOverflowing, setIsOverflowing] = React.useState(false);

  const setRefs = React.useCallback(
    (node: React.ElementRef<typeof SelectPrimitive.Trigger> | null) => {
      triggerRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  const measure = React.useCallback(() => {
    const node = triggerRef.current;
    if (!node || !tooltipContent) {
      setIsOverflowing(false);
      return;
    }
    setIsOverflowing(isSelectValueOverflowing(node));
  }, [tooltipContent]);

  React.useEffect(() => {
    measure();

    const node = triggerRef.current;
    if (!node || !tooltipContent) return;

    const ResizeObserverCtor = node.ownerDocument.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(measure) : null;
    observer?.observe(node);

    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, tooltipContent]);

  const trigger = (
    <SelectPrimitive.Trigger
      ref={setRefs}
      onClickCapture={(event) => {
        if (shouldSuppressMobileOverlayTriggerEvent(event)) return;
        onClickCapture?.(event);
      }}
      onPointerDownCapture={(event) => {
        if (shouldSuppressMobileOverlayTriggerEvent(event)) return;
        onPointerDownCapture?.(event);
      }}
      className={cn(
        "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="h-4 w-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );

  if (!tooltipContent || !isOverflowing) {
    return trigger;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent className="max-w-[calc(100vw-2rem)] whitespace-normal wrap-break-word text-xs leading-relaxed sm:max-w-md">
        {tooltipContent}
      </TooltipContent>
    </Tooltip>
  );
});
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn("h5-mobile-select-scroll-button flex cursor-default items-center justify-center py-1", className)}
    {...props}
  >
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn("h5-mobile-select-scroll-button flex cursor-default items-center justify-center py-1", className)}
    {...props}
  >
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> & {
    mobileDetent?: MobileSheetDetent;
    mobileKind?: MobileSheetKind;
    mobileTitle?: React.ReactNode;
    mobileDescription?: React.ReactNode;
    mobileCloseLabel?: string;
  }
>(({
  className,
  children,
  mobileCloseLabel,
  mobileDescription,
  mobileDetent = "auto",
  mobileKind = "list",
  mobileTitle,
  onPointerDownOutside,
  position = "popper",
  ...props
}, ref) => {
  const portalContainer = useFloatingPortalContainer();
  const isMobileOverlay = useIsMobileOverlay();
  const {
    onSheetAnimationEnd,
    present,
    setOpen,
    sheetOpen,
  } = React.useContext(SelectOpenContext);
  const locale = getApiLocale();
  const optionCount = countSelectOptions(children);
  const resolvedMobileDetent = resolveMobileSheetDetent({
    itemCount: optionCount,
    kind: mobileKind,
    requestedDetent: mobileDetent,
  });
  const resolvedMobileTitle = mobileTitle ?? translate(locale, "common.selectPlaceholder");
  const resolvedMobileCloseLabel = mobileCloseLabel ?? translate(locale, "common.close");

  if (portalContainer === null) {
    return null;
  }

  const portalContainerProps = portalContainer === undefined ? {} : { container: portalContainer };

  const content = (
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        "h5-floating-content relative z-50 min-w-32 overflow-hidden border bg-popover text-popover-foreground shadow-md",
        !isMobileOverlay &&
          "max-h-96 rounded-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        !isMobileOverlay &&
          position === "popper" &&
          "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
        className,
      )}
      position={position}
      {...(onPointerDownOutside ? { onPointerDownOutside } : {})}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn(
          "h5-mobile-select-viewport p-1",
          !isMobileOverlay && position === "popper" &&
            "h-(--radix-select-trigger-height) w-full min-w-(--radix-select-trigger-width)",
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  );

  if (isMobileOverlay) {
    return (
      <MobileOverlaySheet
        open={sheetOpen}
        present={present}
        onOpenChange={setOpen}
        onAnimationEnd={onSheetAnimationEnd}
        container={portalContainer}
        contentRole="listbox"
        detent={resolvedMobileDetent}
        kind={mobileKind}
        title={resolvedMobileTitle}
        description={mobileDescription}
        closeLabel={resolvedMobileCloseLabel}
      >
        {content}
      </MobileOverlaySheet>
    );
  }

  return (
    <SelectPrimitive.Portal {...portalContainerProps}>
      {content}
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

function countSelectOptions(children: React.ReactNode): number {
  let count = 0;

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement<{ children?: React.ReactNode; value?: string }>(child)) return;

    if (typeof child.props.value === "string") {
      count += 1;
      return;
    }

    if (child.props.children) {
      count += countSelectOptions(child.props.children);
    }
  });

  return count;
}

type SelectItemScanProps = {
  children?: React.ReactNode;
  textValue?: string;
  value?: string;
};

function collectSelectItemLabels(children: React.ReactNode) {
  const labels = new Map<string, React.ReactNode>();

  function visit(node: React.ReactNode) {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement<SelectItemScanProps>(child)) return;

      if (typeof child.props.value === "string") {
        labels.set(child.props.value, getSelectItemLabel(child.props));
        return;
      }

      if (child.props.children) {
        visit(child.props.children);
      }
    });
  }

  visit(children);
  return labels;
}

function getSelectItemLabel({ children, textValue }: SelectItemScanProps) {
  if (typeof textValue === "string" && textValue.length > 0) return textValue;
  return getPlainTextFromReactNode(children) ?? children;
}

function getPlainTextFromReactNode(node: React.ReactNode): string | undefined {
  const parts: string[] = [];
  let isPlainText = true;

  React.Children.forEach(node, (child) => {
    if (!isPlainText || child === null || child === undefined || typeof child === "boolean") return;

    if (typeof child === "string" || typeof child === "number") {
      parts.push(String(child));
      return;
    }

    if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.props.children !== undefined) {
      const nestedText = getPlainTextFromReactNode(child.props.children);
      if (nestedText !== undefined) {
        parts.push(nestedText);
        return;
      }
    }

    isPlainText = false;
  });

  if (!isPlainText) return undefined;

  const text = parts.join("").trim();
  return text.length > 0 ? text : undefined;
}

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label ref={ref} className={cn("py-1.5 pl-8 pr-2 text-sm font-semibold", className)} {...props} />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none data-disabled:pointer-events-none data-disabled:opacity-50 focus:bg-accent focus:text-accent-foreground",
      "h5-mobile-option-item h5-mobile-option-item-leading",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>

    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
