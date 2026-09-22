package main

// env.go 收拢服务启动和 schema 配置使用的环境变量读取。
//
// 架构位置：这些 helper 只做字符串到强类型的窄化，调用方负责决定默认值和业务含义。
// 注意： 新增环境变量时不要在这里加入业务校验，否则不同启动路径会产生隐式差异。
import (
	"os"
	"strconv"
	"strings"
)

func envString(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func envInt(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envBool(name string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	if value == "" {
		return fallback
	}
	switch value {
	case "1", "true", "yes", "y", "on":
		return true
	case "0", "false", "no", "n", "off":
		return false
	default:
		return fallback
	}
}
