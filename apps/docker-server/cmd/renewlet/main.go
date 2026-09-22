package main

// main.go 是 Renewlet 的 PocketBase 应用入口。
//
// 架构位置：
//   - 负责启动 PocketBase、注册 schema migration、record hooks、cron 和自定义 HTTP route。
//   - 静态前端由 embedded FS 提供，自定义 API 使用 Renewlet 产品 session。
//   - 具体请求/响应 DTO 在 api_contracts.go，通知任务在 notifications.go，文件资产在 assets.go。
//
// 注意： 跨运行面 wire shape 以 shared schema 为事实源；Go route 必须通过共享 fixture 与 Worker 保持同一契约。
import (
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	pbrouter "github.com/pocketbase/pocketbase/tools/router"
	appstatic "github.com/zhiyingzzhou/renewlet/apps/docker-server/internal/static"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		return ensureSchema(app)
	}, nil, "20260514000000_renewlet_schema.go")
	core.AppMigrations.Register(func(app core.App) error {
		if err := ensureSchema(app); err != nil {
			return err
		}
		return backfillSubscriptionAutoRenew(app)
	}, nil, "20260608000000_subscription_auto_renew.go")
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		runHealthcheck()
		return
	}
	if len(os.Args) > 1 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Println(Version)
		return
	}

	if os.Getenv("GOMEMLIMIT") == "" {
		_ = os.Setenv("GOMEMLIMIT", "128MiB")
	}
	if err := validatePBEncryptionKeyEnv(); err != nil {
		log.Fatal(err)
	}
	// 配置在进程启动时冻结并贯穿静态 HTML 与响应 CSP，避免运行中环境变化造成“脚本已注入但策略仍严格”的分裂状态。
	customHeadHTML, err := customHeadHTMLFromEnv()
	if err != nil {
		log.Fatal(err)
	}
	pprofRuntime, err := startPprofFromEnv()
	if err != nil {
		log.Fatal(err)
	}
	logUpstreamHTTPProxyEnvironment(nil)

	app := pocketbase.New()
	if err := registerSubscriptionRenewalCron(app); err != nil {
		log.Fatal(err)
	}
	if err := registerNotificationCron(app); err != nil {
		log.Fatal(err)
	}
	if err := registerCloudBackupCron(app); err != nil {
		log.Fatal(err)
	}
	if err := registerDemoResetCron(app); err != nil {
		log.Fatal(err)
	}
	// Record hook 必须早于 Serve route 注册，这样 API、SDK 和管理后台写入都能共享同一套持久层校验。
	registerRecordHooks(app)

	app.OnBootstrap().BindFunc(func(e *core.BootstrapEvent) error {
		if err := e.Next(); err != nil {
			return err
		}
		if err := prepareExclusiveSchemaDataMigrations(e.App); err != nil {
			return err
		}
		// PocketBase migration history 只保证迁移文件跑一次；内部账本防止重复转换，排他契约仍会复核数据与 guard 漂移。
		if err := e.App.RunAppMigrations(); err != nil {
			return err
		}
		if err := ensureSchema(e.App); err != nil {
			return err
		}
		if err := defaultSystemUpdateService.InitializeState(e.App.DataDir()); err != nil {
			return err
		}
		return ensureDemoMode(e.App)
	})
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		// 更新任务只受服务生命周期和总超时控制；浏览器断开不会取消，PocketBase 退出则统一收敛后台工作。
		defaultSystemUpdateService.Shutdown()
		if err := pprofRuntime.Shutdown(); err != nil {
			return err
		}
		return e.Next()
	})

	registerAuthHooks(app)

	app.OnServe().Bind(&hook.Handler[*core.ServeEvent]{
		Func: func(e *core.ServeEvent) error {
			disablePocketBaseInstaller(e)
			registerRoutes(e.App, e.Router)

			staticFS, err := fs.Sub(appstatic.Files, "public")
			if err != nil {
				return err
			}
			if err := registerStaticFallback(e.Router, staticFS, customHeadHTML); err != nil {
				return err
			}

			return e.Next()
		},
		Priority: 999,
	})

	if err := app.Start(); err != nil {
		_ = pprofRuntime.Shutdown()
		log.Fatal(err)
	}
	if err := pprofRuntime.Shutdown(); err != nil {
		log.Printf("pprof shutdown failed: %v", err)
	}
}

func registerAuthHooks(app core.App) {
	rejectBannedAuthRecord := func(request *http.Request, collection *core.Collection, record *core.Record) error {
		if collection != nil && collection.Name == "users" && record != nil && record.GetBool("banned") {
			return apis.NewUnauthorizedError(localizedDisabledBanReason(requestLocale(request)), nil)
		}
		return nil
	}
	rejectMFAProtectedAuthRecord := func(request *http.Request, collection *core.Collection, record *core.Record) error {
		if collection == nil || collection.Name != "users" || record == nil {
			return nil
		}
		enabled, err := productAuthProtectedForUser(app, record.Id)
		if err != nil {
			return err
		}
		if enabled {
			// 启用认证器或通行密钥后只能走产品认证 API；PocketBase 原生 JWT 不携带 MFA/Passkey 完成状态。
			return apis.NewUnauthorizedError(serverText(requestLocale(request), "auth.loginRequired"), nil)
		}
		return nil
	}
	// PocketBase 原生 password、refresh 和通用 auth hook 都要拦；少拦一个就可能绕过产品 session 的 MFA 完成状态。
	app.OnRecordAuthWithPasswordRequest().BindFunc(func(e *core.RecordAuthWithPasswordRequestEvent) error {
		if err := rejectBannedAuthRecord(e.Request, e.Collection, e.Record); err != nil {
			return err
		}
		if err := rejectMFAProtectedAuthRecord(e.Request, e.Collection, e.Record); err != nil {
			return err
		}
		return e.Next()
	})
	app.OnRecordAuthRefreshRequest().BindFunc(func(e *core.RecordAuthRefreshRequestEvent) error {
		if err := rejectBannedAuthRecord(e.Request, e.Collection, e.Record); err != nil {
			return err
		}
		if err := rejectMFAProtectedAuthRecord(e.Request, e.Collection, e.Record); err != nil {
			return err
		}
		return e.Next()
	})
	app.OnRecordAuthRequest().BindFunc(func(e *core.RecordAuthRequestEvent) error {
		if err := rejectBannedAuthRecord(e.Request, e.Collection, e.Record); err != nil {
			return err
		}
		if err := rejectMFAProtectedAuthRecord(e.Request, e.Collection, e.Record); err != nil {
			return err
		}
		return e.Next()
	})
}

func disablePocketBaseInstaller(e *core.ServeEvent) {
	// 首装状态机只属于 Renewlet /setup；PocketBase installer 会另开 /_/#/pbinstall，导致 E2E 和用户看到两套入口。
	e.InstallerFunc = nil
}

func registerStaticFallback(
	router *pbrouter.Router[*core.RequestEvent],
	staticFS fs.FS,
	customHeadHTML customHeadHTMLConfig,
) error {
	if router.HasRoute("", "/") {
		return nil
	}
	preparedFS, err := prepareCustomHeadHTMLFS(staticFS, customHeadHTML)
	if err != nil {
		return err
	}
	staticHandler := staticWithSecurityHeaders(preparedFS, customHeadHTML)
	// Go 1.22+ ServeMux 会拒绝 GET /{path...} 与 /api/app/{path...} 这类非严格子集 pattern；根兜底保留 API wildcard 的优先级。
	router.Route("", "/", func(e *core.RequestEvent) error {
		if !shouldServeStaticFallback(e.Request) {
			return e.NotFoundError(serverText(requestLocale(e.Request), "common.notFound"), nil)
		}
		// PocketBase apis.Static 依赖 {path...} 的 PathValue；根兜底必须显式补齐，才能继续复用官方静态文件与 index fallback 行为。
		e.Request.SetPathValue(apis.StaticWildcardParam, strings.TrimPrefix(e.Request.URL.Path, "/"))
		return staticHandler(e)
	})
	return nil
}

func shouldServeStaticFallback(request *http.Request) bool {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		return false
	}
	path := request.URL.Path
	return path != "/api" && !strings.HasPrefix(path, "/api/")
}

func runHealthcheck() {
	url := "http://127.0.0.1:3000/api/app/health"
	for _, arg := range os.Args[2:] {
		if strings.HasPrefix(arg, "--url=") {
			url = strings.TrimPrefix(arg, "--url=")
		}
	}

	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		fmt.Fprintf(os.Stderr, "healthcheck failed: %s\n", resp.Status)
		os.Exit(1)
	}
}

func staticWithSecurityHeaders(staticFS fs.FS, customHeadHTML customHeadHTMLConfig) func(*core.RequestEvent) error {
	handler := staticWithContentEncoding(
		staticFS,
		apis.Static(staticFS, true),
	)
	return func(e *core.RequestEvent) error {
		headers := e.Response.Header()
		headers.Set("X-Content-Type-Options", "nosniff")
		headers.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		headers.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		headers.Set("Content-Security-Policy", staticContentSecurityPolicy(e.Request, customHeadHTML))
		headers.Set("Cache-Control", staticCacheControl(e.Request, staticFS))
		return handler(e)
	}
}

func staticCacheControl(request *http.Request, staticFS fs.FS) string {
	name := strings.TrimPrefix(path.Clean("/"+request.URL.Path), "/")
	if strings.HasPrefix(name, "assets/") {
		if _, err := fs.Stat(staticFS, name); err == nil {
			// Vite assets 带内容 hash；Docker 与 Cloudflare 必须同样长缓存，避免切页 chunk 每次重验证。
			return "public, max-age=31536000, immutable"
		}
	}
	return "no-cache"
}

func staticContentSecurityPolicy(request *http.Request, customHeadHTML customHeadHTMLConfig) string {
	if customHeadHTML.Enabled() {
		// 自定义 head 拥有同源代码权限；启用后只保留结构性 CSP，避免用不完整域名猜测制造“受限执行”的错误安全承诺。
		// 不得补回 default-src 或其他 fetch directive：default-src 会回退约束所有未声明资源类型，再次阻断动态脚本、请求、图片或 frame。
		directives := []string{
			"object-src 'none'",
			"base-uri 'self'",
			"frame-ancestors 'none'",
			"form-action 'self'",
		}
		if externalRequestProto(request) == "https" {
			directives = append(directives, "upgrade-insecure-requests")
		}
		return strings.Join(directives, "; ")
	}

	turnstileChallengeOrigin := "https://challenges.cloudflare.com"
	scriptSources := []string{"'self'", "'wasm-unsafe-eval'", turnstileChallengeOrigin}
	// 汇率仍由浏览器直连公开 provider；Turnstile widget 还会加载 challenge iframe，三份 CSP 必须同源列表同步。
	connectSources := []string{"'self'", "https://cdn.jsdelivr.net", "https://latest.currency-api.pages.dev", "https://api.frankfurter.dev", "https://www.floatrates.com", turnstileChallengeOrigin}
	directives := []string{
		"default-src 'self'",
		// wasm-unsafe-eval 只给前端 Worker 内 sql.js 解析用户本地 Wallos DB；不允许后端代请求 Wallos URL。
		"script-src " + strings.Join(scriptSources, " "),
		"style-src 'self' 'unsafe-inline'",
		"font-src 'self' data:",
		"img-src 'self' data: blob: " + staticImageSources(request),
		"connect-src " + strings.Join(connectSources, " "),
		"frame-src " + turnstileChallengeOrigin,
		"object-src 'none'",
		"base-uri 'self'",
		"frame-ancestors 'none'",
	}
	if externalRequestProto(request) == "https" {
		// HTTPS 外部访问不能实际发起 HTTP 图片请求；浏览器可升级域名源，IP 源由展示 helper 直接降级为 fallback。
		directives = append(directives, "upgrade-insecure-requests")
	}
	return strings.Join(directives, "; ")
}

func staticImageSources(request *http.Request) string {
	if externalRequestProto(request) == "https" {
		return "https:"
	}
	return "http: https:"
}
