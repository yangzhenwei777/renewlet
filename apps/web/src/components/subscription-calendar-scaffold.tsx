import type { HTMLAttributes, ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface SubscriptionCalendarScaffoldProps extends HTMLAttributes<HTMLDivElement> {
  facts: ReactNode;
  syncHeading: ReactNode;
  syncContent: ReactNode;
  oneTimeHeading: ReactNode;
  oneTimeActions: ReactNode;
  notice: ReactNode;
  providerHeading: ReactNode;
  providers: ReactNode;
}

interface SubscriptionCalendarFactRowProps {
  icon?: ReactNode;
  label: ReactNode;
  strong?: boolean;
  value: ReactNode;
}

export type SubscriptionCalendarScaffoldSlots = Pick<
  SubscriptionCalendarScaffoldProps,
  | "facts"
  | "syncHeading"
  | "syncContent"
  | "oneTimeHeading"
  | "oneTimeActions"
  | "notice"
  | "providerHeading"
  | "providers"
>;

export function SubscriptionCalendarScaffold({
  className,
  facts,
  syncHeading,
  syncContent,
  oneTimeHeading,
  oneTimeActions,
  notice,
  providerHeading,
  providers,
  ...props
}: SubscriptionCalendarScaffoldProps) {
  return (
    // Dialog/Drawer 外壳提供确定高度；scaffold 必须持续拥有剩余空间和唯一滚动条，loading 切换只能替换内部 slots。
    <div
      {...props}
      className={cn(
        "h5-mobile-sheet-scroll grid min-h-0 flex-1 content-start gap-5 px-5 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]",
        className,
      )}
      data-dialog-scroll-region="subscription-calendar"
    >
      <dl
        className="grid divide-y divide-border rounded-md border border-border bg-background/50 text-sm"
        data-dialog-region="calendar-facts"
      >
        {facts}
      </dl>
      <section className="grid gap-3 border-t border-border pt-4" data-dialog-region="calendar-feed-actions">
        {syncHeading}
        {syncContent}
      </section>
      <section className="grid gap-3 border-t border-border pt-4" data-dialog-region="calendar-one-time-actions">
        {oneTimeHeading}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">{oneTimeActions}</div>
        {notice}
        <div className="grid gap-2" data-dialog-region="calendar-providers">
          {providerHeading}
          <div className="overflow-hidden rounded-md border border-border bg-background/50">
            {providers}
          </div>
        </div>
      </section>
    </div>
  );
}

export function SubscriptionCalendarFactRow({
  icon,
  label,
  strong = false,
  value,
}: SubscriptionCalendarFactRowProps) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 px-3 py-2">
      <dt className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </dt>
      <dd className={strong ? "min-w-0 text-right font-medium text-foreground" : "min-w-0 text-right text-foreground"}>
        {value}
      </dd>
    </div>
  );
}

export function createSubscriptionCalendarLoadingSlots(label: string): SubscriptionCalendarScaffoldSlots {
  return {
    facts: (
      <>
        <SubscriptionCalendarFactRow
          label={(
            <>
              <span className="sr-only">{label}</span>
              <Skeleton aria-hidden="true" className="h-4 w-24" />
            </>
          )}
          value={<Skeleton aria-hidden="true" className="h-5 w-28" />}
        />
        <SubscriptionCalendarFactRow
          label={<Skeleton aria-hidden="true" className="h-4 w-20" />}
          value={<Skeleton aria-hidden="true" className="h-5 w-24" />}
        />
        <SubscriptionCalendarFactRow
          label={<Skeleton aria-hidden="true" className="h-4 w-20" />}
          value={<Skeleton aria-hidden="true" className="h-5 w-20" />}
        />
      </>
    ),
    syncHeading: <Skeleton className="h-4 w-24" />,
    syncContent: <Skeleton className="h-11 w-full" />,
    oneTimeHeading: <Skeleton className="h-4 w-24" />,
    oneTimeActions: <Skeleton className="h-11 w-full sm:w-32" />,
    notice: <Skeleton className="h-5 w-full" />,
    providerHeading: <Skeleton className="h-4 w-28" />,
    providers: (
      <>
        <Skeleton className="m-3 h-5" />
        <Skeleton className="m-3 h-5" />
        <Skeleton className="m-3 h-5" />
        <Skeleton className="m-3 h-5" />
      </>
    ),
  };
}
