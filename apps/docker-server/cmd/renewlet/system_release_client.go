package main

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// defaultSystemReleaseClient 返回只信任 GitHub Release feed 和下载边界的 HTTP 客户端。
func defaultSystemReleaseClient() systemReleaseClient {
	assetClient := defaultUpstreamHTTPClient(systemUpdateAssetRequestTimeout)
	assetClient.CheckRedirect = validateSystemReleaseRedirect
	downloadClient := defaultSystemReleaseDownloadHTTPClient()
	downloadClient.CheckRedirect = validateSystemReleaseRedirect
	return &httpSystemReleaseClient{
		metadataClient: defaultUpstreamHTTPClient(systemUpdateCheckTimeout),
		assetClient:    assetClient,
		downloader:     newSystemReleaseDownloader(downloadClient),
	}
}

func validateSystemReleaseRedirect(request *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("too many redirects")
	}
	// GitHub Release 会跳到对象存储；每一跳都重验 host，避免可信首跳被开放重定向带出边界。
	return validateTrustedDownloadURL(request.URL.String())
}

// FetchReleases 读取官方仓库 Release Atom feed；系统版本检查不再访问 GitHub REST API。
func (client *httpSystemReleaseClient) FetchReleases(ctx context.Context) ([]systemRelease, error) {
	requestURL := systemReleaseFeedURL()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, err
	}
	applySystemReleaseFeedHeaders(request)
	response, err := sendUpstreamHTTPRequest(request, upstreamHTTPRequestOptions{
		Provider: "GitHub Release feed",
		Timeout:  systemUpdateCheckTimeout,
		Client:   client.metadataClient,
	})
	if err != nil {
		return nil, newSystemReleaseNetworkError(err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, newSystemReleaseHTTPError(response)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, systemUpdateReleaseFeedLimitBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > systemUpdateReleaseFeedLimitBytes {
		return nil, errors.New("GitHub Release feed response too large")
	}
	return parseSystemReleaseAtomFeed(data)
}

// ProbeReleaseAssets 用固定 Release asset URL 做轻量 HEAD；失败只表示页面内更新暂不可用，不否定版本本身。
func (client *httpSystemReleaseClient) ProbeReleaseAssets(ctx context.Context, tagName string, version string) []systemReleaseAsset {
	candidates := []systemReleaseAsset{
		{Name: systemArchiveName(version), BrowserDownloadURL: systemReleaseAssetURL(tagName, systemArchiveName(version))},
		{Name: "checksums.txt", BrowserDownloadURL: systemReleaseAssetURL(tagName, "checksums.txt")},
	}
	type probeResult struct {
		size int64
		ok   bool
	}
	results := make([]probeResult, len(candidates))
	var waitGroup sync.WaitGroup
	// 候选资产固定为归档和 checksum，因此并发上限恒为 2；结果写入预分配槽位并按候选顺序收集，
	// 不能引入无界并发或让响应时序改变返回顺序。
	waitGroup.Add(len(candidates))
	for index := range candidates {
		go func() {
			defer waitGroup.Done()
			results[index].size, results[index].ok = client.probeReleaseAsset(ctx, candidates[index].BrowserDownloadURL)
		}()
	}
	waitGroup.Wait()

	assets := make([]systemReleaseAsset, 0, len(candidates))
	for index, candidate := range candidates {
		if !results[index].ok {
			continue
		}
		candidate.Size = results[index].size
		assets = append(assets, candidate)
	}
	return assets
}

func (client *httpSystemReleaseClient) probeReleaseAsset(ctx context.Context, sourceURL string) (int64, bool) {
	if err := validateTrustedDownloadURL(sourceURL); err != nil {
		return 0, false
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, sourceURL, nil)
	if err != nil {
		return 0, false
	}
	request.Header.Set("User-Agent", "Renewlet/"+Version)
	response, err := sendUpstreamHTTPRequest(request, upstreamHTTPRequestOptions{
		Provider: "GitHub Release asset",
		Timeout:  systemUpdateAssetRequestTimeout,
		Client:   client.assetClient,
	})
	if err != nil {
		return 0, false
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return 0, false
	}
	if response.ContentLength < 0 {
		return 0, true
	}
	return response.ContentLength, true
}

// DownloadFile 把大归档交给独立下载状态机；Release 元数据和 checksum 仍使用短请求客户端。
func (client *httpSystemReleaseClient) DownloadFile(ctx context.Context, sourceURL string, targetPath string, expectedSize int64, maxBytes int64) (string, error) {
	if err := validateTrustedDownloadURL(sourceURL); err != nil {
		return "", err
	}
	if client.downloader == nil {
		return "", errors.New("system release downloader is unavailable")
	}
	return client.downloader.Download(ctx, sourceURL, targetPath, expectedSize, maxBytes)
}

// FetchText 下载 checksum 等小文本资产；调用方负责在返回后检查是否超过 maxBytes。
func (client *httpSystemReleaseClient) FetchText(ctx context.Context, sourceURL string, maxBytes int64) ([]byte, error) {
	if err := validateTrustedDownloadURL(sourceURL); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "Renewlet/"+Version)
	response, err := sendUpstreamHTTPRequest(request, upstreamHTTPRequestOptions{
		Provider: "GitHub",
		Timeout:  systemUpdateAssetRequestTimeout,
		Client:   client.assetClient,
	})
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		providerResponse, _, captureErr := captureUpstreamProviderResponse(response, nil)
		if captureErr != nil {
			return nil, captureErr
		}
		return nil, createUpstreamHTTPError("GitHub", response, providerResponse, upstreamProviderMessage(providerResponse))
	}
	return io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
}

func validateTrustedDownloadURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if parsed.Scheme != "https" || parsed.User != nil {
		return errors.New("download URL must be https without userinfo")
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "github.com" || strings.HasSuffix(host, ".github.com") {
		return nil
	}
	if host == "githubusercontent.com" || strings.HasSuffix(host, ".githubusercontent.com") {
		return nil
	}
	return fmt.Errorf("download host %q is not trusted", host)
}

func applySystemReleaseFeedHeaders(request *http.Request) {
	request.Header.Set("Accept", "application/atom+xml")
	request.Header.Set("User-Agent", "Renewlet/"+Version)
}

func newSystemReleaseHTTPError(response *http.Response) error {
	providerResponse, rawBody, _ := captureUpstreamProviderResponse(response, nil)
	checkError := &systemReleaseCheckError{
		statusCode: response.StatusCode,
		status:     response.Status,
		message:    strings.TrimSpace(rawBody),
		details:    createUpstreamErrorDetails(providerResponse, upstreamProviderMessage(providerResponse)),
	}
	return checkError
}

func newSystemReleaseNetworkError(err error) error {
	message := firstNonBlank(upstreamRawResponseTextFromError(err), err.Error())
	return &systemReleaseCheckError{
		status:  "network error",
		message: message,
		details: upstreamErrorDetailsFromError(err),
	}
}

type systemReleaseAtomFeed struct {
	Entries []systemReleaseAtomEntry `xml:"entry"`
}

type systemReleaseAtomEntry struct {
	Title   string                   `xml:"title"`
	Updated string                   `xml:"updated"`
	Links   []systemReleaseAtomLink  `xml:"link"`
	Content systemReleaseAtomContent `xml:"content"`
}

type systemReleaseAtomLink struct {
	Href string `xml:"href,attr"`
}

type systemReleaseAtomContent struct {
	Text string `xml:",chardata"`
}

func parseSystemReleaseAtomFeed(data []byte) ([]systemRelease, error) {
	var feed systemReleaseAtomFeed
	if err := xml.Unmarshal(data, &feed); err != nil {
		return nil, err
	}
	if len(feed.Entries) == 0 {
		return nil, errors.New("GitHub Release feed is empty")
	}
	releases := make([]systemRelease, 0, len(feed.Entries))
	for _, entry := range feed.Entries {
		release, ok := systemReleaseFromAtomEntry(entry)
		if ok {
			releases = append(releases, release)
		}
	}
	if len(releases) == 0 {
		return nil, errors.New("GitHub Release feed has no trusted release entries")
	}
	return releases, nil
}

func systemReleaseFromAtomEntry(entry systemReleaseAtomEntry) (systemRelease, bool) {
	tagName, htmlURL := systemReleaseTagAndURL(entry)
	version, _, ok := parseSystemVersion(tagName)
	if !ok {
		return systemRelease{}, false
	}
	if strings.TrimSpace(htmlURL) == "" {
		htmlURL = systemReleaseTagURL(tagName)
	}
	name := strings.TrimSpace(entry.Title)
	if name == "" {
		name = "Renewlet " + version
	}
	return systemRelease{
		TagName:     tagName,
		Name:        name,
		Body:        strings.TrimSpace(html.UnescapeString(entry.Content.Text)),
		PublishedAt: strings.TrimSpace(entry.Updated),
		HTMLURL:     htmlURL,
		Assets:      nil,
	}, true
}

func systemReleaseTagAndURL(entry systemReleaseAtomEntry) (string, string) {
	for _, link := range entry.Links {
		if tag := releaseTagFromGitHubAtomLink(link.Href); tag != "" {
			return tag, strings.TrimSpace(link.Href)
		}
	}
	title := strings.TrimSpace(entry.Title)
	if _, _, ok := parseSystemVersion(title); ok {
		return title, ""
	}
	return "", ""
}

func systemReleaseFeedURL() string {
	return "https://github.com/" + systemUpdateRepository + "/releases.atom"
}

func systemReleaseTagURL(tagName string) string {
	return "https://github.com/" + systemUpdateRepository + "/releases/tag/" + url.PathEscape(tagName)
}

func systemReleaseAssetURL(tagName string, assetName string) string {
	return "https://github.com/" + systemUpdateRepository + "/releases/download/" + url.PathEscape(tagName) + "/" + url.PathEscape(assetName)
}
