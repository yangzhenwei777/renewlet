import type { SettingsSectionId } from "./settings-section-navigation";

export const ADVANCED_SETTINGS_SECTION_IDS = [
  "settings-icon-sources",
  "settings-uploaded-icons",
  "settings-ai-recognition",
  "settings-budget",
  "settings-data-config",
  "settings-cloud-backup",
  "settings-exchange",
  "settings-calendar-feed",
  "settings-public-status",
  "settings-public-api",
  "settings-timezone",
  "settings-notifications",
] as const satisfies readonly SettingsSectionId[];

export function isAdvancedSettingsSection(id: SettingsSectionId): boolean {
  return ADVANCED_SETTINGS_SECTION_IDS.some((candidate) => candidate === id);
}
