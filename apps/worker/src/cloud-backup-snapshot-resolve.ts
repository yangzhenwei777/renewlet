import { CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS, type CloudBackupProvider, type CloudBackupSnapshotManifest } from "@renewlet/shared/schemas/cloud-backup";
import { CloudBackupRemoteError, sha256Hex, type CloudBackupRemoteClient } from "./cloud-backup-remote";

export type CloudBackupTarget = { provider: CloudBackupProvider; client: CloudBackupRemoteClient };

type Attempt = { provider: CloudBackupProvider; code: string; details?: CloudBackupRemoteError["details"] };

export async function downloadCloudBackupFromTargets(targets: CloudBackupTarget[], id: string): Promise<{ content: Uint8Array; manifest: CloudBackupSnapshotManifest }> {
  const attempts: Attempt[] = [];
  for (const target of targets) {
    try {
      const result = await target.client.download(id);
      const integrityError = await verifySnapshotBytes(result.content, result.manifest);
      if (integrityError) {
        attempts.push(attemptFromError(target.provider, "CLOUD_BACKUP_CHECKSUM_FAILED", integrityError));
        continue;
      }
      return result;
    } catch (error) {
      attempts.push(attemptFromError(target.provider, "CLOUD_BACKUP_LOCAL_DOWNLOAD_FAILED", error));
    }
  }
  throw providerResolutionError("CLOUD_BACKUP_DOWNLOAD_PROVIDER_RESOLUTION_FAILED", attempts);
}

export async function deleteCloudBackupFromTargets(targets: CloudBackupTarget[], id: string): Promise<void> {
  const matches: CloudBackupTarget[] = [];
  const attempts: Attempt[] = [];
  let failedList = false;
  for (const target of targets) {
    try {
      const manifests = await target.client.list();
      if (manifests.some((manifest) => manifest.id === id)) {
        matches.push(target);
        attempts.push({ provider: target.provider, code: "CLOUD_BACKUP_SNAPSHOT_FOUND" });
      } else {
        attempts.push({ provider: target.provider, code: "CLOUD_BACKUP_SNAPSHOT_NOT_FOUND" });
      }
    } catch (error) {
      failedList = true;
      attempts.push(attemptFromError(target.provider, "CLOUD_BACKUP_LOCAL_LIST_FAILED", error));
    }
  }
  const [match] = matches;
  if (match && matches.length === 1 && !failedList) {
    await match.client.delete(id);
    return;
  }
  if (matches.length > 0) throw providerResolutionError("CLOUD_BACKUP_PROVIDER_REQUIRED", attempts);
  throw providerResolutionError("CLOUD_BACKUP_DELETE_PROVIDER_RESOLUTION_FAILED", attempts);
}

async function verifySnapshotBytes(content: Uint8Array, manifest: CloudBackupSnapshotManifest): Promise<CloudBackupRemoteError | null> {
  if (manifest.kind !== "renewlet-cloud-backup-snapshot" || manifest.schemaVersion !== 1) return checksumError(manifest, "Manifest schema is invalid.");
  if (manifest.sizeBytes !== content.length) return checksumError(manifest, "Snapshot size does not match its manifest.");
  if ((await sha256Hex(content)) !== manifest.sha256.toLowerCase()) return checksumError(manifest, "Snapshot SHA-256 does not match its manifest.");
  return null;
}

function checksumError(manifest: CloudBackupSnapshotManifest, message: string): CloudBackupRemoteError {
  return new CloudBackupRemoteError("CLOUD_BACKUP_CHECKSUM_FAILED", {
    operation: "local",
    target: `snapshot=${manifest.id}`,
    clientMessage: message,
  });
}

function providerResolutionError(code: string, attempts: Attempt[]): CloudBackupRemoteError {
  return new CloudBackupRemoteError(code, {
    operation: "provider-resolution",
    target: "configured cloud backup targets",
    attempts,
  });
}

function attemptFromError(provider: CloudBackupProvider, fallbackCode: string, error: unknown): Attempt {
  if (error instanceof CloudBackupRemoteError) return { provider, code: error.code, details: error.details };
  return {
    provider,
    code: fallbackCode,
    details: {
      operation: "local",
      target: "cloud backup",
      clientMessage: errorMessage(error).slice(0, CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
