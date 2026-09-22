import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import { getDisplayErrorMessage } from "@/lib/display-error";

interface QueryErrorStateProps {
  error: unknown;
  onRetry: () => unknown;
}

export function QueryErrorState({ error, onRetry }: QueryErrorStateProps) {
  const { t } = useI18n();

  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-16 text-center"
    >
      <AlertCircle className="mb-4 h-8 w-8 text-destructive" aria-hidden="true" />
      <p className="mb-6 text-sm text-destructive">
        {getDisplayErrorMessage(error, t("error.generic"))}
      </p>
      <Button
        type="button"
        variant="outline"
        className="gap-2 border-border"
        onClick={() => void onRetry()}
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        {t("system.retry")}
      </Button>
    </div>
  );
}
