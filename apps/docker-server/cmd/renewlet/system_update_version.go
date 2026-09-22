package main

// system_update_version.go 只处理版本比较和自更新文件名契约。
//
// stable 与 rc 通道分开比较，避免稳定版被 prerelease 提示升级，或 RC 实例被 stable 覆盖。
import (
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func parseSystemVersion(rawVersion string) (string, semanticVersion, bool) {
	// 只接受 semver 和 rc.N；其它 build metadata 只用于展示，不能参与可执行更新选择。
	version := strings.TrimPrefix(strings.TrimSpace(rawVersion), "v")
	mainPart := version
	prerelease := ""
	if dash := strings.Index(mainPart, "-"); dash >= 0 {
		prerelease = mainPart[dash+1:]
		mainPart = mainPart[:dash]
	}
	parts := strings.Split(mainPart, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", semanticVersion{}, false
	}
	major, errMajor := strconv.Atoi(parts[0])
	minor, errMinor := strconv.Atoi(parts[1])
	patch, errPatch := strconv.Atoi(parts[2])
	if errMajor != nil || errMinor != nil || errPatch != nil || major < 0 || minor < 0 || patch < 0 {
		return "", semanticVersion{}, false
	}
	parsed := semanticVersion{major: major, minor: minor, patch: patch, prerelease: prerelease, rc: -1}
	if prerelease != "" {
		if !strings.HasPrefix(prerelease, "rc.") {
			return "", semanticVersion{}, false
		}
		rcValue := strings.TrimPrefix(prerelease, "rc.")
		rc, err := strconv.Atoi(rcValue)
		if err != nil || rc <= 0 {
			return "", semanticVersion{}, false
		}
		parsed.rc = rc
	}
	return version, parsed, true
}

func isNewerSystemVersion(current string, latest string) bool {
	_, currentVersion, currentOK := parseSystemVersion(current)
	_, latestVersion, latestOK := parseSystemVersion(latest)
	if !currentOK || !latestOK || currentVersion.prerelease != "" || latestVersion.prerelease != "" {
		return false
	}
	return compareSemanticVersion(latestVersion, currentVersion) > 0
}

func isNewerSystemRCVersion(current string, latest string) bool {
	_, currentVersion, currentOK := parseSystemVersion(current)
	_, latestVersion, latestOK := parseSystemVersion(latest)
	// RC 通道只允许候选版之间前进，不能把 stable 实例带到 prerelease，也不能用 stable 覆盖 RC。
	if !currentOK || !latestOK || currentVersion.rc <= 0 || latestVersion.rc <= 0 {
		return false
	}
	return compareSemanticVersion(latestVersion, currentVersion) > 0
}

func compareSemanticVersion(left semanticVersion, right semanticVersion) int {
	if left.major != right.major {
		return compareInt(left.major, right.major)
	}
	if left.minor != right.minor {
		return compareInt(left.minor, right.minor)
	}
	if left.patch != right.patch {
		return compareInt(left.patch, right.patch)
	}
	return compareInt(left.rc, right.rc)
}

func compareInt(left int, right int) int {
	switch {
	case left > right:
		return 1
	case left < right:
		return -1
	default:
		return 0
	}
}

func systemArchiveName(version string) string {
	return "renewlet_" + version + "_" + runtime.GOOS + "_" + runtime.GOARCH + ".tar.gz"
}

func safeBackupVersion(version string) string {
	value := strings.TrimSpace(version)
	if value == "" {
		return strconv.FormatInt(time.Now().Unix(), 10)
	}
	// 版本字符串会进入备份文件名，替换路径分隔符避免异常 build metadata 写出备份目录。
	replacer := strings.NewReplacer("/", "_", "\\", "_", ":", "_", " ", "_")
	return replacer.Replace(value)
}

func cloneSystemVersionResponse(response *systemVersionResponse, cached bool) *systemVersionResponse {
	if response == nil {
		return nil
	}
	clone := *response
	clone.Cached = cached
	if response.ReleaseInfo != nil {
		release := *response.ReleaseInfo
		// ReleaseInfo 是前端 Zod 校验的 API 契约；空附件列表也必须保持 []，不能让 Go nil slice 编成 null。
		release.Assets = make([]systemReleaseAssetDTO, len(response.ReleaseInfo.Assets))
		copy(release.Assets, response.ReleaseInfo.Assets)
		clone.ReleaseInfo = &release
	}
	return &clone
}

func checksumEntryName(value string) string {
	return strings.TrimPrefix(filepath.Base(strings.TrimPrefix(value, "*")), "./")
}
