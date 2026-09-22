import { KeyRound, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import type { Passkey } from "@/lib/api/schemas/auth";
import type { SettingsReadState } from "../application/settings-read-state";

export interface AccountPasskeysSectionProps {
  disabled?: boolean;
  state: SettingsReadState<Passkey[]>;
  onManagePasskeys: () => void;
}

export function AccountPasskeysSection({
  disabled = false,
  state,
  onManagePasskeys,
}: AccountPasskeysSectionProps) {
  const { t } = useI18n();

  const countLabel = state.isInitialLoading
    ? t("common.loading")
    : !state.hasData && state.error
      ? t("settings.statusUnknown")
      : state.error
        ? t("settings.passkeyCountStale", { count: state.data?.length ?? 0 })
        : t("settings.passkeyCount", { count: state.data?.length ?? 0 });

  return (
    <div className="grid gap-3 rounded-md border border-border bg-secondary/20 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-foreground">
              {t("settings.passkeysSummary", { summary: countLabel })}
            </h3>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{t("settings.passkeyHelp")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full justify-center gap-2 border-border sm:w-auto"
          disabled={disabled}
          onClick={onManagePasskeys}
        >
          <SlidersHorizontal className="h-4 w-4" />
          {t("settings.passkeysManage")}
        </Button>
      </div>
    </div>
  );
}
