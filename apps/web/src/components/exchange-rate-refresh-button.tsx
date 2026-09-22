import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";

interface ExchangeRateRefreshButtonProps {
  label: string;
  pending: boolean;
  onRefresh: () => void | Promise<void>;
  className?: string;
}

export function ExchangeRateRefreshButton({
  label,
  pending,
  onRefresh,
  className,
}: ExchangeRateRefreshButtonProps) {
  const { t } = useI18n();

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void onRefresh()}
      disabled={pending}
      aria-busy={pending ? true : undefined}
      className={cn("min-w-32 gap-2", className)}
    >
      <RefreshCw aria-hidden="true" className={cn("h-4 w-4", pending && "animate-spin")} />
      {pending ? t("exchangeRates.refreshing") : label}
    </Button>
  );
}
