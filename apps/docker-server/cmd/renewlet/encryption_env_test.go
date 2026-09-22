package main

// PB_ENCRYPTION_KEY 测试保护部署前失败策略；32 字符约束必须在 PocketBase 加密字段被读写前早停。

import (
	"fmt"
	"strings"
	"testing"
)

func TestValidatePBEncryptionKeyEnv(t *testing.T) {
	tests := []struct {
		name      string
		value     string
		wantError bool
	}{
		{
			name: "empty value is allowed",
		},
		{
			name:  "valid 32 character value",
			value: strings.Repeat("a", 32),
		},
		{
			name:      "31 character value fails",
			value:     strings.Repeat("a", 31),
			wantError: true,
		},
		{
			name:      "33 character value fails",
			value:     strings.Repeat("a", 33),
			wantError: true,
		},
		{
			name:      "44 character base64 value fails",
			value:     strings.Repeat("a", 44),
			wantError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(pbEncryptionKeyEnv, tt.value)

			err := validatePBEncryptionKeyEnv()
			if tt.wantError {
				if err == nil {
					t.Fatal("expected an error")
				}
				if !strings.Contains(err.Error(), fmt.Sprintf("got %d", len(tt.value))) {
					t.Fatalf("expected error to include actual length, got %q", err.Error())
				}
				return
			}

			if err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
		})
	}
}
