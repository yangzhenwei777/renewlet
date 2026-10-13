import { Component, lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { SettingsFormController } from "../application/use-settings-form-controller";
import { getSettingsAdvancedGroup, SETTINGS_ADVANCED_GROUPS, type SettingsAdvancedGroup } from "./settings-advanced-groups";
import { SettingsAdvancedGroupPlaceholder } from "./settings-advanced-group-placeholder";
import type { SettingsSectionId } from "./settings-section-navigation";

type SettingsAdvancedSectionsProps = {
  controller: SettingsFormController;
  activeSectionId: SettingsSectionId;
  onReady: () => void;
};

const loadSettingsAdvancedSections = () => import("./settings-advanced-sections").then((module) => ({ default: module.SettingsAdvancedSections }));

let LazySettingsAdvancedSections = lazy(loadSettingsAdvancedSections);

function resetLazySettingsAdvancedSections() {
  LazySettingsAdvancedSections = lazy(loadSettingsAdvancedSections);
}

const groupPreloaders: Record<SettingsAdvancedGroup, () => Promise<unknown>> = {
  resourcesAi: () => import("./settings-advanced-group-resources-ai"),
  budgetData: () => import("./settings-advanced-group-budget-data"),
  cloudCalendar: () => import("./settings-advanced-group-cloud-calendar"),
  publicNotifications: () => import("./settings-advanced-group-public-notifications"),
};

export function preloadSettingsAdvancedSections(sectionId?: SettingsSectionId): void {
  void loadSettingsAdvancedSections().catch(() => undefined);
  if (sectionId) {
    const group = getSettingsAdvancedGroup(sectionId);
    if (group) void groupPreloaders[group]().catch(() => undefined);
  }
}

function SettingsAdvancedSectionsLoading() {
  const groups = Object.keys(SETTINGS_ADVANCED_GROUPS) as SettingsAdvancedGroup[];
  return <>{groups.map((group) => <SettingsAdvancedGroupPlaceholder key={group} group={group} />)}</>;
}

function hashTargetsAdvancedSection(): boolean {
  if (typeof window === "undefined") return false;
  const id = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  return getSettingsAdvancedGroup(id as SettingsSectionId) !== null;
}

class SettingsAdvancedSectionsErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      const groups = Object.keys(SETTINGS_ADVANCED_GROUPS) as SettingsAdvancedGroup[];
      return <>{groups.map((group) => <SettingsAdvancedGroupPlaceholder key={group} group={group} error onRetry={this.props.onRetry} />)}</>;
    }
    return this.props.children;
  }
}

export function DeferredSettingsAdvancedSections({
  controller,
  activeSectionId,
  onReady,
}: SettingsAdvancedSectionsProps) {
  const [activated, setActivated] = useState(hashTargetsAdvancedSection);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    // 显示区块是高级设置前的预取哨兵；目录 intent 会更早下载分组，组内数据 hook 只在分组挂载后启动。
    if (activeSectionId === "settings-display" || getSettingsAdvancedGroup(activeSectionId)) setActivated(true);
  }, [activeSectionId]);

  if (!activated) return <SettingsAdvancedSectionsLoading />;

  const retry = () => {
    resetLazySettingsAdvancedSections();
    setRetryVersion((version) => version + 1);
  };
  return (
    <SettingsAdvancedSectionsErrorBoundary key={retryVersion} onRetry={retry}>
      <Suspense fallback={<SettingsAdvancedSectionsLoading />}>
        <LazySettingsAdvancedSections controller={controller} activeSectionId={activeSectionId} onReady={onReady} />
      </Suspense>
    </SettingsAdvancedSectionsErrorBoundary>
  );
}
