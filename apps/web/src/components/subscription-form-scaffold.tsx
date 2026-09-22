import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface SubscriptionFormScaffoldProps extends ComponentPropsWithoutRef<"form"> {
  fields: ReactNode;
  actions: ReactNode;
  formRef?: Ref<HTMLFormElement>;
}

export type SubscriptionFormScaffoldSlots = Pick<
  SubscriptionFormScaffoldProps,
  "actions" | "fields"
>;

// 该 scaffold 是数据等待态与真实表单的唯一布局所有者；两种状态只能替换 fields/actions 叶子。
export function SubscriptionFormScaffold({
  fields,
  actions,
  formRef,
  className,
  ...formProps
}: SubscriptionFormScaffoldProps) {
  return (
    <form
      ref={formRef}
      className={cn("h5-subscription-dialog-form overflow-hidden", className)}
      {...formProps}
    >
      <div
        data-subscription-dialog-scroll=""
        data-dialog-region="subscription-fields"
        className="h5-mobile-sheet-scroll h5-subscription-dialog-scroll grid gap-5 px-6 py-4"
      >
        {fields}
      </div>
      <div
        data-subscription-dialog-footer=""
        data-dialog-region="subscription-actions"
        className="h5-subscription-dialog-footer flex shrink-0 flex-col gap-3 border-t border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end md:p-6 md:pt-4"
      >
        {actions}
      </div>
    </form>
  );
}

export interface SubscriptionFormLoadingStructure {
  cycle: "recurring" | "custom" | "one-time-buyout" | "one-time-fixed-term";
  reminderEnabled: boolean;
  repeatReminderEnabled: boolean;
}

function FieldSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-2", className)}>
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

function PairSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FieldSkeleton />
      <FieldSkeleton />
    </div>
  );
}

function PanelSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-20 w-full rounded-lg", className)} />;
}

export function createSubscriptionFormLoadingSlots({
  label,
  structure,
}: {
  label: string;
  structure: SubscriptionFormLoadingStructure;
}): SubscriptionFormScaffoldSlots {
  const oneTime = structure.cycle === "one-time-buyout" || structure.cycle === "one-time-fixed-term";
  const fixedTerm = structure.cycle === "one-time-fixed-term";

  return {
    fields: (
      <>
        <span className="sr-only">{label}</span>
        <FieldSkeleton />
        <PanelSkeleton className="h-24" />
        <PairSkeleton />
        <PairSkeleton />
        <PairSkeleton />
        {fixedTerm ? <FieldSkeleton /> : null}
        {(structure.cycle === "custom" || oneTime) ? <FieldSkeleton /> : null}
        {!oneTime ? <PanelSkeleton /> : null}
        <PairSkeleton />
        <PanelSkeleton />
        {structure.reminderEnabled ? <FieldSkeleton /> : null}
        {structure.repeatReminderEnabled ? <PanelSkeleton className="h-24" /> : null}
        <PanelSkeleton className="h-24" />
        <PanelSkeleton />
        <FieldSkeleton />
        <PanelSkeleton className="h-28" />
        <FieldSkeleton />
      </>
    ),
    actions: (
      <>
        <Skeleton className="h-10 w-full sm:w-24" />
        <Skeleton className="h-10 w-full sm:w-24" />
      </>
    ),
  };
}
