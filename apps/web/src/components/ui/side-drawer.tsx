import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { FloatingPortalContainerProvider } from "@/components/ui/floating-portal-container";
import { cn } from "@/lib/utils";

type SideDrawerSide = "left" | "right";

type SideDrawerContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  overlayClassName?: string;
  side: SideDrawerSide;
};

type SideDrawerRootProps = Omit<React.ComponentProps<typeof DialogPrimitive.Root>, "modal">;

function SideDrawerRoot(props: SideDrawerRootProps) {
  return <DialogPrimitive.Root modal {...props} />;
}

const SideDrawerTrigger = DialogPrimitive.Trigger;
const SideDrawerClose = DialogPrimitive.Close;
const SideDrawerTitle = DialogPrimitive.Title;
const SideDrawerDescription = DialogPrimitive.Description;

const SideDrawerContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SideDrawerContentProps
>(({ children, className, overlayClassName, side, ...props }, ref) => {
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);
  const setRefs = React.useCallback(
    (node: React.ElementRef<typeof DialogPrimitive.Content> | null) => {
      setPortalContainer(node);
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  return (
    // Radix Presence 必须持续拥有 Portal，才能在 data-state=closed 的退场动画结束后再卸载侧栏。
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-side-drawer-overlay=""
        className={cn(
          "fixed inset-0 z-70 bg-black/60 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          overlayClassName,
        )}
      />
      <DialogPrimitive.Content
        ref={setRefs}
        data-side={side}
        data-side-drawer-content=""
        className={cn(
          "fixed top-(--app-visual-viewport-offset-top) z-80 flex h-(--app-viewport-height) max-h-(--app-viewport-height) flex-col overflow-hidden bg-card text-card-foreground shadow-lg outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          side === "left"
            ? "left-0 border-r border-border data-[state=closed]:slide-out-to-left-4 data-[state=open]:slide-in-from-left-4"
            : "right-0 border-l border-border data-[state=closed]:slide-out-to-right-4 data-[state=open]:slide-in-from-right-4",
          className,
        )}
        {...props}
      >
        <FloatingPortalContainerProvider container={portalContainer}>
          {children}
        </FloatingPortalContainerProvider>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
SideDrawerContent.displayName = DialogPrimitive.Content.displayName;

export {
  SideDrawerClose,
  SideDrawerContent,
  SideDrawerDescription,
  SideDrawerRoot,
  SideDrawerTitle,
  SideDrawerTrigger,
};
