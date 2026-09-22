import { lazy, Suspense, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n/I18nProvider";
import type { SettingsFormController } from "../application/use-settings-form-controller";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-section-navigation";
import { SETTINGS_SECTION_FRAME_CLASS } from "./settings-layout";
import { ADVANCED_SETTINGS_SECTION_IDS, isAdvancedSettingsSection } from "./settings-section-groups";

const advancedSettingsSections = SETTINGS_SECTIONS.filter((section) =>
  ADVANCED_SETTINGS_SECTION_IDS.some((id) => id === section.id),
);
const loadSettingsAdvancedSections = () => import("./settings-advanced-sections");
const LazySettingsAdvancedSections = lazy(() =>
  loadSettingsAdvancedSections().then((module) => ({ default: module.SettingsAdvancedSections })),
);

export function preloadSettingsAdvancedSections(): void {
  void loadSettingsAdvancedSections().catch(() => undefined);
}

function SettingsAdvancedSectionsLoading() {
  const { t } = useI18n();

  return (
    <>
      {advancedSettingsSections.map((section) => (
        <section key={section.id} id={section.id} className={`${SETTINGS_SECTION_FRAME_CLASS} min-h-48`} aria-busy="true">
          <h2 className="mb-6 text-lg font-semibold text-foreground">{t(section.labelKey)}</h2>
          <div className="grid gap-3" aria-hidden="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </section>
      ))}
    </>
  );
}

function hashTargetsAdvancedSection(): boolean {
  if (typeof window === "undefined") return false;
  const id = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  return ADVANCED_SETTINGS_SECTION_IDS.some((candidate) => candidate === id);
}

export function DeferredSettingsAdvancedSections({
  controller,
  activeSectionId,
  onReady,
}: {
  controller: SettingsFormController;
  activeSectionId: SettingsSectionId;
  onReady: () => void;
}) {
  const [activated, setActivated] = useState(hashTargetsAdvancedSection);

  useEffect(() => {
    // 显示区块是高级设置前的预取哨兵；目录 intent 会更早下载模块，普通滚动也能在进入下一段前完成装载。
    if (activeSectionId === "settings-display" || isAdvancedSettingsSection(activeSectionId)) {
      setActivated(true);
    }
  }, [activeSectionId]);

  if (!activated) return <SettingsAdvancedSectionsLoading />;

  return (
    <Suspense fallback={<SettingsAdvancedSectionsLoading />}>
      <LazySettingsAdvancedSections controller={controller} onReady={onReady} />
    </Suspense>
  );
}
