package main

// 更新执行测试只操作临时目录里的伪二进制，保护 checksum、原子替换和单任务重启状态。

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRCUpdateWithoutNewerCandidateReturnsAlreadyLatest(t *testing.T) {
	service := newSystemUpdateService(&fakeSystemReleaseClient{releases: []systemRelease{
		releaseFixture("v0.1.0-rc.1"),
		releaseFixture("v0.1.0"),
	}})
	oldVersion := Version
	Version = "0.1.0-rc.1"
	t.Cleanup(func() { Version = oldVersion })

	_, err := service.performUpdate(context.Background(), localeZhCN, systemUpdateCapability{supported: true}, nil, func(string, string) error { return nil })
	if !errors.Is(err, errSystemUpdateNoUpdate) {
		t.Fatalf("performUpdate error = %v, want errSystemUpdateNoUpdate", err)
	}
	if !strings.Contains(err.Error(), serverText(localeZhCN, "system.alreadyLatest")) {
		t.Fatalf("performUpdate error = %v, want localized already-latest message", err)
	}
}

func TestChecksumForArchive(t *testing.T) {
	hash := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	got, err := checksumForArchive("renewlet_1.0.0_linux_amd64.tar.gz", []byte(hash+"  renewlet_1.0.0_linux_amd64.tar.gz\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got != hash {
		t.Fatalf("checksum = %q, want %q", got, hash)
	}
}

func TestExtractRenewletBinaryRejectsPathTraversal(t *testing.T) {
	archivePath := filepath.Join(t.TempDir(), "bad.tar.gz")
	if err := writeTarGz(archivePath, map[string]string{"../../renewlet": "evil"}); err != nil {
		t.Fatal(err)
	}
	targetPath := filepath.Join(t.TempDir(), "renewlet")
	if err := extractRenewletBinary(archivePath, targetPath); err == nil {
		t.Fatal("expected path traversal archive to be rejected")
	}
}

func TestReplaceRenewletBinaryKeepsCurrentOnPreCommitFailure(t *testing.T) {
	tempDir := t.TempDir()
	binaryPath := filepath.Join(tempDir, "renewlet")
	backupDir := filepath.Join(tempDir, "backups")
	if err := os.WriteFile(binaryPath, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := replaceRenewletBinary(binaryPath, backupDir, filepath.Join(tempDir, "missing"), "1.0.0"); err == nil {
		t.Fatal("expected replace to fail")
	}
	content, err := os.ReadFile(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "old" {
		t.Fatalf("binary content = %q, want old", string(content))
	}
}

func TestReplaceRenewletBinaryUsesHardLinkBackupWithoutOverwritingIt(t *testing.T) {
	tempDir := t.TempDir()
	binaryPath := filepath.Join(tempDir, "renewlet")
	backupDir := filepath.Join(tempDir, "backups")
	newBinaryPath := filepath.Join(tempDir, "renewlet.new")
	if err := os.WriteFile(binaryPath, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	oldInfo, err := os.Stat(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newBinaryPath, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := replaceRenewletBinary(binaryPath, backupDir, newBinaryPath, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(backupDir, "renewlet.1.0.0")
	backupInfo, err := os.Stat(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(oldInfo, backupInfo) {
		t.Fatal("backup must reference the original binary inode")
	}

	secondBinaryPath := filepath.Join(tempDir, "renewlet.second")
	if err := os.WriteFile(secondBinaryPath, []byte("newer"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := replaceRenewletBinary(binaryPath, backupDir, secondBinaryPath, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	backupContent, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(backupContent) != "old" {
		t.Fatalf("existing backup was overwritten: %q", backupContent)
	}
}

func TestSystemUpdateReusesOperationAndCachedReleaseUntilRestart(t *testing.T) {
	service, client, binaryPath := newExecutableSystemUpdateService(t, "1.0.0", "1.1.0")
	checked, err := service.CheckVersion(context.Background(), localeZhCN, true)
	if err != nil {
		t.Fatal(err)
	}
	if checked.ReleaseInfo == nil {
		t.Fatal("expected checked release")
	}
	checked.ReleaseInfo.Version = "9.9.9"
	first, err := service.StartUpdate(localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.StartUpdate(localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Fatalf("concurrent POST created two operations: %q and %q", first.ID, second.ID)
	}

	completed := waitForSystemUpdateTerminal(t, service)
	if completed.Status != systemUpdateStatusSucceeded || completed.Stage != systemUpdateStageRestartPending || !completed.NeedsRestart {
		t.Fatalf("unexpected completed operation: %#v", completed)
	}
	if completed.TargetVersion == nil || *completed.TargetVersion != "1.1.0" {
		t.Fatalf("mutable response leaked into cached release: %#v", completed.TargetVersion)
	}
	content, err := os.ReadFile(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "renewlet-new" {
		t.Fatalf("binary content = %q, want renewlet-new", content)
	}
	if got := atomic.LoadInt32(&client.fetchCount); got != 1 {
		t.Fatalf("release fetch count = %d, want cached single fetch", got)
	}
	if got := atomic.LoadInt32(&client.checksumCount); got != 1 {
		t.Fatalf("checksum fetch count = %d, want 1", got)
	}
	if got := atomic.LoadInt32(&client.downloadCount); got != 1 {
		t.Fatalf("archive download count = %d, want 1", got)
	}
	if got := strings.Join(client.recordedRequests(), ","); got != "checksum,archive" {
		t.Fatalf("asset request order = %q, want checksum before archive", got)
	}

	repeated, err := service.StartUpdate(localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	if repeated.ID != first.ID {
		t.Fatal("restart-pending operation must reject replacement by a new task")
	}
	if err := service.ReserveRestart(localeZhCN); err != nil {
		t.Fatal(err)
	}
	if err := service.ReserveRestart(localeZhCN); !errors.Is(err, errSystemRestartNotPending) {
		t.Fatalf("expected restart reservation to be single-use, got %v", err)
	}
}

func TestSystemUpdateTotalTimeoutBecomesFailedOperation(t *testing.T) {
	service, client, _ := newExecutableSystemUpdateService(t, "1.0.0", "1.1.0")
	client.fetchDelay = 100 * time.Millisecond
	service.operationTimeout = 10 * time.Millisecond
	if _, err := service.StartUpdate(localeZhCN); err != nil {
		t.Fatal(err)
	}
	waitForSystemUpdateTerminal(t, service)
	operation := service.CurrentOperation(localeZhCN)
	if operation.Status != systemUpdateStatusFailed || operation.Error == nil || operation.Error.Code != "SYSTEM_UPDATE_TIMEOUT" {
		t.Fatalf("unexpected timeout operation: %#v", operation)
	}
	if operation.Error.Message != serverText(localeZhCN, "system.updateTimedOut") {
		t.Fatalf("timeout message = %q", operation.Error.Message)
	}
}

func TestSystemUpdateInterruptedUsesStableLocalizedFailure(t *testing.T) {
	if code := systemUpdateFailureCode(context.Canceled); code != "SYSTEM_UPDATE_INTERRUPTED" {
		t.Fatalf("interrupted code = %q", code)
	}
	if message := systemUpdateFailureMessage(localeZhCN, context.Canceled); message != serverText(localeZhCN, "system.updateInterrupted") {
		t.Fatalf("interrupted message = %q", message)
	}
	idleTimeout := newUpstreamTransportError("download made no progress", true)
	if code := systemUpdateFailureCode(idleTimeout); code != "SYSTEM_UPDATE_TIMEOUT" {
		t.Fatalf("idle timeout code = %q", code)
	}
}

func TestSystemUpdateChecksumMismatchBlocksInstallAndAllowsNewOperation(t *testing.T) {
	service, client, binaryPath := newExecutableSystemUpdateService(t, "1.0.0", "1.1.0")
	archiveName := fakeArchiveName(client)
	client.checksumTxt = []byte(strings.Repeat("0", 64) + "  " + archiveName + "\n")

	first, err := service.StartUpdate(localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	failed := waitForSystemUpdateTerminal(t, service)
	if failed.Status != systemUpdateStatusFailed || failed.Error == nil || failed.Error.Code != "SYSTEM_UPDATE_FAILED" {
		t.Fatalf("checksum mismatch operation = %#v", failed)
	}
	if got := atomic.LoadInt32(&client.downloadCount); got != 1 {
		t.Fatalf("checksum mismatch download count = %d, want 1", got)
	}
	content, err := os.ReadFile(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "old" {
		t.Fatalf("checksum mismatch replaced the binary: %q", content)
	}

	second, err := service.StartUpdate(localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID == first.ID {
		t.Fatal("failed operation prevented creation of a new update task")
	}
	secondFailed := waitForSystemUpdateTerminal(t, service)
	if secondFailed.ID != second.ID || secondFailed.Status != systemUpdateStatusFailed {
		t.Fatalf("retry operation = %#v", secondFailed)
	}
	if got := atomic.LoadInt32(&client.downloadCount); got != 2 {
		t.Fatalf("retry download count = %d, want 2", got)
	}
}

func TestSystemRestartRejectedBeforeSuccessfulUpdate(t *testing.T) {
	service := newSystemUpdateService(&fakeSystemReleaseClient{})
	if err := service.ReserveRestart(localeZhCN); !errors.Is(err, errSystemRestartNotPending) {
		t.Fatalf("ReserveRestart error = %v, want restart not pending", err)
	}
}

func newExecutableSystemUpdateService(t *testing.T, currentVersion string, targetVersion string) (*systemUpdateService, *fakeSystemReleaseClient, string) {
	t.Helper()
	tempDir := t.TempDir()
	binaryPath := filepath.Join(tempDir, "renewlet")
	backupDir := filepath.Join(tempDir, "backups")
	if err := os.WriteFile(binaryPath, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	oldVersion, oldBuildType := Version, BuildType
	Version, BuildType = currentVersion, "release"
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})
	release := releaseFixture("v" + targetVersion)
	client := &fakeSystemReleaseClient{release: &release}
	service := newSystemUpdateService(client)
	service.capability = func(appLocale) systemUpdateCapability {
		return systemUpdateCapability{
			deployment: "docker",
			updateMode: "in-app-binary",
			supported:  true,
			binaryPath: binaryPath,
			backupDir:  backupDir,
		}
	}
	if err := service.InitializeState(filepath.Join(tempDir, "pb_data")); err != nil {
		t.Fatal(err)
	}
	service.downloadFnForTest("renewlet-new")
	t.Cleanup(service.Shutdown)
	return service, client, binaryPath
}

func waitForSystemUpdateTerminal(t *testing.T, service *systemUpdateService) *systemUpdateOperationDTO {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		operation := service.CurrentOperation(defaultAppLocale)
		if operation != nil && operation.Status != systemUpdateStatusRunning {
			return operation
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("system update did not reach a terminal state: %#v", service.CurrentOperation(defaultAppLocale))
	return nil
}
