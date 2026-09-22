import { RawErrorResponseDialog } from "@/components/raw-error-response-dialog";
import { useI18n } from "@/i18n/I18nProvider";
import type { CloudBackupErrorDetailsView } from "@/lib/cloud-backup-error-details";

// 云备份上游错误可能包含 WebDAV/S3 响应正文；这里只展示当前请求返回的脱敏文本。
interface CloudBackupErrorDetailsDialogProps {
  open: boolean;
  details: CloudBackupErrorDetailsView | null;
  onOpenChange: (open: boolean) => void;
}

export function CloudBackupErrorDetailsDialog({ open, details, onOpenChange }: CloudBackupErrorDetailsDialogProps) {
  const { t } = useI18n();
  return (
    <RawErrorResponseDialog
      open={open}
      details={details}
      onOpenChange={onOpenChange}
      title={t("settings.cloudBackupUpstreamTitle")}
      description={t("settings.cloudBackupUpstreamDescription")}
      testId="cloud-backup-error-details-dialog"
    />
  );
}
