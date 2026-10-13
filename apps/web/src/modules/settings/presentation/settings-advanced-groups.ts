import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-section-navigation";

export const SETTINGS_ADVANCED_GROUPS = {
  resourcesAi: ["settings-icon-sources", "settings-uploaded-icons", "settings-ai-recognition"],
  budgetData: ["settings-budget", "settings-data-config", "settings-exchange"],
  cloudCalendar: ["settings-cloud-backup", "settings-calendar-feed"],
  publicNotifications: ["settings-public-status", "settings-public-api", "settings-timezone", "settings-notifications"],
} as const satisfies Record<string, readonly SettingsSectionId[]>;

export type SettingsAdvancedGroup = keyof typeof SETTINGS_ADVANCED_GROUPS;

export function getSettingsAdvancedGroup(id: SettingsSectionId): SettingsAdvancedGroup | null {
  for (const [group, sectionIds] of Object.entries(SETTINGS_ADVANCED_GROUPS) as Array<[SettingsAdvancedGroup, readonly SettingsSectionId[]]>) {
    if (sectionIds.includes(id)) return group;
  }
  return null;
}

export function getSettingsAdvancedGroupSections(group: SettingsAdvancedGroup) {
  const sectionIds = SETTINGS_ADVANCED_GROUPS[group];
  return SETTINGS_SECTIONS.filter((section) => sectionIds.some((sectionId) => sectionId === section.id));
}
