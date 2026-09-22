package main

var (
	// Version 是发布版本号；release workflow 通过 ldflags 注入，source/dev 构建保留默认值。
	Version = "0.0.0-dev"
	// Commit 是构建所对应的 Git SHA，用于管理员版本弹窗和故障排查。
	Commit = "dev"
	// BuildTime 是 UTC 构建时间；Cloudflare/Go 两个运行面都以字符串形式向前端暴露。
	BuildTime = ""
	// BuildType 区分 source/release/cloudflare，页面内自更新只允许 release Docker 布局。
	BuildType = "source"
)
