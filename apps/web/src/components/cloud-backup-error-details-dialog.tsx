import { RawErrorResponseDialog } from "@/components/raw-error-response-dialog";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";
import type { CloudBackupErrorDetailsView } from "@/lib/cloud-backup-error-details";

interface CloudBackupErrorDetailsDialogProps {
  open: boolean;
  details: CloudBackupErrorDetailsView | null;
  onOpenChange: (open: boolean) => void;
}

export function CloudBackupErrorDetailsDialog({ open, details, onOpenChange }: CloudBackupErrorDetailsDialogProps) {
  const { t } = useI18n();
  const displayDetails = details?.structured;
  const responseText = displayDetails
    ? [
      `${t("settings.cloudBackupError.stage")}: ${details?.code ?? ""}`,
      displayDetails.provider ? `${t("settings.cloudBackupError.provider")}: ${providerLabel(displayDetails.provider, t)}` : "",
      `${t("settings.cloudBackupError.operation")}: ${operationLabel(displayDetails.operation, t)}`,
      `${t("settings.cloudBackupError.target")}: ${displayDetails.target}`,
      displayDetails.httpStatus ? `${t("settings.cloudBackupError.httpStatus")}: ${displayDetails.httpStatus}${displayDetails.httpStatusText ? ` ${displayDetails.httpStatusText}` : ""}` : "",
      displayDetails.providerCode ? `${t("settings.cloudBackupError.providerCode")}: ${displayDetails.providerCode}` : "",
      displayDetails.requestId ? `${t("settings.cloudBackupError.requestId")}: ${displayDetails.requestId}` : "",
      displayDetails.requiredCapability ? `${t("settings.cloudBackupError.requiredCapability")}: ${capabilityLabel(displayDetails.requiredCapability, t)}` : "",
      displayDetails.clientMessage ? `${t("settings.cloudBackupError.clientMessage")}:\n${displayDetails.clientMessage}` : "",
      displayDetails.providerMessage ? `${t("settings.cloudBackupError.providerMessage")}:\n${displayDetails.providerMessage}` : "",
      ...(displayDetails.cleanup ?? []).map((item) => `${t("settings.cloudBackupError.cleanup")}: ${operationLabel(item.operation, t)} ${item.target} · ${item.code}\n${item.message}`),
      ...(displayDetails.attempts ?? []).map((item) => formatAttempt(item, t)),
    ].filter(Boolean).join("\n\n")
    : details?.responseText || "";

  return (
    <RawErrorResponseDialog
      open={open}
      details={details ? { message: details.message, responseText } : null}
      onOpenChange={onOpenChange}
      title={t("settings.cloudBackupUpstreamTitle")}
      description={t("settings.cloudBackupUpstreamDescription")}
      testId="cloud-backup-error-details-dialog"
    />
  );
}

function formatAttempt(
  attempt: NonNullable<NonNullable<CloudBackupErrorDetailsView["structured"]>["attempts"]>[number],
  translate: (id: MessageKey) => string,
): string {
  const details = attempt.details;
  const nested = details
    ? [
      `${translate("settings.cloudBackupError.operation")}: ${operationLabel(details.operation, translate)}`,
      `${translate("settings.cloudBackupError.target")}: ${details.target}`,
      details.httpStatus ? `${translate("settings.cloudBackupError.httpStatus")}: ${details.httpStatus}${details.httpStatusText ? ` ${details.httpStatusText}` : ""}` : "",
      details.providerCode ? `${translate("settings.cloudBackupError.providerCode")}: ${details.providerCode}` : "",
      details.requiredCapability ? `${translate("settings.cloudBackupError.requiredCapability")}: ${capabilityLabel(details.requiredCapability, translate)}` : "",
      details.clientMessage ? `${translate("settings.cloudBackupError.clientMessage")}:\n${details.clientMessage}` : "",
      details.providerMessage ? `${translate("settings.cloudBackupError.providerMessage")}:\n${details.providerMessage}` : "",
    ].filter(Boolean).join("\n")
    : "";
  return `${translate("settings.cloudBackupError.attempt")}: ${providerLabel(attempt.provider, translate)} · ${attempt.code}${nested ? `\n${nested}` : ""}`;
}

function providerLabel(provider: "webdav" | "s3", translate: (id: MessageKey) => string): string {
  return provider === "s3"
    ? translate("settings.cloudBackupProviderS3")
    : translate("settings.cloudBackupProviderWebdav");
}

function capabilityLabel(value: string, translate: (id: MessageKey) => string): string {
  const keyByCapability: Record<string, MessageKey> = {
    "object write permission": "settings.cloudBackupError.capability.objectWrite",
    "object read permission": "settings.cloudBackupError.capability.objectRead",
    "bucket listing permission": "settings.cloudBackupError.capability.bucketList",
    "object delete permission": "settings.cloudBackupError.capability.objectDelete",
  };
  const key = keyByCapability[value];
  return key ? translate(key) : value;
}

function operationLabel(value: string, translate: (id: MessageKey) => string): string {
  const keyByOperation: Record<string, MessageKey> = {
    PutObject: "settings.cloudBackupError.operation.putObject",
    HeadObject: "settings.cloudBackupError.operation.headObject",
    GetObject: "settings.cloudBackupError.operation.getObject",
    ListObjectsV2: "settings.cloudBackupError.operation.listObjects",
    DeleteObject: "settings.cloudBackupError.operation.deleteObject",
    PUT: "settings.cloudBackupError.operation.put",
    PROPFIND: "settings.cloudBackupError.operation.propfind",
    MKCOL: "settings.cloudBackupError.operation.mkcol",
    GET: "settings.cloudBackupError.operation.get",
    DELETE: "settings.cloudBackupError.operation.delete",
    manifest: "settings.cloudBackupError.operation.manifest",
    endpoint: "settings.cloudBackupError.operation.endpoint",
    local: "settings.cloudBackupError.operation.local",
    "provider-resolution": "settings.cloudBackupError.operation.providerResolution",
    upload: "settings.cloudBackupError.operation.upload",
  };
  const key = keyByOperation[value];
  return key ? translate(key) : value;
}
