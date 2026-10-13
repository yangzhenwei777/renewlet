import { useLayoutEffect, useRef, useState } from "react";
import { DeferredImportDataDialog } from "@/components/import-data-dialog-loader";
import { CLOUD_BACKUP_MAX_SNAPSHOT_BYTES } from "@/lib/api/schemas/cloud-backup";
import { useCloudBackupController } from "../application/use-cloud-backup-controller";
import { useCalendarFeedSettingsController } from "../application/use-calendar-feed-settings-controller";
import type { SettingsFormController } from "../application/use-settings-form-controller";
import { CalendarFeedSection } from "./calendar-feed-section";
import { CloudBackupSection } from "./cloud-backup-section";
import { SETTINGS_SECTION_SCROLL_CLASS } from "./settings-layout";

export function SettingsAdvancedCloudCalendarGroup({
  controller,
  onReady,
}: {
  controller: SettingsFormController;
  onReady?: (() => void) | undefined;
}) {
  const { settings, customConfig, externalIntegrationsDisabled } = controller;
  const [cloudBackupImportOpen, setCloudBackupImportOpen] = useState(false);
  const [cloudBackupRestoreFile, setCloudBackupRestoreFile] = useState<File | null>(null);
  const cloudBackup = useCloudBackupController((file) => {
    setCloudBackupRestoreFile(file);
    setCloudBackupImportOpen(true);
  });
  const calendarFeed = useCalendarFeedSettingsController();
  const readyRef = useRef(false);

  useLayoutEffect(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    onReady?.();
  }, [onReady]);

  return (
    <>
      <CloudBackupSection id="settings-cloud-backup" className={SETTINGS_SECTION_SCROLL_CLASS} controller={cloudBackup} disabled={externalIntegrationsDisabled} />
      <CalendarFeedSection id="settings-calendar-feed" className={SETTINGS_SECTION_SCROLL_CLASS} controller={calendarFeed} />
      <DeferredImportDataDialog
        open={cloudBackupImportOpen}
        onOpenChange={setCloudBackupImportOpen}
        settings={settings}
        config={customConfig}
        initialFile={cloudBackupRestoreFile}
        initialFileMaxBytes={CLOUD_BACKUP_MAX_SNAPSHOT_BYTES}
        onInitialFileConsumed={() => setCloudBackupRestoreFile(null)}
      />
    </>
  );
}
