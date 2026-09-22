package main

// system_update_types.go 定义 Docker 页面内自更新的状态与 Release feed 数据形状。
import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	systemUpdateRepository    = "zhiyingzzhou/renewlet"
	systemUpdateChannelStable = "stable"
	systemUpdateChannelRC     = "rc"
	systemUpdateCacheTTL      = 20 * time.Minute
	systemUpdateCheckTimeout  = 15 * time.Second
	// 小资产保留总请求超时；大归档分别限制响应头、连续无进展和 operation 总时长，三者不能合并回 Client.Timeout。
	systemUpdateAssetRequestTimeout   = 30 * time.Second
	systemUpdateDownloadHeaderTimeout = 30 * time.Second
	systemUpdateDownloadIdleTimeout   = 60 * time.Second
	systemUpdateOperationTimeout      = 30 * time.Minute
	systemUpdateShutdownWait          = 3 * time.Second
	systemUpdateReleaseFeedLimitBytes = 512 * 1024
	systemUpdateMaxArchiveBytes       = 200 * 1024 * 1024
	systemUpdateMaxChecksumBytes      = 2 * 1024 * 1024
	systemUpdateStateDirectory        = ".renewlet"
	systemUpdateStateFilename         = "system-update.json"
	defaultSelfUpdateBinaryPath       = "/opt/renewlet/current/renewlet"
	defaultSelfUpdateBackupDir        = "/opt/renewlet/backups"

	systemUpdateStatusRunning   = "running"
	systemUpdateStatusSucceeded = "succeeded"
	systemUpdateStatusFailed    = "failed"

	systemUpdateStageChecking       = "checking"
	systemUpdateStageDownloading    = "downloading"
	systemUpdateStageVerifying      = "verifying"
	systemUpdateStageInstalling     = "installing"
	systemUpdateStageRestartPending = "restart-pending"
	systemUpdateStageCompleted      = "completed"
)

var (
	errSystemUpdateUnsupported = errors.New("system update unsupported")
	errSystemUpdateNoUpdate    = errors.New("system update no update")
	errSystemRestartNotPending = errors.New("system restart not pending")

	defaultSystemUpdateService = newSystemUpdateService(defaultSystemReleaseClient())
)

// systemUpdateError 保留可本地化 message，同时让 route 能用 errors.Is 映射 HTTP 状态。
type systemUpdateError struct {
	kind    error
	message string
}

func (e systemUpdateError) Error() string {
	return e.message
}

func (e systemUpdateError) Is(target error) bool {
	return target == e.kind
}

type systemReleaseClient interface {
	// Release client 是系统更新测试的隔离点；生产实现只读 GitHub Web Release feed，不再依赖 REST/token。
	FetchReleases(ctx context.Context) ([]systemRelease, error)
	ProbeReleaseAssets(ctx context.Context, tagName string, version string) []systemReleaseAsset
	DownloadFile(ctx context.Context, sourceURL string, targetPath string, expectedSize int64, maxBytes int64) (string, error)
	FetchText(ctx context.Context, sourceURL string, maxBytes int64) ([]byte, error)
}

// 展示响应与已验证 Release 必须作为同一不可变快照共享过期时间；
// 启动更新只能复用与用户刚看到的版本信息配套的可信资产。
type systemVersionCache struct {
	response *systemVersionResponse
	release  *fetchedSystemRelease
	expires  time.Time
}

// systemBuildInfo 是前端版本弹窗展示的构建元数据；发布构建由 CI ldflags 注入。
type systemBuildInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildTime string `json:"buildTime"`
	BuildType string `json:"buildType"`
}

// systemReleaseAssetDTO 只暴露资产名称和大小；真实下载 URL 留在后端校验链路内，避免浏览器绕过校验直连。
type systemReleaseAssetDTO struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type systemReleaseInfoDTO struct {
	TagName     string                  `json:"tagName"`
	Version     string                  `json:"version"`
	Name        string                  `json:"name"`
	Body        string                  `json:"body"`
	PublishedAt string                  `json:"publishedAt"`
	HTMLURL     string                  `json:"htmlUrl"`
	Assets      []systemReleaseAssetDTO `json:"assets"`
}

// systemVersionResponse 同时表达检查结果和更新能力；前端不能从 buildType 反推部署或按钮状态。
type systemVersionResponse struct {
	CurrentVersion    string                `json:"currentVersion"`
	LatestVersion     string                `json:"latestVersion"`
	HasUpdate         bool                  `json:"hasUpdate"`
	CheckSucceeded    bool                  `json:"checkSucceeded"`
	Deployment        string                `json:"deployment"`
	UpdateMode        string                `json:"updateMode"`
	UpdateSupported   bool                  `json:"updateSupported"`
	UnsupportedReason string                `json:"unsupportedReason,omitempty"`
	ReleaseInfo       *systemReleaseInfoDTO `json:"releaseInfo"`
	Cached            bool                  `json:"cached"`
	Warning           string                `json:"warning,omitempty"`
	ErrorDetails      *upstreamErrorDetails `json:"errorDetails,omitempty"`
	Build             systemBuildInfo       `json:"build"`
}

type systemUpdateOperationErrorDTO struct {
	Code    string                `json:"code"`
	Message string                `json:"message"`
	Details *upstreamErrorDetails `json:"details,omitempty"`
}

// systemUpdateOperationDTO 是页面内更新唯一可观测状态；恢复文件会在落盘前剥离一次性上游详情。
type systemUpdateOperationDTO struct {
	ID             string                         `json:"id"`
	Status         string                         `json:"status"`
	Stage          string                         `json:"stage"`
	CurrentVersion string                         `json:"currentVersion"`
	TargetVersion  *string                        `json:"targetVersion"`
	StartedAt      string                         `json:"startedAt"`
	UpdatedAt      string                         `json:"updatedAt"`
	FinishedAt     *string                        `json:"finishedAt"`
	NeedsRestart   bool                           `json:"needsRestart"`
	Error          *systemUpdateOperationErrorDTO `json:"error"`
}

type systemUpdateOperationResponse struct {
	Operation *systemUpdateOperationDTO `json:"operation"`
}

// systemUpdateService 只维护一个更新任务；内存是运行时热状态，statePath 仅用于进程崩溃后的恢复对账。
// cacheMu 与 operationMu 分离，版本检查的上游 I/O 不得阻塞每秒一次的任务状态读取。
type systemUpdateService struct {
	client           systemReleaseClient
	now              func() time.Time
	exit             func(int)
	restartWait      time.Duration
	operationTimeout time.Duration
	capability       func(appLocale) systemUpdateCapability

	cacheMu sync.Mutex
	cache   *systemVersionCache

	operationMu  sync.RWMutex
	operation    *systemUpdateOperationDTO
	statePath    string
	shuttingDown bool

	rootCtx     context.Context
	rootCancel  context.CancelFunc
	operationWG sync.WaitGroup
}

type systemRelease struct {
	TagName     string
	Name        string
	Body        string
	PublishedAt string
	HTMLURL     string
	Assets      []systemReleaseAsset
}

type systemReleaseAsset struct {
	Name               string
	BrowserDownloadURL string
	Size               int64
}

type systemReleaseCheckError struct {
	statusCode int
	status     string
	message    string
	details    *upstreamErrorDetails
}

func (e *systemReleaseCheckError) Error() string {
	if strings.TrimSpace(e.message) == "" {
		return "GitHub Release check failed: " + e.status
	}
	return "GitHub Release check failed: " + e.status + ": " + e.message
}

type fetchedSystemRelease struct {
	dto    *systemReleaseInfoDTO
	assets []systemReleaseAsset
}

type systemUpdateCapability struct {
	deployment        string
	updateMode        string
	supported         bool
	unsupportedReason string
	binaryPath        string
	backupDir         string
}

type semanticVersion struct {
	major      int
	minor      int
	patch      int
	prerelease string
	rc         int
}

type httpSystemReleaseClient struct {
	metadataClient *http.Client
	assetClient    *http.Client
	downloader     *systemReleaseDownloader
}
