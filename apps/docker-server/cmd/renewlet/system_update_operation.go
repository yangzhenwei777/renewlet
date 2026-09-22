package main

// system_update_operation.go 负责单实例更新任务的生命周期、阶段检查点和启动恢复。
// HTTP 请求只创建或读取任务；下载、替换与重启资格都必须经这里的服务级状态机串行化。
import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const systemUpdateStateVersion = 1

type persistedSystemUpdateState struct {
	Version   int                             `json:"version"`
	Operation *persistedSystemUpdateOperation `json:"operation"`
}

// 检查点只保存崩溃对账所需的最小事实：status 可由 stage/errorCode 重建，needsRestart 是当前进程的消费租约；
// message、details 和原始上游响应既不参与恢复，也不得进入长期磁盘或日志边界。
type persistedSystemUpdateOperation struct {
	ID             string  `json:"id"`
	Stage          string  `json:"stage"`
	CurrentVersion string  `json:"currentVersion"`
	TargetVersion  *string `json:"targetVersion"`
	StartedAt      string  `json:"startedAt"`
	UpdatedAt      string  `json:"updatedAt"`
	FinishedAt     *string `json:"finishedAt"`
	ErrorCode      string  `json:"errorCode,omitempty"`
}

// InitializeState 只在进程启动时读取一次恢复检查点；正常状态查询始终读取内存，不能把轮询变成磁盘热路径。
func (service *systemUpdateService) InitializeState(dataDir string) error {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" {
		return errors.New("system update data directory is empty")
	}
	service.operationMu.Lock()
	defer service.operationMu.Unlock()
	service.statePath = filepath.Join(dataDir, systemUpdateStateDirectory, systemUpdateStateFilename)

	data, err := os.ReadFile(service.statePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		slog.Warn("system update recovery state ignored", "reason", "read_failed")
		return nil
	}
	var state persistedSystemUpdateState
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil || decoder.Decode(&struct{}{}) != io.EOF || state.Version != systemUpdateStateVersion {
		// 状态文件不是业务数据；损坏时忽略并等待下一次任务原子覆盖，不能阻断 Renewlet 启动。
		slog.Warn("system update recovery state ignored", "reason", "invalid_state")
		return nil
	}
	service.operation = systemUpdateOperationFromPersisted(state.Operation)
	if !validSystemUpdateOperation(service.operation) {
		service.operation = nil
		slog.Warn("system update recovery state ignored", "reason", "invalid_operation")
		return nil
	}
	if !service.reconcileRecoveredOperationLocked() {
		return nil
	}
	if err := service.persistOperationLocked(); err != nil {
		slog.Warn("system update recovery checkpoint failed", "reason", "write_failed")
	}
	return nil
}

func (service *systemUpdateService) StartUpdate(locale appLocale) (*systemUpdateOperationDTO, error) {
	// capability 可能检查文件系统，不能长时间占用热状态锁；锁外检查前后各确认一次 active，
	// 既让重复 POST O(1) 复用现有任务，也封住并发请求同时创建任务的窗口。
	service.operationMu.Lock()
	if service.shuttingDown {
		service.operationMu.Unlock()
		return nil, context.Canceled
	}
	if activeSystemUpdateOperation(service.operation) {
		operation := cloneSystemUpdateOperation(service.operation, true)
		service.operationMu.Unlock()
		return operation, nil
	}
	service.operationMu.Unlock()

	capability := service.capability(locale)
	if !capability.supported {
		return nil, systemUpdateError{kind: errSystemUpdateUnsupported, message: capability.unsupportedReason}
	}

	service.operationMu.Lock()
	if service.shuttingDown {
		service.operationMu.Unlock()
		return nil, context.Canceled
	}
	if activeSystemUpdateOperation(service.operation) {
		operation := cloneSystemUpdateOperation(service.operation, true)
		service.operationMu.Unlock()
		return operation, nil
	}
	id, err := newSystemUpdateOperationID()
	if err != nil {
		service.operationMu.Unlock()
		return nil, err
	}
	now := service.now().UTC().Format(time.RFC3339Nano)
	service.operation = &systemUpdateOperationDTO{
		ID:             id,
		Status:         systemUpdateStatusRunning,
		Stage:          systemUpdateStageChecking,
		CurrentVersion: Version,
		TargetVersion:  nil,
		StartedAt:      now,
		UpdatedAt:      now,
		FinishedAt:     nil,
		NeedsRestart:   false,
		Error:          nil,
	}
	if err := service.persistOperationLocked(); err != nil {
		service.operation = nil
		service.operationMu.Unlock()
		return nil, err
	}
	operation := cloneSystemUpdateOperation(service.operation, true)
	// Add 必须发生在 operationMu 内；Shutdown 先在同一把锁下封住新任务，随后 Wait，避免 Add/Wait 并发竞态。
	service.operationWG.Add(1)
	service.operationMu.Unlock()

	go service.runUpdateOperation(id, locale, capability)
	return operation, nil
}

// CurrentOperation 只复制锁内内存快照，并按请求 locale 重建安全文案；轮询路径不读取恢复文件，也不访问上游。
func (service *systemUpdateService) CurrentOperation(locale appLocale) *systemUpdateOperationDTO {
	service.operationMu.RLock()
	defer service.operationMu.RUnlock()
	operation := cloneSystemUpdateOperation(service.operation, true)
	if operation != nil && operation.Error != nil {
		operation.Error.Message = systemUpdateFailureMessageForCode(locale, operation.Error.Code)
	}
	return operation
}

func (service *systemUpdateService) runUpdateOperation(id string, locale appLocale, capability systemUpdateCapability) {
	defer service.operationWG.Done()
	// 后台任务只绑定服务级 context 与总超时；HTTP handler 返回或浏览器断开都不能取消已接受的更新。
	ctx, cancel := context.WithTimeout(service.rootCtx, service.operationTimeout)
	defer cancel()

	release := service.cachedUpdateRelease()
	_, err := service.performUpdate(ctx, locale, capability, release, func(stage string, targetVersion string) error {
		return service.advanceOperation(id, stage, targetVersion)
	})
	if err != nil {
		service.failOperation(id, locale, err)
		return
	}
	service.completeOperation(id)
}

func (service *systemUpdateService) advanceOperation(id string, stage string, targetVersion string) error {
	service.operationMu.Lock()
	defer service.operationMu.Unlock()
	if service.operation == nil || service.operation.ID != id || service.operation.Status != systemUpdateStatusRunning {
		return errors.New("system update operation is no longer active")
	}
	// 阶段只能按固定 DAG 单调前进，targetVersion 首次确认后也不可变化；恢复文件因此不需要事件日志即可可靠对账。
	if !validSystemUpdateStageTransition(service.operation.Stage, stage) {
		return fmt.Errorf("invalid system update stage transition %s -> %s", service.operation.Stage, stage)
	}
	if strings.TrimSpace(targetVersion) == "" {
		return errors.New("system update target version is empty")
	}
	if service.operation.TargetVersion != nil && *service.operation.TargetVersion != targetVersion {
		return errors.New("system update target version changed")
	}
	previousStage := service.operation.Stage
	previousUpdatedAt := service.operation.UpdatedAt
	if service.operation.TargetVersion == nil {
		target := targetVersion
		service.operation.TargetVersion = &target
	}
	service.operation.Stage = stage
	service.operation.UpdatedAt = service.now().UTC().Format(time.RFC3339Nano)
	if err := service.persistOperationLocked(); err != nil {
		return err
	}
	logSystemUpdateStage(service.operation, previousStage, previousUpdatedAt)
	return nil
}

// 二进制替换完成只进入 restart-pending；completed 必须由新进程启动后的实际版本对账产生，不能由旧进程提前宣告。
func (service *systemUpdateService) completeOperation(id string) {
	service.operationMu.Lock()
	if service.operation == nil || service.operation.ID != id || service.operation.Status != systemUpdateStatusRunning || service.operation.Stage != systemUpdateStageInstalling {
		service.operationMu.Unlock()
		return
	}
	previousStage := service.operation.Stage
	previousUpdatedAt := service.operation.UpdatedAt
	now := service.now().UTC().Format(time.RFC3339Nano)
	service.operation.Status = systemUpdateStatusSucceeded
	service.operation.Stage = systemUpdateStageRestartPending
	service.operation.UpdatedAt = now
	service.operation.FinishedAt = &now
	service.operation.NeedsRestart = true
	service.operation.Error = nil
	if err := service.persistOperationLocked(); err != nil {
		slog.Warn("system update recovery checkpoint failed", "operation", id, "stage", systemUpdateStageRestartPending)
	}
	logSystemUpdateStage(service.operation, previousStage, previousUpdatedAt)
	service.operationMu.Unlock()
	service.clearCache()
}

func (service *systemUpdateService) failOperation(id string, locale appLocale, operationErr error) {
	service.operationMu.Lock()
	defer service.operationMu.Unlock()
	if service.operation == nil || service.operation.ID != id || service.operation.Status != systemUpdateStatusRunning {
		return
	}
	previousUpdatedAt := service.operation.UpdatedAt
	now := service.now().UTC().Format(time.RFC3339Nano)
	service.operation.Status = systemUpdateStatusFailed
	service.operation.UpdatedAt = now
	service.operation.FinishedAt = &now
	service.operation.NeedsRestart = false
	service.operation.Error = &systemUpdateOperationErrorDTO{
		Code:    systemUpdateFailureCode(operationErr),
		Message: systemUpdateFailureMessage(locale, operationErr),
		// 原始上游响应只保留在当前进程的管理员快照；检查点和日志分别只取安全错误码与固定字段。
		Details: systemUpstreamErrorDetails(operationErr),
	}
	if err := service.persistOperationLocked(); err != nil {
		slog.Warn("system update recovery checkpoint failed", "operation", id, "stage", service.operation.Stage)
	}
	slog.Warn("system update operation failed",
		"operation", id,
		"stage", service.operation.Stage,
		"targetVersion", operationTargetVersion(service.operation),
		"code", service.operation.Error.Code,
		"duration", systemUpdateStageDuration(previousUpdatedAt, service.operation.UpdatedAt),
	)
}

// ReserveRestart 把“等待重启”作为内存租约消费；route 写响应失败时必须 RollbackRestart。
// 该瞬时租约故意不落盘：检查点保持 restart-pending，只有新二进制启动并完成版本对账后才进入 completed。
func (service *systemUpdateService) ReserveRestart(locale appLocale) error {
	service.operationMu.Lock()
	defer service.operationMu.Unlock()
	if !successfulRestartPendingOperation(service.operation) || !service.operation.NeedsRestart {
		return systemUpdateError{kind: errSystemRestartNotPending, message: serverText(locale, "system.restartNotPending")}
	}
	service.operation.NeedsRestart = false
	service.operation.UpdatedAt = service.now().UTC().Format(time.RFC3339Nano)
	return nil
}

func (service *systemUpdateService) RollbackRestart() {
	service.operationMu.Lock()
	defer service.operationMu.Unlock()
	if !successfulRestartPendingOperation(service.operation) || service.operation.NeedsRestart {
		return
	}
	service.operation.NeedsRestart = true
	service.operation.UpdatedAt = service.now().UTC().Format(time.RFC3339Nano)
}

func (service *systemUpdateService) Shutdown() {
	// 先在 operationMu 下拒绝新任务，再取消服务 context 并等待已有 goroutine 短暂收尾；顺序不能反转，
	// 否则 StartUpdate 可能在 Wait 已开始后执行 WaitGroup.Add。
	service.operationMu.Lock()
	service.shuttingDown = true
	service.operationMu.Unlock()
	service.rootCancel()
	done := make(chan struct{})
	go func() {
		service.operationWG.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(systemUpdateShutdownWait):
	}
}

func (service *systemUpdateService) reconcileRecoveredOperationLocked() bool {
	operation := service.operation
	if operation == nil {
		return false
	}
	// 恢复只相信当前实际运行的二进制版本：命中 target 说明替换和容器重启已经成功；否则旧进程留下的
	// running/restart-pending 只能判定为中断，不能冒险续跑下载或安装。与当前版本无关的历史终态直接丢弃。
	if operation.TargetVersion != nil && *operation.TargetVersion == Version {
		now := service.now().UTC().Format(time.RFC3339Nano)
		operation.Status = systemUpdateStatusSucceeded
		operation.Stage = systemUpdateStageCompleted
		operation.UpdatedAt = now
		operation.FinishedAt = &now
		operation.NeedsRestart = false
		operation.Error = nil
		return true
	}
	if operation.Status == systemUpdateStatusRunning || operation.Stage == systemUpdateStageRestartPending {
		now := service.now().UTC().Format(time.RFC3339Nano)
		operation.Status = systemUpdateStatusFailed
		operation.UpdatedAt = now
		operation.FinishedAt = &now
		operation.NeedsRestart = false
		operation.Error = &systemUpdateOperationErrorDTO{
			Code:    "SYSTEM_UPDATE_INTERRUPTED",
			Message: serverText(defaultAppLocale, "system.updateFailed"),
		}
		return true
	}
	if operation.CurrentVersion != Version {
		service.operation = nil
		return true
	}
	return false
}

func (service *systemUpdateService) persistOperationLocked() error {
	if service.statePath == "" {
		return nil
	}
	directory := filepath.Dir(service.statePath)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create system update state directory: %w", err)
	}
	temp, err := os.CreateTemp(directory, ".system-update-*.tmp")
	if err != nil {
		return fmt.Errorf("create system update state file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	// 检查点只在阶段转换时以 0600 + fsync + rename 发布；转换函数会剥离 message、raw response 和请求信息。
	state := persistedSystemUpdateState{
		Version:   systemUpdateStateVersion,
		Operation: persistedSystemUpdateOperationFromDTO(service.operation),
	}
	if err := json.NewEncoder(temp).Encode(state); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, service.statePath); err != nil {
		return err
	}
	return syncSystemUpdateDirectory(directory)
}

func syncSystemUpdateDirectory(directory string) error {
	dir, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func activeSystemUpdateOperation(operation *systemUpdateOperationDTO) bool {
	return operation != nil && (operation.Status == systemUpdateStatusRunning || successfulRestartPendingOperation(operation))
}

func successfulRestartPendingOperation(operation *systemUpdateOperationDTO) bool {
	return operation != nil && operation.Status == systemUpdateStatusSucceeded && operation.Stage == systemUpdateStageRestartPending
}

// 恢复文件属于不可信输入；组合状态必须先完整验证，不能把畸形 stage/status 载入内存热路径。
func validSystemUpdateOperation(operation *systemUpdateOperationDTO) bool {
	if operation == nil {
		return true
	}
	if strings.TrimSpace(operation.ID) == "" || strings.TrimSpace(operation.CurrentVersion) == "" {
		return false
	}
	if strings.TrimSpace(operation.StartedAt) == "" || strings.TrimSpace(operation.UpdatedAt) == "" {
		return false
	}
	if _, err := time.Parse(time.RFC3339Nano, operation.StartedAt); err != nil {
		return false
	}
	if _, err := time.Parse(time.RFC3339Nano, operation.UpdatedAt); err != nil {
		return false
	}
	if operation.FinishedAt != nil {
		if _, err := time.Parse(time.RFC3339Nano, *operation.FinishedAt); err != nil {
			return false
		}
	}
	if !validSystemUpdateStage(operation.Stage) {
		return false
	}
	if operation.TargetVersion == nil && operation.Stage != systemUpdateStageChecking {
		return false
	}
	switch operation.Status {
	case systemUpdateStatusRunning:
		return operation.Stage != systemUpdateStageRestartPending &&
			operation.Stage != systemUpdateStageCompleted &&
			operation.FinishedAt == nil &&
			!operation.NeedsRestart &&
			operation.Error == nil
	case systemUpdateStatusSucceeded:
		return (operation.Stage == systemUpdateStageRestartPending || operation.Stage == systemUpdateStageCompleted) &&
			(operation.Stage != systemUpdateStageCompleted || !operation.NeedsRestart) &&
			operation.FinishedAt != nil &&
			operation.Error == nil
	case systemUpdateStatusFailed:
		return operation.Stage != systemUpdateStageCompleted &&
			operation.FinishedAt != nil &&
			!operation.NeedsRestart &&
			operation.Error != nil &&
			strings.TrimSpace(operation.Error.Code) != "" &&
			strings.TrimSpace(operation.Error.Message) != ""
	default:
		return false
	}
}

func validSystemUpdateStage(stage string) bool {
	switch stage {
	case systemUpdateStageChecking,
		systemUpdateStageDownloading,
		systemUpdateStageVerifying,
		systemUpdateStageInstalling,
		systemUpdateStageRestartPending,
		systemUpdateStageCompleted:
		return true
	default:
		return false
	}
}

func validSystemUpdateStageTransition(current string, next string) bool {
	return (current == systemUpdateStageChecking && next == systemUpdateStageDownloading) ||
		(current == systemUpdateStageDownloading && next == systemUpdateStageVerifying) ||
		(current == systemUpdateStageVerifying && next == systemUpdateStageInstalling)
}

func persistedSystemUpdateOperationFromDTO(operation *systemUpdateOperationDTO) *persistedSystemUpdateOperation {
	if operation == nil {
		return nil
	}
	persisted := &persistedSystemUpdateOperation{
		ID:             operation.ID,
		Stage:          operation.Stage,
		CurrentVersion: operation.CurrentVersion,
		TargetVersion:  cloneStringPointer(operation.TargetVersion),
		StartedAt:      operation.StartedAt,
		UpdatedAt:      operation.UpdatedAt,
		FinishedAt:     cloneStringPointer(operation.FinishedAt),
	}
	if operation.Error != nil {
		persisted.ErrorCode = operation.Error.Code
	}
	return persisted
}

// status/needsRestart 从最小检查点派生，避免把运行时控制位复制成第二套可漂移事实；错误文案按当前 locale 在读取快照时重建。
func systemUpdateOperationFromPersisted(persisted *persistedSystemUpdateOperation) *systemUpdateOperationDTO {
	if persisted == nil {
		return nil
	}
	operation := &systemUpdateOperationDTO{
		ID:             persisted.ID,
		Status:         systemUpdateStatusRunning,
		Stage:          persisted.Stage,
		CurrentVersion: persisted.CurrentVersion,
		TargetVersion:  cloneStringPointer(persisted.TargetVersion),
		StartedAt:      persisted.StartedAt,
		UpdatedAt:      persisted.UpdatedAt,
		FinishedAt:     cloneStringPointer(persisted.FinishedAt),
		NeedsRestart:   false,
	}
	if persisted.ErrorCode != "" {
		operation.Status = systemUpdateStatusFailed
		operation.Error = &systemUpdateOperationErrorDTO{
			Code:    persisted.ErrorCode,
			Message: serverText(defaultAppLocale, "system.updateFailed"),
		}
	} else if persisted.Stage == systemUpdateStageRestartPending {
		operation.Status = systemUpdateStatusSucceeded
		operation.NeedsRestart = true
	} else if persisted.Stage == systemUpdateStageCompleted {
		operation.Status = systemUpdateStatusSucceeded
	}
	return operation
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}

func cloneSystemUpdateOperation(operation *systemUpdateOperationDTO, includeDetails bool) *systemUpdateOperationDTO {
	if operation == nil {
		return nil
	}
	clone := *operation
	if operation.TargetVersion != nil {
		target := *operation.TargetVersion
		clone.TargetVersion = &target
	}
	if operation.FinishedAt != nil {
		finished := *operation.FinishedAt
		clone.FinishedAt = &finished
	}
	if operation.Error != nil {
		errorClone := *operation.Error
		if includeDetails && operation.Error.Details != nil {
			details := *operation.Error.Details
			if operation.Error.Details.RawResponseText != nil {
				raw := *operation.Error.Details.RawResponseText
				details.RawResponseText = &raw
			}
			errorClone.Details = &details
		} else {
			errorClone.Details = nil
		}
		clone.Error = &errorClone
	}
	return &clone
}

func newSystemUpdateOperationID() (string, error) {
	bytes := make([]byte, 12)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func systemUpdateFailureCode(err error) string {
	switch {
	case errors.Is(err, errSystemUpdateNoUpdate):
		return "SYSTEM_UPDATE_NO_UPDATE"
	// 下载无进展由上游错误包装记录，不一定保留 context.DeadlineExceeded；两条路径必须收敛到同一稳定错误码。
	case errors.Is(err, context.DeadlineExceeded), upstreamOperationTimedOut(err):
		return "SYSTEM_UPDATE_TIMEOUT"
	case errors.Is(err, context.Canceled):
		return "SYSTEM_UPDATE_INTERRUPTED"
	default:
		return "SYSTEM_UPDATE_FAILED"
	}
}

func systemUpdateFailureMessage(locale appLocale, err error) string {
	return systemUpdateFailureMessageForCode(locale, systemUpdateFailureCode(err))
}

func systemUpdateFailureMessageForCode(locale appLocale, code string) string {
	switch code {
	case "SYSTEM_UPDATE_NO_UPDATE":
		return serverText(locale, "system.alreadyLatest")
	case "SYSTEM_UPDATE_TIMEOUT":
		return serverText(locale, "system.updateTimedOut")
	case "SYSTEM_UPDATE_INTERRUPTED":
		return serverText(locale, "system.updateInterrupted")
	default:
		return serverText(locale, "system.updateFailed")
	}
}

func operationTargetVersion(operation *systemUpdateOperationDTO) string {
	if operation == nil || operation.TargetVersion == nil {
		return ""
	}
	return *operation.TargetVersion
}

func logSystemUpdateStage(operation *systemUpdateOperationDTO, previousStage string, previousUpdatedAt string) {
	if operation == nil {
		return
	}
	slog.Info("system update stage completed",
		"operation", operation.ID,
		"stage", previousStage,
		"nextStage", operation.Stage,
		"targetVersion", operationTargetVersion(operation),
		"duration", systemUpdateStageDuration(previousUpdatedAt, operation.UpdatedAt),
	)
}

func systemUpdateStageDuration(startedAt string, updatedAt string) time.Duration {
	started, startErr := time.Parse(time.RFC3339Nano, startedAt)
	updated, updateErr := time.Parse(time.RFC3339Nano, updatedAt)
	if startErr != nil || updateErr != nil {
		return 0
	}
	return updated.Sub(started)
}
