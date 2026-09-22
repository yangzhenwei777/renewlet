import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";

interface AdvancedFilterFooterProps {
  active: boolean;
  onClear: () => void;
  onApply: () => void;
  className?: string;
}

export function AdvancedFilterFooter({
  active,
  onClear,
  onApply,
  className,
}: AdvancedFilterFooterProps) {
  const { t } = useI18n();

  return (
    <div className={cn("flex gap-3 border-t border-border bg-card px-5 py-4", className)}>
      {active ? (
        <Button
          type="button"
          variant="ghost"
          className="h-11 shrink-0 text-muted-foreground"
          onClick={onClear}
        >
          {t("subscriptions.advanced.clear")}
        </Button>
      ) : null}
      <Button
        type="button"
        className="h-11 flex-1 bg-primary text-primary-foreground hover:bg-primary-glow"
        onClick={onApply}
      >
        {t("subscriptions.advanced.apply")}
      </Button>
    </div>
  );
}
