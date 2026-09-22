package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

const (
	customHeadHTMLEnvName  = "RENEWLET_CUSTOM_HEAD_HTML"
	customHeadHTMLMaxBytes = 64 * 1024
)

type customHeadHTMLConfig struct {
	Markup string
}

func (config customHeadHTMLConfig) Enabled() bool {
	return config.Markup != ""
}

func customHeadHTMLFromEnv() (customHeadHTMLConfig, error) {
	return parseCustomHeadHTML(os.Getenv(customHeadHTMLEnvName))
}

func parseCustomHeadHTML(raw string) (customHeadHTMLConfig, error) {
	if len(raw) > customHeadHTMLMaxBytes {
		return customHeadHTMLConfig{}, fmt.Errorf("%s exceeds the 64 KiB UTF-8 limit", customHeadHTMLEnvName)
	}
	if !utf8.ValidString(raw) {
		return customHeadHTMLConfig{}, fmt.Errorf("%s must be valid UTF-8", customHeadHTMLEnvName)
	}
	if strings.TrimSpace(raw) == "" {
		return customHeadHTMLConfig{}, nil
	}

	// HTML tree builder 会按规范恢复错误标签，因此“能解析”不代表源码仍被约束在 head 内；先拦截顶层文档边界，再用尾部哨兵确认片段没有吞掉后续宿主结构。
	if err := rejectDocumentEscapeTokens(raw); err != nil {
		return customHeadHTMLConfig{}, err
	}
	marker := customHeadHTMLMarker(raw)
	nodes, err := html.ParseFragment(
		strings.NewReader(raw+"<!--"+marker+"-->"),
		&html.Node{Type: html.ElementNode, DataAtom: atom.Head, Data: "head"},
	)
	if err != nil {
		return customHeadHTMLConfig{}, fmt.Errorf("parse %s: %w", customHeadHTMLEnvName, err)
	}
	if len(nodes) == 0 || nodes[len(nodes)-1].Type != html.CommentNode || nodes[len(nodes)-1].Data != marker {
		return customHeadHTMLConfig{}, fmt.Errorf("%s must be a complete head fragment", customHeadHTMLEnvName)
	}

	allowedElements := map[string]bool{
		"base": true, "link": true, "meta": true, "noscript": true,
		"script": true, "style": true, "template": true, "title": true,
	}
	for _, node := range nodes[:len(nodes)-1] {
		switch node.Type {
		case html.TextNode:
			if strings.TrimSpace(node.Data) != "" {
				return customHeadHTMLConfig{}, fmt.Errorf("%s must not contain non-whitespace top-level text", customHeadHTMLEnvName)
			}
		case html.CommentNode:
		case html.ElementNode:
			if node.Namespace != "" || !allowedElements[node.Data] {
				return customHeadHTMLConfig{}, fmt.Errorf("%s contains <%s>, which is not valid at the top level of a head fragment", customHeadHTMLEnvName, node.Data)
			}
		default:
			return customHeadHTMLConfig{}, fmt.Errorf("%s contains unsupported top-level markup", customHeadHTMLEnvName)
		}
	}

	// 该变量由实例部署者控制并拥有页面同源代码权限；这里只守住 head 结构，不清洗属性、重写脚本或推断外部资源。
	return customHeadHTMLConfig{Markup: raw}, nil
}

func rejectDocumentEscapeTokens(raw string) error {
	tokenizer := html.NewTokenizer(strings.NewReader(raw))
	// 这里只维护源码层的开放元素栈，用于区分顶层 document boundary escape 与 script/template 内部内容；它不是第二套 HTML 校验器。
	openElements := []string{}
	for {
		tokenType := tokenizer.Next()
		switch tokenType {
		case html.ErrorToken:
			if err := tokenizer.Err(); err != nil && !errors.Is(err, io.EOF) {
				return fmt.Errorf("parse %s: %w", customHeadHTMLEnvName, err)
			}
			return nil
		case html.DoctypeToken:
			return fmt.Errorf("%s must not contain a doctype", customHeadHTMLEnvName)
		case html.StartTagToken, html.SelfClosingTagToken:
			name, _ := tokenizer.TagName()
			tagName := strings.ToLower(string(name))
			if len(openElements) == 0 && isHTMLDocumentBoundaryTag(tagName) {
				return fmt.Errorf("%s must not contain head, html, or body tags", customHeadHTMLEnvName)
			}
			if tokenType == html.StartTagToken && !isVoidHTMLElement(tagName) {
				openElements = append(openElements, tagName)
			}
		case html.EndTagToken:
			name, _ := tokenizer.TagName()
			tagName := strings.ToLower(string(name))
			if len(openElements) == 0 && isHTMLDocumentBoundaryTag(tagName) {
				return fmt.Errorf("%s must not contain head, html, or body tags", customHeadHTMLEnvName)
			}
			matched := false
			for index := len(openElements) - 1; index >= 0; index-- {
				if openElements[index] == tagName {
					openElements = openElements[:index]
					matched = true
					break
				}
			}
			if !matched && len(openElements) == 0 {
				return fmt.Errorf("%s contains an unmatched top-level closing tag", customHeadHTMLEnvName)
			}
		}
	}
}

func isHTMLDocumentBoundaryTag(tagName string) bool {
	return tagName == "head" || tagName == "html" || tagName == "body"
}

func isVoidHTMLElement(tagName string) bool {
	switch tagName {
	case "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr":
		return true
	default:
		return false
	}
}

func customHeadHTMLMarker(raw string) string {
	marker := "renewlet-custom-head-html-end"
	for strings.Contains(raw, marker) {
		marker += "-marker"
	}
	return marker
}

type customHeadHTMLFS struct {
	fs.FS
	index     []byte
	indexInfo fs.FileInfo
}

func prepareCustomHeadHTMLFS(staticFS fs.FS, config customHeadHTMLConfig) (fs.FS, error) {
	if !config.Enabled() {
		return staticFS, nil
	}
	content, err := fs.ReadFile(staticFS, "index.html")
	if err != nil {
		return nil, fmt.Errorf("read embedded index.html: %w", err)
	}
	info, err := fs.Stat(staticFS, "index.html")
	if err != nil {
		return nil, fmt.Errorf("stat embedded index.html: %w", err)
	}
	injected, err := injectCustomHeadHTML(content, config)
	if err != nil {
		return nil, err
	}
	// 启动期只物化 index.html；其余资产继续委托给 embedded FS，避免破坏 hash 缓存、SPA fallback 与预压缩协商。
	return customHeadHTMLFS{FS: staticFS, index: injected, indexInfo: info}, nil
}

func (fsys customHeadHTMLFS) Open(name string) (fs.File, error) {
	if name != "index.html" {
		return fsys.FS.Open(name)
	}
	return &staticMemoryFile{
		Reader: bytes.NewReader(fsys.index),
		info:   staticFileInfo{FileInfo: fsys.indexInfo, size: int64(len(fsys.index))},
	}, nil
}

type staticMemoryFile struct {
	*bytes.Reader
	info fs.FileInfo
}

func (file *staticMemoryFile) Stat() (fs.FileInfo, error) {
	return file.info, nil
}

func (file *staticMemoryFile) Close() error {
	return nil
}

type staticFileInfo struct {
	fs.FileInfo
	size int64
}

func (info staticFileInfo) Size() int64 {
	// apis.Static 依据 FileInfo 生成 Content-Length；注入后的内存文件不能沿用 embedded index.html 的原始大小。
	return info.size
}

func injectCustomHeadHTML(content []byte, config customHeadHTMLConfig) ([]byte, error) {
	if !config.Enabled() {
		return content, nil
	}
	// tokenizer 只定位宿主的显式 </head>，按原始字节偏移注入，避免 DOM 序列化改写页面或部署者片段。
	closeOffset, err := explicitHeadCloseOffset(content)
	if err != nil {
		return nil, err
	}
	var output bytes.Buffer
	output.Grow(len(content) + len(config.Markup) + 2)
	output.Write(content[:closeOffset])
	output.WriteByte('\n')
	output.WriteString(config.Markup)
	output.WriteByte('\n')
	output.Write(content[closeOffset:])
	return output.Bytes(), nil
}

func explicitHeadCloseOffset(content []byte) (int, error) {
	tokenizer := html.NewTokenizer(bytes.NewReader(content))
	offset := 0
	foundHead := false
	for {
		tokenType := tokenizer.Next()
		rawToken := tokenizer.Raw()
		startOffset := offset
		offset += len(rawToken)
		switch tokenType {
		case html.ErrorToken:
			if err := tokenizer.Err(); err != nil && !errors.Is(err, io.EOF) {
				return 0, fmt.Errorf("parse embedded index.html: %w", err)
			}
			return 0, errors.New("embedded index.html must contain an explicit head element")
		case html.StartTagToken:
			name, _ := tokenizer.TagName()
			if bytes.EqualFold(name, []byte("head")) {
				foundHead = true
			}
		case html.EndTagToken:
			name, _ := tokenizer.TagName()
			if foundHead && bytes.EqualFold(name, []byte("head")) {
				return startOffset, nil
			}
		}
	}
}
