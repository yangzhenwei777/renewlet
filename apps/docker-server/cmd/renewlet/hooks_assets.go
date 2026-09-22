package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

// normalizeAssetRecord 校验上传资产记录。
// 为什么读取 MIME：文件扩展名和 Content-Type 都可伪造，必须按文件头重新判断。
func normalizeAssetRecord(record *core.Record) error {
	kind := record.GetString("kind")
	if kind != "logo" && kind != "icon" {
		return errors.New("ASSET_KIND_INVALID")
	}
	files := record.GetUnsavedFiles("file")
	if len(files) == 0 {
		return nil
	}
	if len(files) > 1 {
		return errors.New("ASSET_FILE_TOO_MANY")
	}
	file := files[0]
	if file.Size <= 0 || file.Size > maxImageBytes {
		return errors.New("ASSET_FILE_SIZE_INVALID")
	}
	mimeType, err := detectUploadMimeType(file.Reader)
	if err != nil {
		return err
	}
	if !isAllowedImageMime(mimeType) {
		return errors.New("ASSET_FILE_TYPE_INVALID")
	}
	record.Set("mimeType", mimeType)
	record.Set("sizeBytes", file.Size)
	record.Set("originalName", strings.TrimSpace(file.OriginalName))
	return nil
}

// detectUploadMimeType 读取文件头判断真实 MIME。
// 注意： 调用方传入的是 PocketBase 文件 reader，需要在这里打开并关闭，避免泄漏文件句柄。
func detectUploadMimeType(reader interface {
	Open() (io.ReadSeekCloser, error)
}) (string, error) {
	f, err := reader.Open()
	if err != nil {
		return "", errors.New("ASSET_FILE_READ_FAILED")
	}
	defer f.Close()

	data, err := io.ReadAll(io.LimitReader(f, maxImageBytes+1))
	if err != nil {
		return "", errors.New("ASSET_FILE_READ_FAILED")
	}
	if isSVGDocument(data) {
		return "image/svg+xml", nil
	}
	if isICODocument(data) {
		return "image/x-icon", nil
	}
	if len(data) > 512 {
		data = data[:512]
	}
	return http.DetectContentType(data), nil
}

func isSVGDocument(data []byte) bool {
	decoder := xml.NewDecoder(bytes.NewReader(bytes.TrimSpace(data)))
	for {
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		if start, ok := token.(xml.StartElement); ok {
			// 只看第一个 XML start element，允许 XML 声明/注释，同时拒绝伪装成 SVG 的其他 XML。
			return strings.EqualFold(start.Name.Local, "svg") &&
				(start.Name.Space == "" || start.Name.Space == "http://www.w3.org/2000/svg")
		}
	}
}

func isICODocument(data []byte) bool {
	if len(data) < 6 {
		return false
	}
	// ICO 头：reserved=0、type=1、imageCount>0；比扩展名可靠，且无需解析完整图片目录。
	return data[0] == 0x00 &&
		data[1] == 0x00 &&
		data[2] == 0x01 &&
		data[3] == 0x00 &&
		(data[4] != 0x00 || data[5] != 0x00)
}

// isAllowedImageMime 限制可上传图片格式。
func isAllowedImageMime(mimeType string) bool {
	normalizedMimeType := strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	switch normalizedMimeType {
	case "image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon":
		return true
	default:
		return false
	}
}
