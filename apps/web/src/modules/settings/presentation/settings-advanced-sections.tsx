import { Component, lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ComponentType, LazyExoticComponent } from "react";
import type { SettingsFormController } from "../application/use-settings-form-controller";
import { getSettingsAdvancedGroup, type SettingsAdvancedGroup } from "./settings-advanced-groups";
import { SettingsAdvancedGroupPlaceholder } from "./settings-advanced-group-placeholder";
import type { SettingsSectionId } from "./settings-section-navigation";

type SettingsAdvancedGroupComponentProps = {
  controller: SettingsFormController;
  onReady?: (() => void) | undefined;
};

const groupLoaders: Record<SettingsAdvancedGroup, () => Promise<{ default: ComponentType<SettingsAdvancedGroupComponentProps> }>> = {
  resourcesAi: () => import("./settings-advanced-group-resources-ai").then((module) => ({ default: module.SettingsAdvancedResourcesAiGroup })),
  budgetData: () => import("./settings-advanced-group-budget-data").then((module) => ({ default: module.SettingsAdvancedBudgetDataGroup })),
  cloudCalendar: () => import("./settings-advanced-group-cloud-calendar").then((module) => ({ default: module.SettingsAdvancedCloudCalendarGroup })),
  publicNotifications: () => import("./settings-advanced-group-public-notifications").then((module) => ({ default: module.SettingsAdvancedPublicNotificationsGroup })),
};

function createLazyGroup(group: SettingsAdvancedGroup): LazyExoticComponent<ComponentType<SettingsAdvancedGroupComponentProps>> {
  return lazy(groupLoaders[group]);
}

const lazyGroups: Record<SettingsAdvancedGroup, LazyExoticComponent<ComponentType<SettingsAdvancedGroupComponentProps>>> = {
  resourcesAi: createLazyGroup("resourcesAi"),
  budgetData: createLazyGroup("budgetData"),
  cloudCalendar: createLazyGroup("cloudCalendar"),
  publicNotifications: createLazyGroup("publicNotifications"),
};

function resetLazyGroup(group: SettingsAdvancedGroup) {
  lazyGroups[group] = createLazyGroup(group);
}

export function preloadSettingsAdvancedGroup(group: SettingsAdvancedGroup): void {
  void groupLoaders[group]().catch(() => undefined);
}

function SettingsAdvancedGroupBoundary({
  group,
  controller,
  onReady,
  onRetry,
  retryVersion,
}: SettingsAdvancedGroupComponentProps & {
  group: SettingsAdvancedGroup;
  onRetry: () => void;
  retryVersion: number;
}) {
  const LazyGroup = lazyGroups[group];
  return (
    <Suspense fallback={<SettingsAdvancedGroupPlaceholder group={group} />}>
      <LazyGroup controller={controller} onReady={onReady} />
    </Suspense>
  );
}

class SettingsAdvancedGroupErrorBoundary extends Component<
  SettingsAdvancedGroupComponentProps & { group: SettingsAdvancedGroup; onRetry: () => void; retryVersion: number },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <SettingsAdvancedGroupPlaceholder group={this.props.group} error onRetry={this.props.onRetry} />;
    }
    return <SettingsAdvancedGroupBoundary {...this.props} />;
  }
}

export function SettingsAdvancedSections({
  controller,
  activeSectionId,
  onReady,
}: {
  controller: SettingsFormController;
  activeSectionId?: SettingsSectionId | undefined;
  onReady?: (() => void) | undefined;
}) {
  const initialGroup = activeSectionId ? getSettingsAdvancedGroup(activeSectionId) : null;
  const [activatedGroups, setActivatedGroups] = useState<Set<SettingsAdvancedGroup>>(
    // 月度预算属于全页保存状态；进入任一高级区块时一并提交它，保证 hash 直达通知等区块仍能编辑全局预算。
    () => (initialGroup ? new Set([initialGroup, ...(initialGroup === "publicNotifications" ? ["budgetData" as const] : [])]) : new Set()),
  );
  const [retryVersions, setRetryVersions] = useState<Record<SettingsAdvancedGroup, number>>({
    resourcesAi: 0,
    budgetData: 0,
    cloudCalendar: 0,
    publicNotifications: 0,
  });
  const activeGroup = activeSectionId ? getSettingsAdvancedGroup(activeSectionId) : null;

  useEffect(() => {
    if (!activeGroup) return;
    setActivatedGroups((current) => {
      const nextGroups = new Set(current);
      nextGroups.add(activeGroup);
      if (activeGroup === "publicNotifications") nextGroups.add("budgetData");
      return nextGroups.size === current.size ? current : nextGroups;
    });
  }, [activeGroup]);

  const groups = useMemo(() => Object.keys(groupLoaders) as SettingsAdvancedGroup[], []);
  return (
    <>
      {groups.map((group) => {
        // 未激活分组只保留占位；真正挂载后才创建该组的远程数据 hook，已激活组保持挂载以保留草稿和查询缓存。
        if (!activatedGroups.has(group)) return <SettingsAdvancedGroupPlaceholder key={group} group={group} />;
        const retry = () => {
          resetLazyGroup(group);
          setRetryVersions((current) => ({ ...current, [group]: current[group] + 1 }));
        };
        return (
          <div key={`${group}-${retryVersions[group]}`} className="contents">
            <SettingsAdvancedGroupErrorBoundary
              group={group}
              controller={controller}
              onReady={onReady}
              onRetry={retry}
              retryVersion={retryVersions[group]}
            />
          </div>
        );
      })}
    </>
  );
}
