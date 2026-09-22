package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSystemUpdateShutdownRejectsNewOperations(t *testing.T) {
	service := newSystemUpdateService(&fakeSystemReleaseClient{})
	service.Shutdown()
	if _, err := service.StartUpdate(localeZhCN); !errors.Is(err, context.Canceled) {
		t.Fatalf("StartUpdate after shutdown error = %v, want context canceled", err)
	}
}

func TestSystemUpdateStagesAreMonotonic(t *testing.T) {
	service := newSystemUpdateService(&fakeSystemReleaseClient{})
	now := time.Now().UTC().Format(time.RFC3339Nano)
	service.operation = &systemUpdateOperationDTO{
		ID:             "operation",
		Status:         systemUpdateStatusRunning,
		Stage:          systemUpdateStageChecking,
		CurrentVersion: "1.0.0",
		StartedAt:      now,
		UpdatedAt:      now,
	}
	if err := service.advanceOperation("operation", systemUpdateStageInstalling, "1.1.0"); err == nil {
		t.Fatal("expected out-of-order stage transition to fail")
	}
	if service.CurrentOperation(defaultAppLocale).Stage != systemUpdateStageChecking {
		t.Fatal("invalid transition changed operation state")
	}
	if err := service.advanceOperation("operation", systemUpdateStageDownloading, "1.1.0"); err != nil {
		t.Fatal(err)
	}
	if err := service.advanceOperation("operation", systemUpdateStageVerifying, "1.2.0"); err == nil {
		t.Fatal("expected target version drift to fail")
	}
	if service.CurrentOperation(defaultAppLocale).Stage != systemUpdateStageDownloading {
		t.Fatal("target version drift changed operation state")
	}
}

func TestSystemUpdateRecoveryCheckpointExcludesRawUpstreamDetails(t *testing.T) {
	dataDir := t.TempDir()
	service := newSystemUpdateService(&fakeSystemReleaseClient{})
	if err := service.InitializeState(dataDir); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	service.operation = &systemUpdateOperationDTO{
		ID:             "operation",
		Status:         systemUpdateStatusFailed,
		Stage:          systemUpdateStageDownloading,
		CurrentVersion: Version,
		TargetVersion:  systemUpdateStringPointer("1.1.0"),
		StartedAt:      now,
		UpdatedAt:      now,
		FinishedAt:     &now,
		Error: &systemUpdateOperationErrorDTO{
			Code:    "SYSTEM_UPDATE_FAILED",
			Message: "safe message",
			Details: &upstreamErrorDetails{RawResponseText: systemUpdateStringPointer("private upstream body")},
		},
	}
	service.operationMu.Lock()
	err := service.persistOperationLocked()
	service.operationMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(dataDir, systemUpdateStateDirectory, systemUpdateStateFilename)
	data, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	stateText := string(data)
	if strings.Contains(stateText, "private upstream body") || strings.Contains(stateText, "safe message") || strings.Contains(stateText, "details") || strings.Contains(stateText, `"status"`) || strings.Contains(stateText, `"needsRestart"`) {
		t.Fatalf("recovery checkpoint persisted request-scoped details: %s", stateText)
	}
	if !strings.Contains(stateText, "SYSTEM_UPDATE_FAILED") {
		t.Fatalf("recovery checkpoint lost safe error code: %s", stateText)
	}

	recovered := newSystemUpdateService(&fakeSystemReleaseClient{})
	if err := recovered.InitializeState(dataDir); err != nil {
		t.Fatal(err)
	}
	operation := recovered.CurrentOperation(defaultAppLocale)
	if operation == nil || operation.Error == nil || operation.Error.Code != "SYSTEM_UPDATE_FAILED" || operation.Error.Details != nil {
		t.Fatalf("unexpected recovered operation: %#v", operation)
	}
}

func TestSystemUpdateRecoveryIgnoresCorruptCheckpoint(t *testing.T) {
	dataDir := t.TempDir()
	directory := filepath.Join(dataDir, systemUpdateStateDirectory)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, systemUpdateStateFilename), []byte(`{"version":1,"operation":null} trailing`), 0o600); err != nil {
		t.Fatal(err)
	}
	service := newSystemUpdateService(&fakeSystemReleaseClient{})
	if err := service.InitializeState(dataDir); err != nil {
		t.Fatal(err)
	}
	if service.CurrentOperation(defaultAppLocale) != nil {
		t.Fatal("corrupt recovery checkpoint must not create an operation")
	}
}

func TestSystemUpdateRecoveryReconcilesInstalledVersion(t *testing.T) {
	dataDir := t.TempDir()
	oldVersion := Version
	Version = "1.0.0"
	t.Cleanup(func() { Version = oldVersion })
	now := time.Now().UTC().Format(time.RFC3339Nano)
	service := newSystemUpdateService(&fakeSystemReleaseClient{})
	if err := service.InitializeState(dataDir); err != nil {
		t.Fatal(err)
	}
	service.operation = &systemUpdateOperationDTO{
		ID:             "operation",
		Status:         systemUpdateStatusSucceeded,
		Stage:          systemUpdateStageRestartPending,
		CurrentVersion: "1.0.0",
		TargetVersion:  systemUpdateStringPointer("1.1.0"),
		StartedAt:      now,
		UpdatedAt:      now,
		FinishedAt:     &now,
		NeedsRestart:   true,
	}
	service.operationMu.Lock()
	err := service.persistOperationLocked()
	service.operationMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}

	Version = "1.1.0"
	recovered := newSystemUpdateService(&fakeSystemReleaseClient{})
	if err := recovered.InitializeState(dataDir); err != nil {
		t.Fatal(err)
	}
	operation := recovered.CurrentOperation(defaultAppLocale)
	if operation == nil || operation.Status != systemUpdateStatusSucceeded || operation.Stage != systemUpdateStageCompleted || operation.NeedsRestart {
		t.Fatalf("unexpected reconciled operation: %#v", operation)
	}
}

func systemUpdateStringPointer(value string) *string {
	return &value
}
