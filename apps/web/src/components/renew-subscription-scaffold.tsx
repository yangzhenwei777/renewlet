import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

interface RenewSubscriptionScaffoldProps extends ComponentPropsWithoutRef<"form"> {
  actions: ReactNode;
  description: ReactNode;
  formRef?: Ref<HTMLFormElement>;
  heading: ReactNode;
  mode: ReactNode;
  pricing: ReactNode;
  schedule: ReactNode;
}

export type RenewSubscriptionScaffoldSlots = Pick<
  RenewSubscriptionScaffoldProps,
  "actions" | "mode" | "pricing" | "schedule"
>;

export function RenewSubscriptionScaffold({
  actions,
  description,
  formRef,
  heading,
  mode,
  pricing,
  schedule,
  ...formProps
}: RenewSubscriptionScaffoldProps) {
  return (
    <>
      <DialogHeader className="shrink-0 p-6 pb-0">
        <DialogTitle className="text-xl font-semibold">{heading}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
      </DialogHeader>
      <form ref={formRef} className="flex min-h-0 flex-col overflow-hidden" {...formProps}>
        <div
          className="h5-mobile-sheet-scroll grid min-h-0 flex-1 gap-5 px-6 py-4"
          data-dialog-region="renewal-fields"
        >
          {mode}
          {pricing}
          {schedule}
        </div>
        <div
          className="flex shrink-0 flex-col gap-3 border-t border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end md:p-6 md:pt-4"
          data-dialog-region="renewal-actions"
        >
          {actions}
        </div>
      </form>
    </>
  );
}

export function createRenewSubscriptionLoadingSlots({
  label,
  restartMode,
}: {
  label: string;
  restartMode: boolean;
}): RenewSubscriptionScaffoldSlots {
  return {
    mode: (
      <>
        <span className="sr-only">{label}</span>
        <Skeleton className="h-24 w-full rounded-md" />
      </>
    ),
    pricing: (
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)]">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    ),
    schedule: restartMode ? (
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    ) : (
      <Skeleton className="h-20 w-full rounded-md" />
    ),
    actions: (
      <>
        <Skeleton className="h-10 w-full sm:w-24" />
        <Skeleton className="h-10 w-full sm:w-24" />
      </>
    ),
  };
}
