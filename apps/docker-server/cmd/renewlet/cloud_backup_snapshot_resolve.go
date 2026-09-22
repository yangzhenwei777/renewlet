package main

import (
	"context"

	"github.com/pocketbase/pocketbase/core"
)

func downloadCloudBackupSnapshotWithoutProvider(ctx context.Context, app core.App, userID string, id string) ([]byte, cloudBackupSnapshotManifest, error) {
	_, targets, err := configuredCloudBackupTargets(app, userID)
	if err != nil {
		return nil, cloudBackupSnapshotManifest{}, err
	}
	return downloadCloudBackupSnapshotFromTargets(ctx, targets, id)
}

func downloadCloudBackupSnapshotFromTargets(ctx context.Context, targets []cloudBackupTarget, id string) ([]byte, cloudBackupSnapshotManifest, error) {
	attempts := []cloudBackupProviderAttempt{}
	for _, target := range targets {
		content, manifest, err := target.Client.Download(ctx, id)
		if err != nil {
			attempts = append(attempts, cloudBackupProviderAttemptFromError(target.Provider, "CLOUD_BACKUP_DOWNLOAD_FAILED", "internal", err))
			continue
		}
		if err := verifyCloudBackupSnapshotBytes(content, manifest); err != nil {
			attempts = append(attempts, cloudBackupProviderAttemptFromError(target.Provider, "CLOUD_BACKUP_CHECKSUM_FAILED", "checksum_failed", err))
			continue
		}
		return content, manifest, nil
	}
	return nil, cloudBackupSnapshotManifest{}, cloudBackupProviderAttemptsError(
		"CLOUD_BACKUP_DOWNLOAD_FAILED",
		"No configured cloud backup target returned a valid snapshot.",
		attempts,
	)
}

func deleteCloudBackupSnapshotWithoutProvider(ctx context.Context, app core.App, userID string, id string) error {
	_, targets, err := configuredCloudBackupTargets(app, userID)
	if err != nil {
		return err
	}
	return deleteCloudBackupSnapshotFromTargets(ctx, targets, id)
}

func deleteCloudBackupSnapshotFromTargets(ctx context.Context, targets []cloudBackupTarget, id string) error {
	matches := []cloudBackupTarget{}
	attempts := []cloudBackupProviderAttempt{}
	failedList := false
	for _, target := range targets {
		manifests, err := target.Client.List(ctx)
		if err != nil {
			failedList = true
			attempts = append(attempts, cloudBackupProviderAttemptFromError(target.Provider, "CLOUD_BACKUP_LIST_FAILED", "internal", err))
			continue
		}
		if cloudBackupManifestListContains(manifests, id) {
			matches = append(matches, target)
			attempts = append(attempts, cloudBackupProviderAttempt{
				Provider: target.Provider,
				Code:     "CLOUD_BACKUP_SNAPSHOT_FOUND",
				Message:  "Snapshot exists in this provider.",
			})
			continue
		}
		attempts = append(attempts, cloudBackupProviderAttempt{
			Provider: target.Provider,
			Code:     "CLOUD_BACKUP_SNAPSHOT_NOT_FOUND",
			Message:  "Snapshot was not listed by this provider.",
		})
	}
	if len(matches) == 1 && !failedList {
		return matches[0].Client.Delete(ctx, id)
	}
	if len(matches) > 0 {
		// 缺 provider 的删除只有在唯一目标可证明时才执行；双目标命中或目标状态未知都必须让调用方显式指定。
		return cloudBackupProviderAttemptsError(
			"CLOUD_BACKUP_PROVIDER_REQUIRED",
			"Snapshot may exist in multiple cloud backup targets. Use provider=webdav or provider=s3.",
			attempts,
		)
	}
	return cloudBackupProviderAttemptsError(
		"CLOUD_BACKUP_DELETE_FAILED",
		"No configured cloud backup target listed this snapshot.",
		attempts,
	)
}

func cloudBackupManifestListContains(manifests []cloudBackupSnapshotManifest, id string) bool {
	for _, manifest := range manifests {
		if manifest.ID == id {
			return true
		}
	}
	return false
}
