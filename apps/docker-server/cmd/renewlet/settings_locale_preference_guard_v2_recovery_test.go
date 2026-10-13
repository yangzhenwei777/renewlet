package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func readLocaleGuardV2RecoveryPoint(t *testing.T, app core.App) []byte {
	t.Helper()
	fsys, err := app.NewBackupsFilesystem()
	if err != nil {
		t.Fatal(err)
	}
	defer fsys.Close()
	reader, err := fsys.GetReader(settingsLocalePreferenceGuardV2RecoveryPoint)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestSettingsLocalePreferenceGuardV2RecoveryPointPrecedesUpgrade(t *testing.T) {
	app := newSchemaTestApp(t)
	seedSettingsLocalePreferenceGuardV1(t, app)
	user := createSchemaTestUser(t, app, "guard-recovery@example.com")
	handler := app.OnBackupCreate().BindFunc(func(*core.BackupEvent) error { return errors.New("guard backup unavailable") })
	if err := prepareExclusiveSchemaDataMigrations(app); err == nil || !strings.Contains(err.Error(), "guard backup unavailable") {
		t.Fatalf("guard upgrade did not stop on backup failure: %v", err)
	}
	if err := verifySettingsLocalePreferenceGuardDefinitions(app, settingsLocalePreferenceGuardV1SQL); err != nil {
		t.Fatalf("backup failure changed guards: %v", err)
	}
	if pending, err := schemaDataMigrationPendingWithoutWrites(app, settingsLocalePreferenceGuardV2MigrationName); err != nil || !pending {
		t.Fatalf("backup failure changed marker: pending=%v err=%v", pending, err)
	}
	app.OnBackupCreate().Unbind(handler)
	if err := prepareExclusiveSchemaDataMigrations(app); err != nil {
		t.Fatal(err)
	}
	before := readLocaleGuardV2RecoveryPoint(t, app)
	app.OnBackupCreate().BindFunc(func(*core.BackupEvent) error { return errors.New("must reuse recovery point") })
	if err := prepareExclusiveSchemaDataMigrations(app); err != nil {
		t.Fatalf("pending retry did not reuse snapshot: %v", err)
	}
	if err := runSchemaDataMigrations(app); err != nil {
		t.Fatal(err)
	}
	if err := prepareExclusiveSchemaDataMigrations(app); err != nil {
		t.Fatalf("completed upgrade tried to back up again: %v", err)
	}
	if !bytes.Equal(before, readLocaleGuardV2RecoveryPoint(t, app)) {
		t.Fatal("retry or completed upgrade replaced the original recovery point")
	}

	// 解包真实恢复点核对旧 guard 和账本，不能仅以 ZIP 存在来证明可退回升级前的数据契约。
	archive, err := zip.NewReader(bytes.NewReader(before), int64(len(before)))
	if err != nil {
		t.Fatal(err)
	}
	entry, err := archive.Open("data.db")
	if err != nil {
		t.Fatal(err)
	}
	defer entry.Close()
	database, err := io.ReadAll(entry)
	if err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "data.db"), database, 0600); err != nil {
		t.Fatal(err)
	}
	restored := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: dataDir})
	if err := restored.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restored.ResetBootstrapState() })
	if err := verifySettingsLocalePreferenceGuardDefinitions(restored, settingsLocalePreferenceGuardV1SQL); err != nil {
		t.Fatalf("recovery point already contains new guards: %v", err)
	}
	if pending, err := schemaDataMigrationPendingWithoutWrites(restored, settingsLocalePreferenceGuardV2MigrationName); err != nil || !pending {
		t.Fatalf("recovery point already contains v2 marker: pending=%v err=%v", pending, err)
	}
	if _, err := restored.FindRecordById("users", user.Id); err != nil {
		t.Fatalf("recovery point lost pre-upgrade account: %v", err)
	}
}

func TestSettingsLocalePreferenceGuardV2RejectsCorruptRecoveryPoint(t *testing.T) {
	app := newSchemaTestApp(t)
	seedSettingsLocalePreferenceGuardV1(t, app)
	createSchemaTestUser(t, app, "guard-corrupt@example.com")
	fsys, err := app.NewBackupsFilesystem()
	if err != nil {
		t.Fatal(err)
	}
	defer fsys.Close()
	corrupt := []byte("not a backup")
	if err := fsys.Upload(corrupt, settingsLocalePreferenceGuardV2RecoveryPoint); err != nil {
		t.Fatal(err)
	}
	if err := prepareExclusiveSchemaDataMigrations(app); err == nil || !strings.Contains(err.Error(), "invalid destructive migration recovery point") {
		t.Fatalf("corrupt v2 snapshot accepted: %v", err)
	}
	if !bytes.Equal(corrupt, readLocaleGuardV2RecoveryPoint(t, app)) {
		t.Fatal("corrupt recovery point was overwritten")
	}
	if err := verifySettingsLocalePreferenceGuardDefinitions(app, settingsLocalePreferenceGuardV1SQL); err != nil {
		t.Fatalf("corrupt recovery point changed guards: %v", err)
	}
}

func TestSettingsLocalePreferenceGuardV2FreshInstallNeedsNoRecoveryPoint(t *testing.T) {
	app := newSchemaTestApp(t)
	app.OnBackupCreate().BindFunc(func(*core.BackupEvent) error { return errors.New("fresh install must not back up") })
	if err := prepareExclusiveSchemaDataMigrations(app); err != nil {
		t.Fatal(err)
	}
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	if err := verifySettingsLocalePreferenceGuard(app); err != nil {
		t.Fatal(err)
	}
}
