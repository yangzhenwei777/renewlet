package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
)

func TestNormalizeCommand(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		args []string
		want []string
	}{
		{name: "empty", want: []string{stableBinaryPath}},
		{name: "serve", args: []string{"serve", "--http=0.0.0.0:3000"}, want: []string{stableBinaryPath, "serve", "--http=0.0.0.0:3000"}},
		{name: "superuser", args: []string{"superuser", "upsert"}, want: []string{stableBinaryPath, "superuser", "upsert"}},
		{name: "healthcheck", args: []string{"healthcheck"}, want: []string{stableBinaryPath, "healthcheck"}},
		{name: "flag", args: []string{"--version"}, want: []string{stableBinaryPath, "--version"}},
		{name: "short flag", args: []string{"-h"}, want: []string{stableBinaryPath, "-h"}},
		{name: "stable binary", args: []string{stableBinaryPath, "version"}, want: []string{stableBinaryPath, "version"}},
		{name: "explicit command", args: []string{"/bin/tool", "arg"}, want: []string{"/bin/tool", "arg"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := normalizeCommand(test.args); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("normalizeCommand() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestPrepareRuntimeLayout(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	layout := testRuntimeLayout(root)
	if err := os.MkdirAll(filepath.Dir(layout.binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(layout.binary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := prepareRuntimeLayout(layout, os.Getuid(), os.Getgid()); err != nil {
		t.Fatalf("prepareRuntimeLayout() error = %v", err)
	}
	if err := validateRuntimeLayout(layout); err != nil {
		t.Fatalf("validateRuntimeLayout() error = %v", err)
	}
	target, err := os.Readlink(layout.stableBinary)
	if err != nil {
		t.Fatal(err)
	}
	if target != layout.binary {
		t.Fatalf("stable link target = %q, want %q", target, layout.binary)
	}
}

func TestChownTreeDoesNotFollowSymlinks(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	inside := filepath.Join(root, "inside")
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(inside, []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "external-link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}

	var visited []string
	if err := chownTreeWith(root, 1000, 1000, func(path string, _, _ int) error {
		visited = append(visited, path)
		return nil
	}); err != nil {
		t.Fatalf("chownTreeWith() error = %v", err)
	}
	if !slices.Contains(visited, link) {
		t.Fatalf("visited paths %v do not include symlink", visited)
	}
	if slices.Contains(visited, outside) {
		t.Fatalf("visited paths %v followed symlink outside root", visited)
	}
}

func TestPrepareRuntimeLayoutRejectsWrongStableLink(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	layout := testRuntimeLayout(root)
	if err := os.MkdirAll(filepath.Dir(layout.binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(layout.binary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/unexpected", layout.stableBinary); err != nil {
		t.Fatal(err)
	}
	if err := prepareRuntimeLayout(layout, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("prepareRuntimeLayout() accepted a wrong stable link")
	}
}

func TestDropPrivilegesOrderAndFailure(t *testing.T) {
	t.Parallel()
	var calls []string
	err := dropPrivilegesWith(
		1000,
		1000,
		func(groups []int) error {
			if groups != nil {
				t.Fatalf("groups = %v, want nil", groups)
			}
			calls = append(calls, "groups")
			return nil
		},
		func(int) error {
			calls = append(calls, "gid")
			return errors.New("stop")
		},
		func(int) error {
			calls = append(calls, "uid")
			return nil
		},
	)
	if err == nil {
		t.Fatal("dropPrivilegesWith() error = nil")
	}
	if want := []string{"groups", "gid"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
}

func testRuntimeLayout(root string) runtimeLayout {
	install := filepath.Join(root, "opt", "renewlet")
	return runtimeLayout{
		stableBinary: filepath.Join(root, "renewlet"),
		binary:       filepath.Join(install, "current", "renewlet"),
		data:         filepath.Join(root, "pb_data"),
		install:      install,
		current:      filepath.Join(install, "current"),
		backups:      filepath.Join(install, "backups"),
	}
}
