package main

import (
	"io/fs"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const (
	staticEncodingBrotli = "br"
	staticEncodingGzip   = "gzip"
)

type staticRepresentation struct {
	filename    string
	contentType string
	encoding    string
	contentSize int64
}

type acceptedStaticEncodings struct {
	present  bool
	explicit map[string]int
	wildcard int
}

func staticWithContentEncoding(staticFS fs.FS, next func(*core.RequestEvent) error) func(*core.RequestEvent) error {
	return func(event *core.RequestEvent) error {
		filename := normalizeStaticFilename(event.Request.PathValue(apis.StaticWildcardParam))
		representation, acceptable := selectStaticRepresentation(event.Request, staticFS, filename)
		// 200 identity、预压缩表示与 406 都由 Accept-Encoding 决定；Vary 必须覆盖整条协商路径，避免共享缓存复用错误响应。
		event.Response.Header().Add("Vary", "Accept-Encoding")
		if !acceptable {
			return event.NoContent(http.StatusNotAcceptable)
		}
		if representation.encoding != "" {
			// URL 与缓存键仍表示原资源；只替换嵌入文件表示，MIME 必须继续按原扩展名计算。
			event.Request.SetPathValue(apis.StaticWildcardParam, representation.filename)
			event.Response.Header().Set("Content-Encoding", representation.encoding)
			event.Response.Header().Set("Content-Type", representation.contentType)
			event.Response.Header().Set("Content-Length", strconv.FormatInt(representation.contentSize, 10))
		}
		return next(event)
	}
}

func selectStaticRepresentation(
	request *http.Request,
	staticFS fs.FS,
	filename string,
) (staticRepresentation, bool) {
	identity := staticRepresentation{filename: filename}
	info, err := fs.Stat(staticFS, filename)
	if err != nil || info.IsDir() || filename == "index.html" {
		// 不存在的前端导航由 apis.Static 回退到运行时注入后的 index；它只提供 identity 表示，仍必须服从客户端的明确拒绝。
		accepted := parseAcceptedStaticEncodings(request.Header.Values("Accept-Encoding"))
		return identity, accepted.quality("identity") > 0
	}

	type candidate struct {
		staticRepresentation
		available bool
		quality   int
	}
	accepted := parseAcceptedStaticEncodings(request.Header.Values("Accept-Encoding"))
	contentType := mime.TypeByExtension(filepath.Ext(filename))
	brotliSize, brotliAvailable := staticFileSize(staticFS, filename+".br")
	gzipSize, gzipAvailable := staticFileSize(staticFS, filename+".gz")
	candidates := []candidate{
		{
			staticRepresentation: staticRepresentation{
				filename:    filename + ".br",
				contentType: contentType,
				encoding:    staticEncodingBrotli,
				contentSize: brotliSize,
			},
			available: brotliAvailable,
			quality:   accepted.quality(staticEncodingBrotli),
		},
		{
			staticRepresentation: staticRepresentation{
				filename:    filename + ".gz",
				contentType: contentType,
				encoding:    staticEncodingGzip,
				contentSize: gzipSize,
			},
			available: gzipAvailable,
			quality:   accepted.quality(staticEncodingGzip),
		},
		{
			staticRepresentation: identity,
			available:            true,
			quality:              accepted.quality("identity"),
		},
	}

	bestQuality := 0
	selected := identity
	for _, candidate := range candidates {
		if candidate.available && candidate.quality > bestQuality {
			bestQuality = candidate.quality
			selected = candidate.staticRepresentation
		}
	}
	return selected, bestQuality > 0
}

func normalizeStaticFilename(filename string) string {
	return filepath.ToSlash(filepath.Clean(strings.TrimPrefix(filename, "/")))
}

func staticFileSize(staticFS fs.FS, filename string) (int64, bool) {
	info, err := fs.Stat(staticFS, filename)
	if err != nil || info.IsDir() {
		return 0, false
	}
	return info.Size(), true
}

func parseAcceptedStaticEncodings(headerValues []string) acceptedStaticEncodings {
	accepted := acceptedStaticEncodings{
		present:  len(headerValues) > 0,
		explicit: map[string]int{},
		wildcard: -1,
	}
	for _, header := range headerValues {
		for _, rawItem := range strings.Split(header, ",") {
			parts := strings.Split(rawItem, ";")
			coding := strings.ToLower(strings.TrimSpace(parts[0]))
			if coding == "" {
				continue
			}
			quality := 1000
			valid := true
			for _, rawParameter := range parts[1:] {
				name, value, ok := strings.Cut(rawParameter, "=")
				if !ok || !strings.EqualFold(strings.TrimSpace(name), "q") {
					continue
				}
				quality, valid = parseHTTPQuality(strings.TrimSpace(value))
				break
			}
			if !valid {
				continue
			}
			if coding == "*" {
				accepted.wildcard = max(accepted.wildcard, quality)
				continue
			}
			accepted.explicit[coding] = max(accepted.explicit[coding], quality)
		}
	}
	return accepted
}

func (accepted acceptedStaticEncodings) quality(coding string) int {
	if !accepted.present {
		if coding == "identity" {
			return 1000
		}
		return 0
	}
	if quality, ok := accepted.explicit[coding]; ok {
		return quality
	}
	if coding == "identity" {
		// identity 默认可接受；只有明确拒绝 identity，或用 *;q=0 排除一切未点名编码时才禁止。
		if accepted.wildcard == 0 {
			return 0
		}
		return 1000
	}
	if accepted.wildcard >= 0 {
		return accepted.wildcard
	}
	return 0
}

func parseHTTPQuality(raw string) (int, bool) {
	whole, fraction, hasFraction := strings.Cut(raw, ".")
	if whole != "0" && whole != "1" {
		return 0, false
	}
	if !hasFraction {
		return map[string]int{"0": 0, "1": 1000}[whole], true
	}
	if len(fraction) > 3 {
		return 0, false
	}
	for _, digit := range fraction {
		if digit < '0' || digit > '9' || whole == "1" && digit != '0' {
			return 0, false
		}
	}
	for len(fraction) < 3 {
		fraction += "0"
	}
	quality := 0
	for _, digit := range fraction {
		quality = quality*10 + int(digit-'0')
	}
	if whole == "1" {
		return 1000, true
	}
	return quality, true
}
