package main

// system_update.go 实现 Docker 页面内自更新。
//
// 状态流：版本检查 -> 选择可信 Release 资产 -> 下载 checksum 和 tar.gz -> 校验 -> 替换真实二进制
// -> 标记 restart pending -> 管理员确认后异步退出，让 Docker restart policy 拉起新进程。
//
// 注意：这里永远不替换 /renewlet 稳定入口；只替换 /opt/renewlet/current/renewlet，并保留备份用于失败恢复。
import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// newSystemUpdateService 注入 release client 和时钟/退出函数，便于测试覆盖下载、锁和延迟退出状态。
func newSystemUpdateService(client systemReleaseClient) *systemUpdateService {
	rootCtx, rootCancel := context.WithCancel(context.Background())
	return &systemUpdateService{
		client:           client,
		now:              time.Now,
		exit:             os.Exit,
		restartWait:      800 * time.Millisecond,
		operationTimeout: systemUpdateOperationTimeout,
		capability:       selfUpdateCapability,
		rootCtx:          rootCtx,
		rootCancel:       rootCancel,
	}
}

// CheckVersion 返回当前部署形态和最新可信 Release。
// GitHub 失败时只返回 warning/cached，不把“没拿到结果”伪装成“已是最新”。
func (service *systemUpdateService) CheckVersion(ctx context.Context, locale appLocale, force bool) (*systemVersionResponse, error) {
	if !force {
		if cached := service.cachedVersion(); cached != nil {
			return cached, nil
		}
	}

	response := service.baseVersionResponse(locale)
	release, err := service.fetchTargetRelease(ctx)
	if err != nil {
		if cached := service.cachedVersion(); cached != nil {
			// 版本检查是管理页体验能力，不应因 GitHub 短暂失败阻断管理员查看上次可信结果。
			cached.Warning = service.versionCheckWarning(locale, err)
			cached.ErrorDetails = service.versionCheckDetails(err)
			return cached, nil
		}
		response.Warning = service.versionCheckWarning(locale, err)
		response.ErrorDetails = service.versionCheckDetails(err)
		return response, nil
	}
	response.CheckSucceeded = true
	if release == nil {
		service.storeVersion(response, nil)
		return cloneSystemVersionResponse(response, false), nil
	}

	response.ReleaseInfo = release.dto
	response.LatestVersion = release.dto.Version
	response.HasUpdate = service.isTargetVersionNewer(release.dto.Version)
	if response.HasUpdate && response.UpdateSupported {
		if reason := systemUpdateAssetsUnsupportedReason(locale, release.assets, release.dto.Version); reason != "" {
			response.UpdateSupported = false
			response.UnsupportedReason = reason
		}
	}
	service.storeVersion(response, release)
	return cloneSystemVersionResponse(response, false), nil
}

// performUpdate 只执行一个已获得独占资格的任务；任务生命周期、并发和恢复检查点由 operation 层负责。
func (service *systemUpdateService) performUpdate(
	ctx context.Context,
	locale appLocale,
	capability systemUpdateCapability,
	release *fetchedSystemRelease,
	advance func(stage string, targetVersion string) error,
) (string, error) {
	var err error
	if release == nil {
		release, err = service.fetchTargetRelease(ctx)
	}
	if err != nil {
		return "", err
	}
	if release == nil {
		return "", systemUpdateError{kind: errSystemUpdateNoUpdate, message: serverText(locale, "system.alreadyLatest")}
	}
	if !service.isTargetVersionNewer(release.dto.Version) {
		return "", systemUpdateError{kind: errSystemUpdateNoUpdate, message: serverText(locale, "system.alreadyLatest")}
	}

	archiveAsset, checksumAsset, err := selectSystemUpdateAssets(release.assets, release.dto.Version)
	if err != nil {
		return "", err
	}
	if err := validateTrustedDownloadURL(archiveAsset.BrowserDownloadURL); err != nil {
		return "", fmt.Errorf("invalid archive URL: %w", err)
	}
	if err := validateTrustedDownloadURL(checksumAsset.BrowserDownloadURL); err != nil {
		return "", fmt.Errorf("invalid checksum URL: %w", err)
	}
	if err := advance(systemUpdateStageDownloading, release.dto.Version); err != nil {
		return "", err
	}

	// 先取体积极小的 checksum 并确认目标归档条目，再开始大文件下载；无效发布不会浪费带宽和临时磁盘。
	checksumText, err := service.client.FetchText(ctx, checksumAsset.BrowserDownloadURL, systemUpdateMaxChecksumBytes)
	if err != nil {
		return "", err
	}
	if int64(len(checksumText)) > systemUpdateMaxChecksumBytes {
		return "", errors.New("checksums.txt is too large")
	}
	expectedChecksum, err := checksumForArchive(archiveAsset.Name, checksumText)
	if err != nil {
		return "", err
	}

	// 临时目录必须和目标二进制同分区，后续 rename 才能保持替换语义接近原子操作。
	tempDir, err := os.MkdirTemp(filepath.Dir(capability.binaryPath), ".renewlet-update-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tempDir)

	archivePath := filepath.Join(tempDir, archiveAsset.Name)
	// DownloadFile 在同一次网络流中落盘并计算摘要，校验阶段只比较结果，不再对大归档做第二次完整读取。
	actualChecksum, err := service.client.DownloadFile(ctx, archiveAsset.BrowserDownloadURL, archivePath, archiveAsset.Size, systemUpdateMaxArchiveBytes)
	if err != nil {
		return "", err
	}
	if err := advance(systemUpdateStageVerifying, release.dto.Version); err != nil {
		return "", err
	}
	if !strings.EqualFold(actualChecksum, expectedChecksum) {
		return "", fmt.Errorf("checksum mismatch for %s", archiveAsset.Name)
	}

	newBinaryPath := filepath.Join(tempDir, "renewlet.new")
	if err := extractRenewletBinary(archivePath, newBinaryPath); err != nil {
		return "", err
	}
	if err := advance(systemUpdateStageInstalling, release.dto.Version); err != nil {
		return "", err
	}
	if err := replaceRenewletBinary(capability.binaryPath, capability.backupDir, newBinaryPath, Version); err != nil {
		return "", err
	}
	return release.dto.Version, nil
}

// ScheduleRestart 在响应写回后异步退出；Docker restart policy 负责用新二进制拉起进程。
func (service *systemUpdateService) ScheduleRestart() {
	if envBool("RENEWLET_SELF_UPDATE_DISABLE_EXIT", false) {
		return
	}
	go func() {
		// 重启请求响应已经写回浏览器后再退出；Docker restart 策略负责把新二进制作为唯一运行面拉起。
		time.Sleep(service.restartWait)
		service.exit(0)
	}()
}

func (service *systemUpdateService) baseVersionResponse(locale appLocale) *systemVersionResponse {
	capability := service.capability(locale)
	return &systemVersionResponse{
		CurrentVersion:    Version,
		LatestVersion:     Version,
		HasUpdate:         false,
		Deployment:        capability.deployment,
		UpdateMode:        capability.updateMode,
		UpdateSupported:   capability.supported,
		UnsupportedReason: capability.unsupportedReason,
		ReleaseInfo:       nil,
		Cached:            false,
		CheckSucceeded:    false,
		Build: systemBuildInfo{
			Version:   Version,
			Commit:    Commit,
			BuildTime: BuildTime,
			BuildType: BuildType,
		},
	}
}

func (service *systemUpdateService) fetchTargetRelease(ctx context.Context) (*fetchedSystemRelease, error) {
	if currentUpdateChannel() == systemUpdateChannelRC {
		return service.fetchLatestRCRelease(ctx)
	}
	return service.fetchLatestStableRelease(ctx)
}

func (service *systemUpdateService) fetchLatestStableRelease(ctx context.Context) (*fetchedSystemRelease, error) {
	releases, err := service.client.FetchReleases(ctx)
	if err != nil {
		return nil, err
	}
	for index := range releases {
		release := &releases[index]
		version, parsed, ok := parseSystemVersion(release.TagName)
		if !ok || parsed.prerelease != "" {
			continue
		}
		return service.systemReleaseFromSource(ctx, release, version), nil
	}
	return nil, nil
}

func (service *systemUpdateService) fetchLatestRCRelease(ctx context.Context) (*fetchedSystemRelease, error) {
	var best *systemRelease
	var bestVersion string
	var bestParsed semanticVersion
	releases, err := service.client.FetchReleases(ctx)
	if err != nil {
		return nil, err
	}
	for index := range releases {
		release := &releases[index]
		version, parsed, ok := parseSystemVersion(release.TagName)
		if !ok || parsed.rc <= 0 {
			continue
		}
		if !isNewerSystemRCVersion(Version, version) {
			continue
		}
		if best == nil || compareSemanticVersion(parsed, bestParsed) > 0 {
			copyRelease := *release
			copyRelease.Assets = append([]systemReleaseAsset(nil), release.Assets...)
			best = &copyRelease
			bestVersion = version
			bestParsed = parsed
		}
	}
	if best == nil {
		return nil, nil
	}
	return service.systemReleaseFromSource(ctx, best, bestVersion), nil
}

func (service *systemUpdateService) isTargetVersionNewer(version string) bool {
	if currentUpdateChannel() == systemUpdateChannelRC {
		return isNewerSystemRCVersion(Version, version)
	}
	return isNewerSystemVersion(Version, version)
}

func currentUpdateChannel() string {
	// RC/stable 通道以当前运行版本为唯一真相；额外 build arg 会让候选版验收路径和实际二进制版本漂移。
	_, parsed, ok := parseSystemVersion(Version)
	if ok && parsed.rc > 0 {
		return systemUpdateChannelRC
	}
	return systemUpdateChannelStable
}

func (service *systemUpdateService) systemReleaseFromSource(ctx context.Context, release *systemRelease, version string) *fetchedSystemRelease {
	copyRelease := *release
	if assets := service.client.ProbeReleaseAssets(ctx, release.TagName, version); assets != nil {
		copyRelease.Assets = assets
	} else if copyRelease.Assets == nil {
		copyRelease.Assets = []systemReleaseAsset{}
	}
	return systemReleaseFromSource(&copyRelease, version)
}

func systemReleaseFromSource(release *systemRelease, version string) *fetchedSystemRelease {
	assets := makeSystemReleaseAssetDTOs(release.Assets)
	return &fetchedSystemRelease{
		dto: &systemReleaseInfoDTO{
			TagName:     release.TagName,
			Version:     version,
			Name:        release.Name,
			Body:        release.Body,
			PublishedAt: release.PublishedAt,
			HTMLURL:     release.HTMLURL,
			Assets:      assets,
		},
		assets: append([]systemReleaseAsset(nil), release.Assets...),
	}
}

func makeSystemReleaseAssetDTOs(source []systemReleaseAsset) []systemReleaseAssetDTO {
	assets := make([]systemReleaseAssetDTO, 0, len(source))
	for _, asset := range source {
		assets = append(assets, systemReleaseAssetDTO{Name: asset.Name, Size: asset.Size})
	}
	return assets
}

func (service *systemUpdateService) cachedVersion() *systemVersionResponse {
	service.cacheMu.Lock()
	defer service.cacheMu.Unlock()
	if service.cache == nil || service.cache.response == nil || !service.now().Before(service.cache.expires) {
		return nil
	}
	return cloneSystemVersionResponse(service.cache.response, true)
}

// 更新任务只复用与版本展示响应同批确认的 Release；所有返回值都深拷贝，调用方不能修改共享缓存。
func (service *systemUpdateService) cachedUpdateRelease() *fetchedSystemRelease {
	service.cacheMu.Lock()
	defer service.cacheMu.Unlock()
	if service.cache == nil || !service.now().Before(service.cache.expires) {
		return nil
	}
	return cloneFetchedSystemRelease(service.cache.release)
}

func (service *systemUpdateService) storeVersion(response *systemVersionResponse, release *fetchedSystemRelease) {
	service.cacheMu.Lock()
	defer service.cacheMu.Unlock()
	cached := cloneSystemVersionResponse(response, false)
	if cached != nil {
		// 上游 raw response 只随当前管理员操作返回；版本缓存只保存可信 release 结果和短 warning。
		cached.ErrorDetails = nil
	}
	// response/release 一次性发布并共享 TTL，禁止分别写入导致 UI 版本与实际下载资产错配。
	service.cache = &systemVersionCache{
		response: cached,
		release:  cloneFetchedSystemRelease(release),
		expires:  service.now().Add(systemUpdateCacheTTL),
	}
}

func (service *systemUpdateService) clearCache() {
	service.cacheMu.Lock()
	defer service.cacheMu.Unlock()
	service.cache = nil
}

func cloneFetchedSystemRelease(release *fetchedSystemRelease) *fetchedSystemRelease {
	if release == nil {
		return nil
	}
	clone := &fetchedSystemRelease{assets: append([]systemReleaseAsset(nil), release.assets...)}
	if release.dto != nil {
		dto := *release.dto
		dto.Assets = append([]systemReleaseAssetDTO(nil), release.dto.Assets...)
		clone.dto = &dto
	}
	return clone
}

func (service *systemUpdateService) versionCheckWarning(locale appLocale, err error) string {
	var releaseErr *systemReleaseCheckError
	if errors.As(err, &releaseErr) {
		switch releaseErr.statusCode {
		case http.StatusNotFound:
			return serverText(locale, "system.versionCheckNotFoundWarning")
		case http.StatusForbidden, http.StatusUnauthorized:
			return serverText(locale, "system.versionCheckAccessWarning")
		case 0:
			return serverText(locale, "system.versionCheckNetworkWarning")
		default:
			return serverText(locale, "system.versionCheckUnavailableWarning")
		}
	}
	return serverText(locale, "system.versionCheckUnavailableWarning")
}

func (service *systemUpdateService) versionCheckDetails(err error) *upstreamErrorDetails {
	return systemUpstreamErrorDetails(err)
}

func systemUpstreamErrorDetails(err error) *upstreamErrorDetails {
	var releaseErr *systemReleaseCheckError
	if errors.As(err, &releaseErr) && releaseErr.details != nil {
		return releaseErr.details
	}
	return upstreamErrorDetailsFromError(err)
}

func selfUpdateCapability(locale appLocale) systemUpdateCapability {
	binaryPath := strings.TrimSpace(os.Getenv("RENEWLET_SELF_UPDATE_BINARY"))
	if binaryPath == "" {
		binaryPath = defaultSelfUpdateBinaryPath
	}
	backupDir := strings.TrimSpace(os.Getenv("RENEWLET_SELF_UPDATE_BACKUP_DIR"))
	if backupDir == "" {
		backupDir = defaultSelfUpdateBackupDir
	}
	if !envBool("RENEWLET_SELF_UPDATE_ENABLED", false) {
		reasonKey := "system.updateUnsupportedRuntime"
		if BuildType == "release" {
			reasonKey = "system.updateUnsupportedSelfUpdateDisabled"
		}
		return systemUpdateCapability{
			deployment:        deploymentForBuildType(),
			updateMode:        updateModeForManualDeployment(),
			supported:         false,
			unsupportedReason: serverText(locale, reasonKey),
			binaryPath:        binaryPath,
			backupDir:         backupDir,
		}
	}
	if BuildType != "release" {
		return systemUpdateCapability{
			deployment:        deploymentForBuildType(),
			updateMode:        updateModeForManualDeployment(),
			supported:         false,
			unsupportedReason: serverText(locale, "system.updateUnsupportedNotRelease"),
			binaryPath:        binaryPath,
			backupDir:         backupDir,
		}
	}
	if runtime.GOOS != "linux" {
		return systemUpdateCapability{
			deployment:        "docker",
			updateMode:        "docker-compose",
			supported:         false,
			unsupportedReason: serverText(locale, "system.updateUnsupportedLinuxDocker"),
			binaryPath:        binaryPath,
			backupDir:         backupDir,
		}
	}
	if fileInfo, err := os.Lstat(binaryPath); err != nil || !fileInfo.Mode().IsRegular() {
		// 旧镜像的 /renewlet 可能仍是真实文件；自更新只支持新布局里的 current/renewlet 可替换目标。
		return systemUpdateCapability{
			deployment:        "docker",
			updateMode:        "docker-compose",
			supported:         false,
			unsupportedReason: serverText(locale, "system.updateUnsupportedDockerBridge"),
			binaryPath:        binaryPath,
			backupDir:         backupDir,
		}
	}
	return systemUpdateCapability{
		deployment: "docker",
		updateMode: "in-app-binary",
		supported:  true,
		binaryPath: binaryPath,
		backupDir:  backupDir,
	}
}

func deploymentForBuildType() string {
	if BuildType == "release" {
		return "docker"
	}
	return "source"
}

func updateModeForManualDeployment() string {
	if BuildType == "release" {
		return "docker-compose"
	}
	return "source-manual"
}

func findSystemUpdateAssets(assets []systemReleaseAsset, version string) (*systemReleaseAsset, *systemReleaseAsset) {
	archiveName := systemArchiveName(version)
	var archiveAsset *systemReleaseAsset
	var checksumAsset *systemReleaseAsset
	for index := range assets {
		asset := &assets[index]
		switch asset.Name {
		case archiveName:
			archiveAsset = asset
		case "checksums.txt":
			checksumAsset = asset
		}
	}
	return archiveAsset, checksumAsset
}

func systemUpdateAssetsUnsupportedReason(locale appLocale, assets []systemReleaseAsset, version string) string {
	archiveAsset, checksumAsset := findSystemUpdateAssets(assets, version)
	if archiveAsset == nil {
		return serverFormat(locale, "system.updateUnsupportedReleaseAsset", map[string]interface{}{"asset": systemArchiveName(version)})
	}
	if checksumAsset == nil {
		return serverFormat(locale, "system.updateUnsupportedReleaseAsset", map[string]interface{}{"asset": "checksums.txt"})
	}
	return ""
}

func selectSystemUpdateAssets(assets []systemReleaseAsset, version string) (systemReleaseAsset, systemReleaseAsset, error) {
	archiveAsset, checksumAsset := findSystemUpdateAssets(assets, version)
	if archiveAsset == nil {
		return systemReleaseAsset{}, systemReleaseAsset{}, fmt.Errorf("no compatible release asset found for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	if checksumAsset == nil {
		return systemReleaseAsset{}, systemReleaseAsset{}, errors.New("checksums.txt is missing from the release")
	}
	return *archiveAsset, *checksumAsset, nil
}

func checksumForArchive(archiveName string, checksumText []byte) (string, error) {
	scanner := bufio.NewScanner(strings.NewReader(string(checksumText)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		hash := strings.ToLower(strings.TrimSpace(fields[0]))
		name := checksumEntryName(fields[len(fields)-1])
		if name != archiveName {
			continue
		}
		if len(hash) != sha256.Size*2 {
			return "", fmt.Errorf("invalid checksum for %s", archiveName)
		}
		if _, err := hex.DecodeString(hash); err != nil {
			return "", fmt.Errorf("invalid checksum for %s", archiveName)
		}
		return hash, nil
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("checksum for %s not found", archiveName)
}

func extractRenewletBinary(archivePath string, targetPath string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	found := false
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(header.Name)
		if filepath.IsAbs(name) || strings.HasPrefix(name, ".."+string(filepath.Separator)) || name == ".." {
			return fmt.Errorf("unsafe archive path %q", header.Name)
		}
		if header.Typeflag != tar.TypeReg || filepath.Base(name) != "renewlet" {
			continue
		}
		if found {
			return errors.New("release archive contains multiple renewlet binaries")
		}
		// 发布包里只接受一个 renewlet 可执行文件；其它路径一律忽略，避免 tarball 带额外 payload。
		target, err := os.OpenFile(targetPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := copyLimited(target, tarReader, systemUpdateMaxArchiveBytes); err != nil {
			_ = target.Close()
			return err
		}
		if err := target.Chmod(0o755); err != nil {
			_ = target.Close()
			return err
		}
		if err := target.Sync(); err != nil {
			_ = target.Close()
			return err
		}
		if err := target.Close(); err != nil {
			return err
		}
		found = true
	}
	if !found {
		return errors.New("renewlet binary not found in release archive")
	}
	return nil
}

func replaceRenewletBinary(binaryPath string, backupDir string, newBinaryPath string, currentVersion string) error {
	if !filepath.IsAbs(binaryPath) || !filepath.IsAbs(backupDir) {
		return errors.New("self-update paths must be absolute")
	}
	fileInfo, err := os.Lstat(binaryPath)
	if err != nil {
		return err
	}
	if !fileInfo.Mode().IsRegular() {
		return errors.New("self-update target must be the real binary, not a symlink or directory")
	}
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		return err
	}
	backupPath := filepath.Join(backupDir, "renewlet."+safeBackupVersion(currentVersion))
	backupInfo, backupErr := os.Lstat(backupPath)
	if errors.Is(backupErr, os.ErrNotExist) {
		tempBackup, err := os.CreateTemp(backupDir, ".renewlet-backup-*.tmp")
		if err != nil {
			return err
		}
		tempBackupPath := tempBackup.Name()
		if err := tempBackup.Close(); err != nil {
			return err
		}
		if err := os.Remove(tempBackupPath); err != nil {
			return err
		}
		defer os.Remove(tempBackupPath)
		// 旧 inode 先在同一文件系统建立 O(1) 硬链接备份，再原子发布备份名；current 全程存在且可执行。
		if err := os.Link(binaryPath, tempBackupPath); err != nil {
			return fmt.Errorf("backup current binary: %w", err)
		}
		if err := os.Rename(tempBackupPath, backupPath); err != nil {
			return fmt.Errorf("publish binary backup: %w", err)
		}
		if err := syncSystemUpdateDirectory(backupDir); err != nil {
			return fmt.Errorf("sync binary backup: %w", err)
		}
	} else if backupErr != nil {
		return backupErr
	} else if !backupInfo.Mode().IsRegular() {
		return errors.New("self-update backup must be a regular file")
	}
	// 同版本备份一旦发布就保留首次已知可运行 inode，重试任务不得用可能已更新过的 current 覆盖回滚基线。
	if err := os.Rename(newBinaryPath, binaryPath); err != nil {
		return fmt.Errorf("replace binary: %w", err)
	}
	// newBinary 与 current 位于同一文件系统，rename 原子切换入口；目录 fsync 保证崩溃后仍能观察到已发布名称。
	if err := syncSystemUpdateDirectory(filepath.Dir(binaryPath)); err != nil {
		return fmt.Errorf("sync replaced binary: %w", err)
	}
	return nil
}

func copyLimited(writer io.Writer, reader io.Reader, maxBytes int64) (int64, error) {
	limited := io.LimitReader(reader, maxBytes+1)
	written, err := io.Copy(writer, limited)
	if err != nil {
		return written, err
	}
	if written > maxBytes {
		return written, errors.New("payload is too large")
	}
	return written, nil
}
