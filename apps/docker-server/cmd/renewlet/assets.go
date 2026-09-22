package main

// assets.go 提供受认证保护的用户上传资产读取接口。
//
// 架构位置：
//   - 图片写入走 PocketBase assets collection。
//   - 前端 AuthorizedImage 通过 `/api/app/assets/{id}` 携带认证读取私有文件。
//
// 注意： 不要直接暴露 PocketBase 文件公开 URL；Logo/Icon 可能属于用户私有数据，必须校验 record.user。
import (
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

// handleAssetRead 读取当前用户拥有的资产文件并写入响应流。
// Cache-Control 使用 private immutable，是因为文件 ID 对应不可变上传结果，但不能被共享缓存复用。
func handleAssetRead(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return e.BadRequestError(serverText(locale, "asset.idInvalid"), nil)
	}

	record, err := app.FindRecordById("assets", id)
	if err != nil {
		return e.NotFoundError(serverText(locale, "asset.missing"), err)
	}
	// PocketBase 文件路径不能当授权依据；record.user 才是资产归属的事实源。
	if record.GetString("user") != e.Auth.Id {
		// 对越权访问返回 404 而非 403，避免泄漏其他用户资产 ID 是否存在。
		return e.NotFoundError(serverText(locale, "asset.missing"), nil)
	}

	return writeAssetRecord(app, e, record, "private, max-age=31536000, immutable", false)
}

func writeAssetRecord(app core.App, e *core.RequestEvent, record *core.Record, cacheControl string, noIndex bool) error {
	locale := requestLocale(e.Request)
	filename := record.GetString("file")
	if filename == "" {
		return e.NotFoundError(serverText(locale, "asset.fileMissing"), nil)
	}

	fsys, err := app.NewFilesystem()
	if err != nil {
		return e.InternalServerError(serverText(locale, "asset.fileSystemOpenFailed"), err)
	}
	defer fsys.Close()

	reader, err := fsys.GetReader(record.BaseFilesPath() + "/" + filename)
	if err != nil {
		return e.NotFoundError(serverText(locale, "asset.fileMissing"), err)
	}
	defer reader.Close()

	contentType := strings.TrimSpace(record.GetString("mimeType"))
	if contentType == "" {
		// 历史记录可能没有 mimeType；读取时只兜底响应头，不回写 collection，避免 GET 产生数据副作用。
		contentType = reader.ContentType()
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	headers := e.Response.Header()
	headers.Set("Content-Type", contentType)
	headers.Set("Cache-Control", cacheControl)
	headers.Set("X-Content-Type-Options", "nosniff")
	if noIndex {
		headers.Set("X-Robots-Tag", "noindex, nofollow")
	}
	if strings.EqualFold(strings.TrimSpace(strings.Split(contentType, ";")[0]), "image/svg+xml") {
		// SVG 是可执行载体，单独加沙箱 CSP，允许内联样式但禁止脚本/外部对象。
		headers.Set("Content-Security-Policy", "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; sandbox")
	}
	if size := reader.Size(); size >= 0 {
		headers.Set("Content-Length", strconv.FormatInt(size, 10))
	}

	e.Response.WriteHeader(http.StatusOK)
	_, copyErr := io.Copy(e.Response, reader)
	return copyErr
}
