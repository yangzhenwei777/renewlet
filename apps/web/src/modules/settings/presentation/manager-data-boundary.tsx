import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import type { SettingsReadState } from "../application/settings-read-state";
import { LoadingButtonContent } from "./settings-shared-controls";

interface ManagerDataBoundaryProps<T> {
  state: SettingsReadState<T>;
  children: ReactNode;
  loading?: ReactNode;
  className?: string;
}

const MANAGER_READ_ERROR_CLASS_NAME =
  "flex flex-col gap-2 border border-destructive/30 bg-destructive/10 p-3 sm:flex-row sm:items-center sm:justify-between";

export function ManagerDataBoundary<T>({
  state,
  children,
  loading,
  className,
}: ManagerDataBoundaryProps<T>) {
  const { t } = useI18n();

  if (state.isInitialLoading) {
    return loading ?? (
      <div role="status" aria-label={t("common.loading")} className={cn("grid gap-2", className)}>
        <Skeleton aria-hidden="true" className="h-28 w-full" />
      </div>
    );
  }

  if (!state.hasData && state.error) {
    return (
      <ManagerReadError
        state={state}
        stale={false}
        className={cn(MANAGER_READ_ERROR_CLASS_NAME, className)}
      />
    );
  }

  return (
    <div className={cn("grid gap-3", className)}>
      {state.error ? <ManagerReadError state={state} stale className={MANAGER_READ_ERROR_CLASS_NAME} /> : null}
      {state.hasData ? children : null}
    </div>
  );
}

function ManagerReadError<T>({
  state,
  stale,
  className,
}: {
  state: SettingsReadState<T>;
  stale: boolean;
  className: string;
}) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className={className}
    >
      <span className="text-sm text-destructive">
        {stale ? t("settings.managerRefreshFailed") : t("settings.managerLoadFailed")}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11 border-border"
        onClick={() => void state.retry()}
        disabled={state.isRefreshing}
        aria-busy={state.isRefreshing ? true : undefined}
      >
        <LoadingButtonContent loading={state.isRefreshing} loadingLabel={t("common.loading")}>
          <RefreshCw className="h-4 w-4" />
          {t("settings.managerRetry")}
        </LoadingButtonContent>
      </Button>
    </div>
  );
}
