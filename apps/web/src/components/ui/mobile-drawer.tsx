import * as React from "react";
import { X } from "lucide-react";
import { Drawer } from "vaul";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 底部抽屉统一承载 h5-drawer-panel 高度链、safe-area 底部预算和 44px 关闭触控目标，业务 Drawer 不再复制 H5 平台约束。
const DEFAULT_MOBILE_DRAWER_BODY_CLASSNAME =
  "min-h-0 flex-1 overflow-y-auto px-5 pb-[calc(1rem+env(safe-area-inset-bottom))]";

type MobileBottomDrawerContentProps = Omit<React.ComponentPropsWithoutRef<typeof Drawer.Content>, "children" | "title"> & {
  actions?: React.ReactNode;
  /** null 表示业务自管滚动链和底部操作区，供云备份、筛选抽屉这类复合面板复用同一外壳。 */
  bodyClassName?: string | null;
  closeLabel: string;
  description: React.ReactNode;
  descriptionMode?: "visible" | "sr-only";
  descriptionClassName?: string;
  headerClassName?: string;
  icon?: React.ReactNode;
  overlayClassName?: string;
  title: React.ReactNode;
  titleClassName?: string;
  zIndexClassName?: string;
  children?: React.ReactNode;
};

const MobileDrawerRoot = Drawer.Root;
const MobileDrawerTrigger = Drawer.Trigger;
const MobileDrawerClose = Drawer.Close;

function MobileBottomDrawerContent({
  actions,
  bodyClassName,
  children,
  className,
  closeLabel,
  description,
  descriptionClassName,
  descriptionMode = "visible",
  headerClassName,
  icon,
  overlayClassName,
  title,
  titleClassName,
  zIndexClassName = "z-50",
  ...props
}: MobileBottomDrawerContentProps) {
  const descriptionClass = descriptionMode === "sr-only"
    ? "sr-only"
    : cn("mt-1 text-left leading-5 text-muted-foreground", descriptionClassName ?? "text-sm");

  return (
    <Drawer.Portal>
      <Drawer.Overlay
        className={cn(
          "fixed inset-0 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          zIndexClassName,
          overlayClassName,
        )}
      />
      <Drawer.Content
        className={cn(
          "h5-drawer-panel fixed inset-x-0 bottom-0 mx-auto flex w-full max-w-lg flex-col overflow-hidden rounded-t-lg border border-border bg-card text-card-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4",
          zIndexClassName,
          className,
        )}
        {...props}
      >
        <Drawer.Handle className="h5-mobile-sheet-handle" />
        <div className={cn("flex items-start justify-between gap-4 px-5 pb-3 pt-4", headerClassName)}>
          <div className="flex min-w-0 flex-1 items-start gap-2">
            {icon ? (
              <div aria-hidden="true" className="shrink-0">
                {icon}
              </div>
            ) : null}
            <div className="min-w-0 flex-1">
              <Drawer.Title
                className={cn("min-w-0 text-base font-semibold text-foreground", titleClassName)}
              >
                <span className="block min-w-0 truncate">{title}</span>
              </Drawer.Title>
              <Drawer.Description className={descriptionClass}>
                {description}
              </Drawer.Description>
            </div>
          </div>
          <div className="-mr-2 -mt-2 flex shrink-0 items-center gap-2">
            {actions}
            <MobileDrawerClose asChild>
              <Button variant="ghost" size="icon" className="h-10 w-10 text-muted-foreground">
                <X className="h-4 w-4" />
                <span className="sr-only">{closeLabel}</span>
              </Button>
            </MobileDrawerClose>
          </div>
        </div>
        {bodyClassName === null ? children : (
          <div className={cn(DEFAULT_MOBILE_DRAWER_BODY_CLASSNAME, bodyClassName)}>
            {children}
          </div>
        )}
      </Drawer.Content>
    </Drawer.Portal>
  );
}

export {
  MobileBottomDrawerContent,
  MobileDrawerClose,
  MobileDrawerRoot,
  MobileDrawerTrigger,
};
