// Package static 嵌入 Go/PocketBase 运行面需要直接随二进制发布的静态资源。
//
// Docker 默认链路会先构建 Vite 前端并同步到 public，再编译 server；这里的 embed 是运行时
// 不依赖外部文件系统的部署边界，也是页面内自更新替换二进制后仍能服务前端的前提。
package static

import "embed"

// Files 包含 Vite 构建产物；Docker 构建时会在编译 Go 二进制前，
// 用 apps/web/dist 替换这个目录。
//
//go:embed all:public
var Files embed.FS

// BuiltInIconsSearchIndexGzip 是普通 Logo/Icon 搜索使用的压缩热索引。
// 该文件由 scripts/update-built-in-icons-index.mjs 同步生成，不应手写修改。
//
//go:embed data/built-in-icons-search-index.json.gz
var BuiltInIconsSearchIndexGzip []byte

// BuiltInIconsDetailIndexGzip 是管理员刷新时合并 provider 使用的压缩完整索引。
// 普通搜索路径不能解析它，避免冷字段进入 Docker 常驻内存。
//
//go:embed data/built-in-icons-detail-index.json.gz
var BuiltInIconsDetailIndexGzip []byte

// BuiltInIconsIndexMetadata 是内置图标 seed 的 provider 级真实 GitHub 版本。
// 当前版本展示依赖这里的 commit 元数据，不能退回到 embedded/runtime 这类索引来源词。
//
//go:embed data/built-in-icons-index-metadata.json
var BuiltInIconsIndexMetadata []byte

// MediaResolverConfig 是 Logo/Icon 候选解析的共享配置快照。
// Go 后端与 shared 包必须使用同一份 JSON，避免 Docker 与 Cloudflare 候选排序和预算漂移。
//
//go:embed data/media-resolver-config.json
var MediaResolverConfig []byte

// AIRecognitionPrompt 是 AI 识别提示词事实源的 Go 嵌入副本。
// 该副本由 scripts/sync-ai-recognition-prompt.mjs 从 packages/shared/data 同步，避免 Docker/Worker 提示词漂移。
//
//go:embed data/ai-recognition-prompt.json
var AIRecognitionPrompt []byte
