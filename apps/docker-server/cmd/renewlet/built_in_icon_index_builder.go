package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const builtInIconRegistryFetchTimeout = 15 * time.Second
const builtInIconRegistryJSONLimitBytes = 16 * 1024 * 1024

var safeBuiltInIconPathPartRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
var builtInIconIndexHTTPClient = defaultUpstreamHTTPClient(builtInIconRegistryFetchTimeout)

type builtInIconProviderSourceRef struct {
	Provider string
	CDNBase  string
}

func buildRemoteBuiltInIconProviderIndex(ctx context.Context, provider string, sourceRef *builtInIconProviderSourceRef) ([]builtInIcon, error) {
	var icons []builtInIcon
	var err error
	switch provider {
	case "thesvg":
		icons, err = loadTheSVGIcons(ctx, sourceRef)
	case "selfhst":
		icons, err = loadSelfhstIcons(ctx, sourceRef)
	case "dashboardIcons":
		icons, err = loadDashboardIcons(ctx, sourceRef)
	default:
		return nil, fmt.Errorf("unknown built-in icon provider: %s", provider)
	}
	if err != nil {
		return nil, err
	}
	if len(icons) == 0 {
		return nil, fmt.Errorf("%s built-in icon index generation produced no icons", provider)
	}
	return icons, nil
}

func mergeBuiltInIconProviderIndexes(providerIndexes map[string][]builtInIcon) ([]builtInIcon, error) {
	icons := []builtInIcon{}
	for _, provider := range []string{"thesvg", "selfhst", "dashboardIcons"} {
		icons = append(icons, providerIndexes[provider]...)
	}
	if len(icons) == 0 {
		return nil, errors.New("built-in icon index generation produced no icons")
	}
	return icons, nil
}

func replaceBuiltInIconProviderIndex(icons []builtInIcon, provider string, providerIcons []builtInIcon) ([]builtInIcon, error) {
	providerIndexes := map[string][]builtInIcon{}
	for _, icon := range icons {
		if icon.Provider == provider {
			continue
		}
		providerIndexes[icon.Provider] = append(providerIndexes[icon.Provider], icon)
	}
	providerIndexes[provider] = providerIcons
	return mergeBuiltInIconProviderIndexes(providerIndexes)
}

func builtInIconProviderSourceBase(provider string, sourceRef *builtInIconProviderSourceRef) string {
	if sourceRef != nil && sourceRef.Provider == provider && sourceRef.CDNBase != "" {
		return sourceRef.CDNBase
	}
	return mediaResolverBuiltInProviderBase(provider)
}

func builtInIconProviderGitHubRawBase(provider string, sourceRef *builtInIconProviderSourceRef) string {
	ref := "main"
	if sourceRef != nil && sourceRef.Provider == provider && sourceRef.CDNBase != "" {
		if at := strings.LastIndex(sourceRef.CDNBase, "@"); at >= 0 && at < len(sourceRef.CDNBase)-1 {
			ref = sourceRef.CDNBase[at+1:]
		}
	}
	for _, item := range mediaResolverCfg.BuiltInProviders {
		if item.Provider == provider && item.GitHub.Owner != "" && item.GitHub.Repo != "" {
			if sourceRef == nil && item.GitHub.Branch != "" {
				ref = item.GitHub.Branch
			}
			return "https://raw.githubusercontent.com/" + item.GitHub.Owner + "/" + item.GitHub.Repo + "/" + ref
		}
	}
	return ""
}

func fetchRegistryJSON(ctx context.Context, url string, label string, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	res, err := sendUpstreamHTTPRequest(req, upstreamHTTPRequestOptions{
		Provider: label,
		Timeout:  builtInIconRegistryFetchTimeout,
		Client:   builtInIconIndexHTTPClient,
	})
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		providerResponse, _, captureErr := captureUpstreamProviderResponse(res, nil)
		if captureErr != nil {
			return captureErr
		}
		return createUpstreamHTTPError(label, res, providerResponse, fallbackText(upstreamProviderMessage(providerResponse), fmt.Sprintf("%s HTTP %d", label, res.StatusCode)))
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, builtInIconRegistryJSONLimitBytes+1))
	if err != nil {
		return err
	}
	if len(data) > builtInIconRegistryJSONLimitBytes {
		return fmt.Errorf("%s response too large", label)
	}
	return json.Unmarshal(data, target)
}

func fetchRegistryJSONAny(ctx context.Context, urls []string, label string, target any) error {
	failures := []string{}
	var firstUpstreamDetails *upstreamErrorDetails
	for _, url := range urls {
		if err := fetchRegistryJSON(ctx, url, label, target); err != nil {
			if firstUpstreamDetails == nil {
				firstUpstreamDetails = upstreamErrorDetailsFromError(err)
			}
			failures = append(failures, err.Error())
			continue
		}
		return nil
	}
	message := fmt.Sprintf("%s failed: %s", label, strings.Join(failures, "; "))
	if firstUpstreamDetails != nil {
		return newUpstreamOperationError(message, firstUpstreamDetails)
	}
	return errors.New(message)
}

func safeBuiltInIconPathPart(value string) bool {
	return safeBuiltInIconPathPartRE.MatchString(value)
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}

func stringSliceValue(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := []string{}
	for _, item := range items {
		if text := stringValue(item); text != "" {
			out = append(out, text)
		}
	}
	return out
}

func exactKeysForBuiltInIcon(slug string, title string, aliases []string) []string {
	canonical := normalizedTerms(append([]string{slug, title}, aliases...))
	compact := compactTerms(canonical)
	return uniqueStrings(append(canonical, compact...))
}

func iconRecord(input builtInIcon) builtInIcon {
	input.Terms = normalizedTerms(append(append([]string{input.Slug, input.Title}, input.Aliases...), input.Categories...))
	input.CompactTerms = compactTerms(append([]string{input.Slug, input.Title}, input.Aliases...))
	input.ExactKeys = exactKeysForBuiltInIcon(input.Slug, input.Title, input.Aliases)
	input.TokenKeys = exactTokenKeys(append([]string{input.Slug, input.Title}, input.Aliases...))
	return input
}

func loadTheSVGIcons(ctx context.Context, sourceRef *builtInIconProviderSourceRef) ([]builtInIcon, error) {
	var registry []map[string]any
	if err := fetchRegistryJSON(ctx, builtInIconProviderSourceBase("thesvg", sourceRef)+"/src/data/icons.json", "TheSVG registry", &registry); err != nil {
		return nil, err
	}
	icons := []builtInIcon{}
	seen := map[string]struct{}{}
	for _, item := range registry {
		slug := stringValue(item["slug"])
		title := stringValue(item["title"])
		if slug == "" || title == "" || !safeBuiltInIconPathPart(slug) {
			continue
		}
		if _, ok := seen[slug]; ok {
			continue
		}
		variants := theSVGVariants(slug, item["variants"])
		if len(variants) == 0 {
			continue
		}
		icons = append(icons, iconRecord(builtInIcon{
			Provider:   "thesvg",
			Slug:       slug,
			Title:      title,
			Aliases:    stringSliceValue(item["aliases"]),
			Categories: stringSliceValue(item["categories"]),
			Variants:   variants,
			Hex:        stringValue(item["hex"]),
			License:    stringValue(item["license"]),
			URL:        stringValue(item["url"]),
			Guidelines: stringValue(item["guidelines"]),
		}))
		seen[slug] = struct{}{}
	}
	return icons, nil
}

func theSVGVariants(slug string, value any) []builtInIconVariant {
	raw, ok := value.(map[string]any)
	if !ok {
		return []builtInIconVariant{}
	}
	variants := []builtInIconVariant{}
	for name, pathValue := range raw {
		path, ok := pathValue.(string)
		path = strings.TrimSpace(path)
		if !ok || !safeBuiltInIconPathPart(name) || !strings.HasSuffix(path, ".svg") {
			continue
		}
		// 上游 registry 只提供路径事实，但仍必须锁在当前 slug 目录内，避免刷新入口把跨目录路径写入全局候选索引。
		if !strings.HasPrefix(path, "/icons/"+slug+"/") {
			continue
		}
		variants = append(variants, builtInIconVariant{Name: name, Path: "/public" + path})
	}
	return variants
}

func loadSelfhstIcons(ctx context.Context, sourceRef *builtInIconProviderSourceRef) ([]builtInIcon, error) {
	var registry []map[string]any
	if err := fetchRegistryJSONAny(ctx, []string{
		builtInIconProviderSourceBase("selfhst", sourceRef) + "/index.json",
		builtInIconProviderGitHubRawBase("selfhst", sourceRef) + "/index.json",
	}, "selfh.st index", &registry); err != nil {
		return nil, err
	}
	icons := []builtInIcon{}
	seen := map[string]struct{}{}
	for _, item := range registry {
		slug := stringValue(item["Reference"])
		title := stringValue(item["Name"])
		if slug == "" || title == "" || !safeBuiltInIconPathPart(slug) {
			continue
		}
		if _, ok := seen[slug]; ok {
			continue
		}
		variants := selfhstIconVariants(slug, item)
		if len(variants) == 0 {
			continue
		}
		categories := []string{}
		if category := stringValue(item["Category"]); category != "" {
			categories = append(categories, category)
		}
		for _, tag := range strings.Split(stringValue(item["Tags"]), ",") {
			if trimmed := strings.TrimSpace(tag); trimmed != "" {
				categories = append(categories, trimmed)
			}
		}
		icons = append(icons, iconRecord(builtInIcon{
			Provider:   "selfhst",
			Slug:       slug,
			Title:      title,
			Aliases:    []string{},
			Categories: categories,
			Variants:   variants,
		}))
		seen[slug] = struct{}{}
	}
	return icons, nil
}

func selfhstIconVariants(reference string, item map[string]any) []builtInIconVariant {
	variants := []builtInIconVariant{}
	if item["SVG"] == "Yes" || item["SVG"] == "Y" {
		variants = append(variants, builtInIconVariant{Name: "default", Path: "/svg/" + reference + ".svg"})
	}
	if item["Light"] == "Yes" || item["Light"] == "Y" {
		variants = append(variants, builtInIconVariant{Name: "light", Path: "/svg/" + reference + "-light.svg"})
	}
	if item["Dark"] == "Yes" || item["Dark"] == "Y" {
		variants = append(variants, builtInIconVariant{Name: "dark", Path: "/svg/" + reference + "-dark.svg"})
	}
	return variants
}

func loadDashboardIcons(ctx context.Context, sourceRef *builtInIconProviderSourceRef) ([]builtInIcon, error) {
	var metadata map[string]map[string]any
	if err := fetchRegistryJSONAny(ctx, []string{
		builtInIconProviderSourceBase("dashboardIcons", sourceRef) + "/metadata.json",
		builtInIconProviderGitHubRawBase("dashboardIcons", sourceRef) + "/metadata.json",
	}, "Dashboard Icons metadata", &metadata); err != nil {
		return nil, err
	}
	var tree struct {
		SVG []string `json:"svg"`
	}
	if err := fetchRegistryJSONAny(ctx, []string{
		builtInIconProviderSourceBase("dashboardIcons", sourceRef) + "/tree.json",
		builtInIconProviderGitHubRawBase("dashboardIcons", sourceRef) + "/tree.json",
	}, "Dashboard Icons tree", &tree); err != nil {
		return nil, err
	}
	svgFiles := map[string]struct{}{}
	for _, file := range tree.SVG {
		svgFiles[file] = struct{}{}
	}
	icons := []builtInIcon{}
	for slug, item := range metadata {
		if !safeBuiltInIconPathPart(slug) {
			continue
		}
		variants := dashboardIconVariants(slug, item, svgFiles)
		if len(variants) == 0 {
			continue
		}
		icons = append(icons, iconRecord(builtInIcon{
			Provider:   "dashboardIcons",
			Slug:       slug,
			Title:      titleFromBuiltInIconSlug(slug),
			Aliases:    stringSliceValue(item["aliases"]),
			Categories: stringSliceValue(item["categories"]),
			Variants:   variants,
		}))
	}
	return icons, nil
}

func dashboardIconVariants(slug string, item map[string]any, svgFiles map[string]struct{}) []builtInIconVariant {
	variants := []builtInIconVariant{}
	if _, ok := svgFiles[slug+".svg"]; ok {
		variants = append(variants, builtInIconVariant{Name: "default", Path: "/svg/" + slug + ".svg"})
	}
	colors, ok := item["colors"].(map[string]any)
	if !ok {
		return variants
	}
	for _, variantName := range []string{"light", "dark"} {
		fileSlug := stringValue(colors[variantName])
		if fileSlug == "" || !safeBuiltInIconPathPart(fileSlug) {
			continue
		}
		if _, ok := svgFiles[fileSlug+".svg"]; ok {
			variants = append(variants, builtInIconVariant{Name: variantName, Path: "/svg/" + fileSlug + ".svg"})
		}
	}
	return variants
}

func titleFromBuiltInIconSlug(slug string) string {
	parts := strings.Split(slug, "-")
	for index, part := range parts {
		if part == "" {
			continue
		}
		parts[index] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}
