package snapshotzip

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"io"
	"path"
	"strings"
)

var (
	// 这些哨兵错误跨 internal 边界映射为稳定业务 code；调用方不应通过错误文本猜失败类型。
	ErrArchiveTooLarge   = errors.New("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE")
	ErrAssetTooLarge     = errors.New("CLOUD_BACKUP_ASSET_TOO_LARGE")
	ErrAssetSizeMismatch = errors.New("CLOUD_BACKUP_ASSET_SIZE_MISMATCH")
	ErrInvalidEntry      = errors.New("CLOUD_BACKUP_INVALID_ENTRY")
)

// Asset 描述一个不预载内容的 ZIP 资产来源。
type Asset struct {
	Name string
	Size int64
	Open func() (io.ReadCloser, error)
}

// JSONEntry 由 encoder 直接写入 ZIP entry，避免为 metadata 再创建完整 JSON 副本。
type JSONEntry struct {
	Name  string
	Value any
}

// Options 同时定义逐资产和最终压缩包硬上限；两者都在写入过程中执行，不依赖调用方预检。
type Options struct {
	Assets          []Asset
	JSONEntries     []JSONEntry
	MaxAssetBytes   int64
	MaxArchiveBytes int64
}

// Result 只记录资源趋势所需的计数，不包含资产名、业务内容或 secret。
type Result struct {
	Entries      int
	AssetBytes   int64
	ArchiveBytes int64
}

// Write 逐项读取资产并在压缩输出超过上限时立即停止；调用方仍拥有 destination 的关闭生命周期。
func Write(destination io.Writer, options Options) (Result, error) {
	if destination == nil || options.MaxAssetBytes < 0 || options.MaxArchiveBytes <= 0 {
		return Result{}, ErrInvalidEntry
	}
	limited := &archiveLimitWriter{destination: destination, limit: options.MaxArchiveBytes}
	writer := zip.NewWriter(limited)
	closed := false
	defer func() {
		if !closed {
			_ = writer.Close()
		}
	}()

	seen := make(map[string]struct{}, len(options.Assets)+len(options.JSONEntries))
	result := Result{}
	copyBuffer := make([]byte, 32*1024)
	for _, asset := range options.Assets {
		if err := reserveEntryName(seen, asset.Name); err != nil {
			return Result{}, err
		}
		if asset.Open == nil || asset.Size < 0 {
			return Result{}, ErrInvalidEntry
		}
		if asset.Size > options.MaxAssetBytes {
			return Result{}, ErrAssetTooLarge
		}
		entry, err := writer.Create(asset.Name)
		if err != nil {
			return Result{}, err
		}
		reader, err := asset.Open()
		if err != nil {
			return Result{}, err
		}
		// metadata size 只用于预分配/预算，真实流仍多读 1 byte 并核对长度，防止底层文件在扫描后被替换。
		written, copyErr := io.CopyBuffer(entry, io.LimitReader(reader, options.MaxAssetBytes+1), copyBuffer)
		closeErr := reader.Close()
		if copyErr != nil {
			return Result{}, copyErr
		}
		if closeErr != nil {
			return Result{}, closeErr
		}
		if written > options.MaxAssetBytes {
			return Result{}, ErrAssetTooLarge
		}
		if written != asset.Size {
			return Result{}, ErrAssetSizeMismatch
		}
		result.Entries++
		result.AssetBytes += written
	}

	for _, jsonEntry := range options.JSONEntries {
		if err := reserveEntryName(seen, jsonEntry.Name); err != nil {
			return Result{}, err
		}
		entry, err := writer.Create(jsonEntry.Name)
		if err != nil {
			return Result{}, err
		}
		if err := json.NewEncoder(entry).Encode(jsonEntry.Value); err != nil {
			return Result{}, err
		}
		result.Entries++
	}

	closeErr := writer.Close()
	closed = true
	if closeErr != nil {
		return Result{}, closeErr
	}
	result.ArchiveBytes = limited.written
	return result, nil
}

func reserveEntryName(seen map[string]struct{}, name string) error {
	cleaned := path.Clean(name)
	if name == "" || strings.Contains(name, "\\") || cleaned != name || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "/") || strings.HasPrefix(cleaned, "../") {
		return ErrInvalidEntry
	}
	if _, exists := seen[name]; exists {
		return ErrInvalidEntry
	}
	seen[name] = struct{}{}
	return nil
}

type archiveLimitWriter struct {
	destination io.Writer
	limit       int64
	written     int64
}

func (writer *archiveLimitWriter) Write(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	remaining := writer.limit - writer.written
	if remaining <= 0 {
		return 0, ErrArchiveTooLarge
	}
	// ZIP 尾目录也计入同一硬上限；只写剩余容量后返回稳定错误，防止底层 writer 短写被误判为成功。
	if int64(len(data)) > remaining {
		written, err := writer.destination.Write(data[:int(remaining)])
		writer.written += int64(written)
		if err != nil {
			return written, err
		}
		if int64(written) != remaining {
			return written, io.ErrShortWrite
		}
		return written, ErrArchiveTooLarge
	}
	written, err := writer.destination.Write(data)
	writer.written += int64(written)
	if err == nil && written != len(data) {
		return written, io.ErrShortWrite
	}
	return written, err
}
