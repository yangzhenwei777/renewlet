package main

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	renewletUID        = 1000
	renewletGID        = 1000
	stableBinaryPath   = "/renewlet"
	renewletBinaryPath = "/opt/renewlet/current/renewlet"
	dataPath           = "/pb_data"
	installPath        = "/opt/renewlet"
	currentPath        = "/opt/renewlet/current"
	backupPath         = "/opt/renewlet/backups"
)

type runtimeLayout struct {
	stableBinary string
	binary       string
	data         string
	install      string
	current      string
	backups      string
}

var productionLayout = runtimeLayout{
	stableBinary: stableBinaryPath,
	binary:       renewletBinaryPath,
	data:         dataPath,
	install:      installPath,
	current:      currentPath,
	backups:      backupPath,
}

func main() {
	log.SetFlags(0)
	if err := run(os.Args[1:]); err != nil {
		log.Fatalf("container init: %v", err)
	}
}

func run(args []string) error {
	command := normalizeCommand(args)
	if os.Geteuid() == 0 {
		if err := prepareRuntimeLayout(productionLayout, renewletUID, renewletGID); err != nil {
			return err
		}
		if isRenewletCommand(command[0]) {
			if err := dropPrivileges(renewletUID, renewletGID); err != nil {
				return err
			}
		}
	} else if err := validateRuntimeLayout(productionLayout); err != nil {
		return err
	}

	executable, err := resolveExecutable(command[0])
	if err != nil {
		return err
	}
	// execve 让 Renewlet 直接接管 PID 1，Docker 的停止信号和退出码不会被 init 中间层截断。
	return unix.Exec(executable, command, os.Environ())
}

func normalizeCommand(args []string) []string {
	if len(args) == 0 {
		return []string{stableBinaryPath}
	}
	first := args[0]
	if strings.HasPrefix(first, "-") || first == "serve" || first == "superuser" || first == "healthcheck" {
		return append([]string{stableBinaryPath}, args...)
	}
	return append([]string(nil), args...)
}

func isRenewletCommand(command string) bool {
	return command == stableBinaryPath || command == renewletBinaryPath
}

func resolveExecutable(command string) (string, error) {
	if strings.ContainsRune(command, filepath.Separator) {
		return command, nil
	}
	resolved, err := exec.LookPath(command)
	if err != nil {
		return "", fmt.Errorf("resolve command %q: %w", command, err)
	}
	return resolved, nil
}

func prepareRuntimeLayout(layout runtimeLayout, uid, gid int) error {
	for _, directory := range []string{layout.data, layout.install, layout.current, layout.backups} {
		if err := ensureDirectory(directory); err != nil {
			return err
		}
	}
	if err := validateRenewletBinary(layout.binary); err != nil {
		return err
	}
	if err := ensureStableBinaryLink(layout.stableBinary, layout.binary); err != nil {
		return err
	}
	for _, root := range []string{layout.data, layout.install} {
		if err := chownTree(root, uid, gid); err != nil {
			return fmt.Errorf("set ownership for %s: %w", root, err)
		}
	}
	return nil
}

func validateRuntimeLayout(layout runtimeLayout) error {
	for _, directory := range []string{layout.data, layout.install, layout.current, layout.backups} {
		if err := requireDirectory(directory); err != nil {
			return err
		}
	}
	if err := validateRenewletBinary(layout.binary); err != nil {
		return err
	}
	return validateStableBinaryLink(layout.stableBinary, layout.binary)
}

func ensureDirectory(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(path, 0o755); err != nil {
			return fmt.Errorf("create directory %s: %w", path, err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect directory %s: %w", path, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("runtime path %s must be a directory", path)
	}
	return nil
}

func requireDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect directory %s: %w", path, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("runtime path %s must be a directory", path)
	}
	return nil
}

func validateRenewletBinary(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect Renewlet binary %s: %w", path, err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("Renewlet binary %s must be an executable regular file", path)
	}
	return nil
}

func ensureStableBinaryLink(linkPath, targetPath string) error {
	err := validateStableBinaryLink(linkPath, targetPath)
	if err == nil {
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Symlink(targetPath, linkPath); err != nil {
		return fmt.Errorf("create stable binary link %s: %w", linkPath, err)
	}
	return nil
}

func validateStableBinaryLink(linkPath, targetPath string) error {
	info, err := os.Lstat(linkPath)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("stable binary path %s must be a symbolic link", linkPath)
	}
	target, err := os.Readlink(linkPath)
	if err != nil {
		return fmt.Errorf("read stable binary link %s: %w", linkPath, err)
	}
	if target != targetPath {
		return fmt.Errorf("stable binary link %s must target %s", linkPath, targetPath)
	}
	return nil
}

func chownTree(root string, uid, gid int) error {
	return chownTreeWith(root, uid, gid, os.Lchown)
}

func chownTreeWith(root string, uid, gid int, lchown func(string, int, int) error) error {
	// 数据卷可以包含用户创建的 symlink；WalkDir + Lchown 只改变链接本身，不能越界修改宿主机目标。
	return filepath.WalkDir(root, func(path string, _ fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		return lchown(path, uid, gid)
	})
}

func dropPrivileges(uid, gid int) error {
	return dropPrivilegesWith(uid, gid, syscall.Setgroups, syscall.Setgid, syscall.Setuid)
}

func dropPrivilegesWith(
	uid int,
	gid int,
	setgroups func([]int) error,
	setgid func(int) error,
	setuid func(int) error,
) error {
	// 标准库会把凭据变更同步到 Go runtime 的全部线程；必须先清附加组，再切换主 GID/UID。
	if err := setgroups(nil); err != nil {
		return fmt.Errorf("clear supplementary groups: %w", err)
	}
	if err := setgid(gid); err != nil {
		return fmt.Errorf("set gid %d: %w", gid, err)
	}
	if err := setuid(uid); err != nil {
		return fmt.Errorf("set uid %d: %w", uid, err)
	}
	return nil
}
