import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import { SETTINGS_SECTION_FRAME_CLASS } from "./settings-layout";
import { getSettingsAdvancedGroupSections, type SettingsAdvancedGroup } from "./settings-advanced-groups";

export function SettingsAdvancedGroupPlaceholder({
  group,
  error = false,
  onRetry,
}: {
  group: SettingsAdvancedGroup;
  error?: boolean;
  onRetry?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const sections = getSettingsAdvancedGroupSections(group);

  return (
    <>
      {sections.map((section) => (
        <section key={section.id} id={section.id} className={`${SETTINGS_SECTION_FRAME_CLASS} min-h-48`} aria-busy={!error}>
          <h2 className="mb-6 text-lg font-semibold text-foreground">{t(section.labelKey)}</h2>
          {error ? (
            <div role="alert" className="grid gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-muted-foreground">
              <p>{t("appError.description")}</p>
              {onRetry ? <Button type="button" variant="outline" className="min-h-11 w-fit" onClick={onRetry}>{t("system.retry")}</Button> : null}
            </div>
          ) : (
            <div className="grid gap-3" aria-hidden="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
        </section>
      ))}
    </>
  );
}
