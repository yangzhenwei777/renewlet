package main

// encryption_env.go 校验 PocketBase 敏感配置加密密钥。
//
// 架构位置：main.go 在创建 PocketBase app 前调用这里，尽早阻断错误的
// PB_ENCRYPTION_KEY，避免应用启动后才在 settings/邮件配置读写时失败。
//
// 注意： 空值表示使用 PocketBase 默认行为；一旦生产环境设置了密钥，部署后不要随意更换。
import (
	"fmt"
	"os"
)

const (
	pbEncryptionKeyEnv    = "PB_ENCRYPTION_KEY"
	pbEncryptionKeyLength = 32
)

func validatePBEncryptionKeyEnv() error {
	value := os.Getenv(pbEncryptionKeyEnv)
	if value == "" {
		return nil
	}

	if len(value) != pbEncryptionKeyLength {
		return fmt.Errorf("%s must be exactly %d characters; got %d; generate one with: openssl rand -hex 16", pbEncryptionKeyEnv, pbEncryptionKeyLength, len(value))
	}

	return nil
}
