package snapshotzip

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestWriteStreamsAssetsAndJSON(t *testing.T) {
	t.Parallel()
	assetContent := bytes.Repeat([]byte("asset-data-"), 8_192)
	closed := false
	var destination bytes.Buffer
	result, err := Write(&destination, Options{
		Assets: []Asset{{
			Name: "assets/logo.bin",
			Size: int64(len(assetContent)),
			Open: func() (io.ReadCloser, error) {
				return &trackedReadCloser{Reader: bytes.NewReader(assetContent), closed: &closed}, nil
			},
		}},
		JSONEntries:     []JSONEntry{{Name: "data.json", Value: map[string]string{"kind": "renewlet-export"}}},
		MaxAssetBytes:   int64(len(assetContent)),
		MaxArchiveBytes: 1 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !closed {
		t.Fatal("expected asset reader to be closed")
	}
	if result.Entries != 2 || result.AssetBytes != int64(len(assetContent)) || result.ArchiveBytes != int64(destination.Len()) {
		t.Fatalf("unexpected write result: %#v", result)
	}
	reader, err := zip.NewReader(bytes.NewReader(destination.Bytes()), int64(destination.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(reader.File) != 2 {
		t.Fatalf("expected two ZIP entries, got %d", len(reader.File))
	}
}

func TestWriteRejectsAssetSizeMismatch(t *testing.T) {
	t.Parallel()
	var destination bytes.Buffer
	_, err := Write(&destination, Options{
		Assets: []Asset{{
			Name: "assets/logo.bin",
			Size: 4,
			Open: func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader([]byte("short"))), nil },
		}},
		MaxAssetBytes:   16,
		MaxArchiveBytes: 1 << 20,
	})
	if !errors.Is(err, ErrAssetSizeMismatch) {
		t.Fatalf("expected size mismatch, got %v", err)
	}
}

func TestWriteRejectsAssetAndArchiveLimits(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		options Options
		target  error
	}{
		{
			name: "asset metadata exceeds limit",
			options: Options{
				Assets: []Asset{{Name: "assets/logo.bin", Size: 17, Open: func() (io.ReadCloser, error) {
					return io.NopCloser(bytes.NewReader(make([]byte, 17))), nil
				}}},
				MaxAssetBytes: 16, MaxArchiveBytes: 1 << 20,
			},
			target: ErrAssetTooLarge,
		},
		{
			name: "archive output exceeds limit",
			options: Options{
				JSONEntries:   []JSONEntry{{Name: "data.json", Value: map[string]string{"value": "content"}}},
				MaxAssetBytes: 16, MaxArchiveBytes: 1,
			},
			target: ErrArchiveTooLarge,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var destination bytes.Buffer
			_, err := Write(&destination, test.options)
			if !errors.Is(err, test.target) {
				t.Fatalf("expected %v, got %v", test.target, err)
			}
		})
	}
}

func TestWriteRejectsUnsafeOrDuplicateEntryNames(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"..", "../data.json", "/data.json", "assets/../data.json", `assets\data.json`, ""} {
		var destination bytes.Buffer
		_, err := Write(&destination, Options{
			JSONEntries:   []JSONEntry{{Name: name, Value: map[string]string{}}},
			MaxAssetBytes: 16, MaxArchiveBytes: 1 << 20,
		})
		if !errors.Is(err, ErrInvalidEntry) {
			t.Fatalf("expected %q to be rejected, got %v", name, err)
		}
	}

	var destination bytes.Buffer
	_, err := Write(&destination, Options{
		JSONEntries:   []JSONEntry{{Name: "data.json", Value: nil}, {Name: "data.json", Value: nil}},
		MaxAssetBytes: 16, MaxArchiveBytes: 1 << 20,
	})
	if !errors.Is(err, ErrInvalidEntry) {
		t.Fatalf("expected duplicate entry to be rejected, got %v", err)
	}
}

func TestArchiveLimitWriterPreservesWriterContract(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name        string
		destination io.Writer
		limit       int64
		data        []byte
		wantWritten int
		wantErr     error
	}{
		{
			name:        "zero length write at limit",
			destination: io.Discard,
			limit:       0,
			data:        []byte{},
			wantWritten: 0,
		},
		{
			name:        "archive limit truncates output",
			destination: io.Discard,
			limit:       2,
			data:        []byte("data"),
			wantWritten: 2,
			wantErr:     ErrArchiveTooLarge,
		},
		{
			name:        "underlying short write is surfaced",
			destination: shortWriter{},
			limit:       8,
			data:        []byte("data"),
			wantWritten: 1,
			wantErr:     io.ErrShortWrite,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			writer := &archiveLimitWriter{destination: test.destination, limit: test.limit}
			written, err := writer.Write(test.data)
			if written != test.wantWritten || !errors.Is(err, test.wantErr) {
				t.Fatalf("Write() = (%d, %v), want (%d, %v)", written, err, test.wantWritten, test.wantErr)
			}
		})
	}
}

type trackedReadCloser struct {
	*bytes.Reader
	closed *bool
}

func (reader *trackedReadCloser) Close() error {
	*reader.closed = true
	return nil
}

type shortWriter struct{}

func (shortWriter) Write(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	return 1, nil
}
