package main

// media_icon_index_github.go 负责内置图标 provider 的 GitHub 版本探测。
//
// 架构位置：
//   - 管理员显式 check/refresh 才会触发这里的 GitHub Atom feed 请求。
//   - active 索引仍保存在 PocketBase media_icon_indexes；版本探测失败不能清空旧索引。
//   - provider check 不使用 GitHub REST API，避免共享出口撞匿名 REST 速率限制。
import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

// checkLatestBuiltInIconProviderVersion 读取缓存状态并按 Atom ETag 探测 provider 最新 commit。
// not modified 时复用已保存 latest，避免共享出口重复下载 feed。
func checkLatestBuiltInIconProviderVersion(ctx context.Context, app core.App, provider string) (*builtInIconProviderVersionResponse, string, error) {
	record, _ := findMediaIconIndexRecord(app)
	state := providerStatesFromRecord(record)[provider]
	version, etag, notModified, err := fetchLatestBuiltInIconProviderVersion(ctx, provider, state.ETag)
	if err != nil {
		return nil, "", err
	}
	if notModified && state.Latest != nil {
		return state.Latest, etag, nil
	}
	if version == nil {
		return nil, "", errors.New("latest provider version is unavailable")
	}
	return version, etag, nil
}

// fetchLatestBuiltInIconProviderVersion 只读取 GitHub metadata，不下载/托管 registry SVG 内容。
// TheSVG 的 latest release tag 只是展示辅助，active 版本仍以 commit SHA 为准。
func fetchLatestBuiltInIconProviderVersion(ctx context.Context, provider string, etag string) (*builtInIconProviderVersionResponse, string, bool, error) {
	config, ok := mediaResolverBuiltInProviderConfig(provider)
	if !ok {
		return nil, "", false, fmt.Errorf("unknown built-in icon provider: %s", provider)
	}
	commitURL := gitHubAtomFeedURL(config.Owner, config.Repo, "commits/"+config.Branch)
	data, nextETag, notModified, err := fetchGitHubAtomFeed(ctx, commitURL, etag, "GitHub commit feed")
	if err != nil {
		return nil, nextETag, false, err
	}
	if notModified {
		return nil, nextETag, true, nil
	}
	commit, err := parseGitHubCommitAtomFeed(data)
	if err != nil {
		return nil, nextETag, false, err
	}
	shortSHA := commit.SHA
	if len(shortSHA) > 7 {
		shortSHA = shortSHA[:7]
	}
	version := &builtInIconProviderVersionResponse{
		SourceRef:          commit.SHA,
		DisplayVersion:     shortSHA,
		CommitSHA:          stringPtrOrNil(commit.SHA),
		CommitShortSHA:     stringPtrOrNil(shortSHA),
		CommitDate:         stringPtrOrNil(commit.Updated),
		ReleaseTag:         nil,
		ReleasePublishedAt: nil,
	}
	if config.LatestRelease {
		tag, publishedAt := fetchLatestBuiltInIconRelease(ctx, config.Owner, config.Repo)
		if tag != "" {
			version.ReleaseTag = &tag
		}
		if publishedAt != "" {
			version.ReleasePublishedAt = &publishedAt
		}
	}
	return version, nextETag, false, nil
}

// fetchGitHubAtomFeed 执行有界 Atom 请求；这里不带 REST API token，避免 provider check 回到 GitHub REST 限流断点。
func fetchGitHubAtomFeed(ctx context.Context, url string, etag string, label string) ([]byte, string, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", false, err
	}
	req.Header.Set("Accept", "application/atom+xml")
	req.Header.Set("User-Agent", "Renewlet/"+Version)
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	res, err := sendUpstreamHTTPRequest(req, upstreamHTTPRequestOptions{
		Provider: label,
		Timeout:  builtInIconGitHubFetchTimeout,
	})
	if err != nil {
		return nil, "", false, err
	}
	defer res.Body.Close()
	nextETag := res.Header.Get("ETag")
	if res.StatusCode == http.StatusNotModified {
		return nil, nextETag, true, nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, nextETag, false, gitHubAtomFeedHTTPError(res, label)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, builtInIconGitHubAtomFeedLimitBytes+1))
	if err != nil {
		return nil, nextETag, false, err
	}
	if len(data) > builtInIconGitHubAtomFeedLimitBytes {
		return nil, nextETag, false, errors.New(label + " response too large")
	}
	return data, nextETag, false, nil
}

func gitHubAtomFeedHTTPError(res *http.Response, label string) error {
	providerResponse, _, err := captureUpstreamProviderResponse(res, nil)
	if err != nil {
		return err
	}
	providerMessage := upstreamProviderMessage(providerResponse)
	return createUpstreamHTTPError(label, res, providerResponse, fallbackText(providerMessage, fmt.Sprintf("%s HTTP %d", label, res.StatusCode)))
}

// fetchLatestBuiltInIconRelease 仅作为展示补充；失败时静默回落 commit metadata，不能阻断 provider check。
func fetchLatestBuiltInIconRelease(ctx context.Context, owner string, repo string) (string, string) {
	url := gitHubAtomFeedURL(owner, repo, "releases")
	data, _, _, err := fetchGitHubAtomFeed(ctx, url, "", "GitHub release feed")
	if err != nil {
		return "", ""
	}
	release, err := parseGitHubReleaseAtomFeed(data)
	if err != nil {
		return "", ""
	}
	return release.Tag, release.Updated
}

type gitHubAtomFeed struct {
	Entries []gitHubAtomEntry `xml:"entry"`
}

type gitHubAtomEntry struct {
	ID      string           `xml:"id"`
	Title   string           `xml:"title"`
	Updated string           `xml:"updated"`
	Links   []gitHubAtomLink `xml:"link"`
}

type gitHubAtomLink struct {
	Href string `xml:"href,attr"`
}

type gitHubCommitAtomVersion struct {
	SHA     string
	Updated string
}

type gitHubReleaseAtomVersion struct {
	Tag     string
	Updated string
}

func parseGitHubCommitAtomFeed(data []byte) (gitHubCommitAtomVersion, error) {
	entry, err := firstGitHubAtomEntry(data)
	if err != nil {
		return gitHubCommitAtomVersion{}, err
	}
	index := strings.LastIndex(entry.ID, "/")
	if index < 0 || index == len(entry.ID)-1 {
		return gitHubCommitAtomVersion{}, errors.New("GitHub commit feed missing commit id")
	}
	sha := strings.TrimSpace(entry.ID[index+1:])
	if !validGitHubSHA(sha) {
		return gitHubCommitAtomVersion{}, errors.New("GitHub commit feed missing sha")
	}
	return gitHubCommitAtomVersion{SHA: sha, Updated: strings.TrimSpace(entry.Updated)}, nil
}

func parseGitHubReleaseAtomFeed(data []byte) (gitHubReleaseAtomVersion, error) {
	entry, err := firstGitHubAtomEntry(data)
	if err != nil {
		return gitHubReleaseAtomVersion{}, err
	}
	for _, link := range entry.Links {
		if tag := releaseTagFromGitHubAtomLink(link.Href); tag != "" {
			return gitHubReleaseAtomVersion{Tag: tag, Updated: strings.TrimSpace(entry.Updated)}, nil
		}
	}
	return gitHubReleaseAtomVersion{}, errors.New("GitHub release feed missing tag link")
}

func firstGitHubAtomEntry(data []byte) (gitHubAtomEntry, error) {
	var feed gitHubAtomFeed
	if err := xml.Unmarshal(data, &feed); err != nil {
		return gitHubAtomEntry{}, err
	}
	if len(feed.Entries) == 0 {
		return gitHubAtomEntry{}, errors.New("GitHub Atom feed is empty")
	}
	return feed.Entries[0], nil
}

func releaseTagFromGitHubAtomLink(href string) string {
	index := strings.LastIndex(href, "/releases/tag/")
	if index < 0 {
		return ""
	}
	rawTag := strings.TrimSpace(href[index+len("/releases/tag/"):])
	if rawTag == "" {
		return ""
	}
	tag, err := url.PathUnescape(rawTag)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(tag)
}

func validGitHubSHA(value string) bool {
	if len(value) < 7 || len(value) > 40 {
		return false
	}
	for _, item := range value {
		if (item < '0' || item > '9') && (item < 'a' || item > 'f') && (item < 'A' || item > 'F') {
			return false
		}
	}
	return true
}

func gitHubAtomFeedURL(owner string, repo string, feedPath string) string {
	return strings.TrimRight(builtInIconGitHubBase, "/") + "/" + owner + "/" + repo + "/" + strings.Trim(feedPath, "/") + ".atom"
}

// builtInIconProviderGitHubConfig 是 shared media resolver 配置在 Go 侧的最小 GitHub 投影。
type builtInIconProviderGitHubConfig struct {
	Owner         string
	Repo          string
	Branch        string
	LatestRelease bool
}

// mediaResolverBuiltInProviderConfig 从生成期 media resolver 配置读取 provider 对应的 GitHub 来源。
func mediaResolverBuiltInProviderConfig(provider string) (builtInIconProviderGitHubConfig, bool) {
	for _, item := range mediaResolverCfg.BuiltInProviders {
		if item.Provider == provider {
			return builtInIconProviderGitHubConfig{
				Owner:         item.GitHub.Owner,
				Repo:          item.GitHub.Repo,
				Branch:        item.GitHub.Branch,
				LatestRelease: item.GitHub.LatestRelease,
			}, true
		}
	}
	return builtInIconProviderGitHubConfig{}, false
}
