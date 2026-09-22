import { useState } from "react";
import { RawErrorResponseDialog } from "@/components/raw-error-response-dialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import type { RawErrorResponseDetails } from "@/lib/raw-error-response";

interface ExchangeRateErrorFeedbackProps {
  error: string;
  details: RawErrorResponseDetails | null;
}

export function ExchangeRateErrorFeedback({ error, details }: ExchangeRateErrorFeedbackProps) {
  const { t } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <>
      <div
        role="alert"
        className="mb-4 flex flex-col gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-600 sm:flex-row sm:items-center sm:justify-between"
      >
        <span className="min-w-0 wrap-break-word">
          {t("exchangeRates.failedWithFallback", { error })}
        </span>
        {details ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full border-amber-500/30 bg-transparent text-amber-700 hover:bg-amber-500/10 dark:text-amber-300 sm:w-auto"
            onClick={() => setDetailsOpen(true)}
          >
            {t("rawErrorResponse.open")}
          </Button>
        ) : null}
      </div>

      <RawErrorResponseDialog
        open={detailsOpen}
        details={details}
        onOpenChange={setDetailsOpen}
        testId="exchange-rates-raw-error-response-dialog"
      />
    </>
  );
}
