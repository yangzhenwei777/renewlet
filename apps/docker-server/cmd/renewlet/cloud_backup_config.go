package main

// cloud_backup_config.go 负责云备份目标配置的读写归一。
//
// 架构位置：
//   - cloud_backup_targets 以 user+provider 作为唯一事实源，WebDAV/S3 互不覆盖。
//   - 凭据字段是 write-only；API 响应只暴露 credentialSet 状态。
//   - 定时策略和最近状态按 provider 独立保存，不能因切换 tab 清空另一个目标。
import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// saveCloudBackupConfig 只保存当前 provider 的配置行，并在写入后返回完整双 provider 状态。
func saveCloudBackupConfig(app core.App, userID string, body cloudBackupConfigUpdateRequest) (cloudBackupResolvedConfig, error) {
	current, err := readCloudBackupTarget(app, userID, body.Provider)
	if err != nil {
		return cloudBackupResolvedConfig{}, err
	}
	record := current.Record
	if record == nil {
		collection, err := app.FindCollectionByNameOrId("cloud_backup_targets")
		if err != nil {
			return cloudBackupResolvedConfig{}, err
		}
		record = core.NewRecord(collection)
		record.Set("user", userID)
		record.Set("provider", body.Provider)
	}
	// cloud_backup_targets 的唯一事实是 user+provider；保存当前 tab 只能写当前行，不能重建另一 provider。
	target := targetFromCloudBackupUpdate(userID, body, current)
	record.Set("provider", target.Provider)
	record.Set("config", cloudBackupStoredConfig{WebDAV: target.WebDAV, S3: target.S3})
	record.Set("credential", target.Credential)
	record.Set("scheduleEnabled", target.Policy.ScheduleEnabled)
	record.Set("scheduleFrequency", target.Policy.ScheduleFrequency)
	record.Set("scheduleTime", target.Policy.ScheduleTime)
	record.Set("scheduleWeekday", target.Policy.ScheduleWeekday)
	record.Set("retention", target.Policy.Retention)
	if record.GetString("lastStatus") == "" {
		record.Set("lastStatus", cloudBackupStatusIdle)
	}
	if err := app.Save(record); err != nil {
		return cloudBackupResolvedConfig{}, err
	}
	return readCloudBackupConfig(app, userID)
}

// targetFromCloudBackupUpdate 合并当前 provider 的非密配置、write-only 凭据和调度策略。
// 注意：空凭据表示“沿用旧值”，不是清空 secret；清空语义需要单独设计显式字段。
func targetFromCloudBackupUpdate(userID string, body cloudBackupConfigUpdateRequest, current cloudBackupResolvedTarget) cloudBackupResolvedTarget {
	credential := current.Credential
	if body.Credentials != nil {
		// 云存储密钥是 write-only 字段；provider 行是本次写入边界，避免一个 tab 的保存夹带覆盖另一目标。
		if body.Provider == cloudBackupProviderWebDAV && body.Credentials.WebDAVPassword != nil && strings.TrimSpace(*body.Credentials.WebDAVPassword) != "" {
			credential.WebDAVPassword = *body.Credentials.WebDAVPassword
		}
		if body.Provider == cloudBackupProviderS3 && body.Credentials.S3SecretAccessKey != nil && strings.TrimSpace(*body.Credentials.S3SecretAccessKey) != "" {
			credential.S3SecretAccessKey = *body.Credentials.S3SecretAccessKey
		}
	}
	webdav := current.WebDAV
	s3 := current.S3
	if body.Provider == cloudBackupProviderWebDAV && body.WebDAV != nil {
		webdav = body.WebDAV
	}
	if body.Provider == cloudBackupProviderS3 && body.S3 != nil {
		s3 = body.S3
	}
	policy := body.Policy
	_ = policy.NormalizeAndValidate(defaultAppLocale)
	return cloudBackupResolvedTarget{
		Record:       current.Record,
		UserID:       userID,
		Provider:     body.Provider,
		WebDAV:       webdav,
		S3:           s3,
		Credential:   credential,
		Policy:       policy,
		LastBackupAt: current.LastBackupAt,
		LastStatus:   current.LastStatus,
		LastError:    current.LastError,
		LockedUntil:  current.LockedUntil,
		UpdatedAt:    current.UpdatedAt,
	}
}

func readCloudBackupConfig(app core.App, userID string) (cloudBackupResolvedConfig, error) {
	config := defaultCloudBackupResolvedConfig(userID)
	rows, err := app.FindRecordsByFilter("cloud_backup_targets", "user = {:user}", "-updated", 20, 0, dbx.Params{"user": userID})
	if err != nil {
		return config, err
	}
	for _, record := range rows {
		target := cloudBackupTargetFromRecord(userID, record)
		config.Targets[target.Provider] = target
		if config.UpdatedAt == "" || target.UpdatedAt > config.UpdatedAt {
			config.UpdatedAt = target.UpdatedAt
			config.Provider = target.Provider
		}
	}
	return config, nil
}

// readCloudBackupTarget 按 user+provider 读取单个目标；不存在时返回默认行，避免读取操作制造隐式写入。
func readCloudBackupTarget(app core.App, userID string, provider string) (cloudBackupResolvedTarget, error) {
	target := defaultCloudBackupTarget(userID, provider)
	record, err := app.FindFirstRecordByFilter("cloud_backup_targets", "user = {:user} && provider = {:provider}", dbx.Params{"user": userID, "provider": provider})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return target, nil
		}
		return target, err
	}
	return cloudBackupTargetFromRecord(userID, record), nil
}

// cloudBackupTargetFromRecord 把 PocketBase record 还原为运行时配置。
// 脏 JSON 只在当前字段回落默认值，不能让一个 provider 的坏配置拖垮整个设置页。
func cloudBackupTargetFromRecord(userID string, record *core.Record) cloudBackupResolvedTarget {
	provider := strings.TrimSpace(record.GetString("provider"))
	target := defaultCloudBackupTarget(userID, provider)
	target.Record = record
	var stored cloudBackupStoredConfig
	if data, err := jsonBytesFromValue(record.Get("config")); err == nil && len(bytes.TrimSpace(data)) > 0 {
		_ = json.Unmarshal(data, &stored)
	}
	target.WebDAV = stored.WebDAV
	target.S3 = stored.S3
	if target.WebDAV != nil {
		_ = target.WebDAV.NormalizeAndValidate()
	}
	if target.S3 != nil {
		_ = target.S3.NormalizeAndValidate()
	}
	if data, err := jsonBytesFromValue(record.Get("credential")); err == nil && len(bytes.TrimSpace(data)) > 0 {
		_ = json.Unmarshal(data, &target.Credential)
	}
	target.Policy = cloudBackupPolicy{
		ScheduleEnabled:   record.GetBool("scheduleEnabled"),
		ScheduleFrequency: strings.TrimSpace(record.GetString("scheduleFrequency")),
		ScheduleTime:      strings.TrimSpace(record.GetString("scheduleTime")),
		ScheduleWeekday:   strings.TrimSpace(record.GetString("scheduleWeekday")),
		Retention:         record.GetInt("retention"),
	}
	_ = target.Policy.NormalizeAndValidate(defaultAppLocale)
	target.LastBackupAt = strings.TrimSpace(record.GetString("lastBackupAt"))
	target.LastStatus = strings.TrimSpace(record.GetString("lastStatus"))
	if target.LastStatus == "" {
		target.LastStatus = cloudBackupStatusIdle
	}
	target.LastError = strings.TrimSpace(record.GetString("lastError"))
	target.LockedUntil = strings.TrimSpace(record.GetString("lockedUntil"))
	if !record.GetDateTime("updated").IsZero() {
		target.UpdatedAt = record.GetDateTime("updated").Time().UTC().Format(time.RFC3339Nano)
	}
	return target
}

func defaultCloudBackupResolvedConfig(userID string) cloudBackupResolvedConfig {
	return cloudBackupResolvedConfig{
		UserID:   userID,
		Provider: cloudBackupProviderWebDAV,
		Targets:  map[string]cloudBackupResolvedTarget{},
	}
}

func defaultCloudBackupTarget(userID string, provider string) cloudBackupResolvedTarget {
	if provider != cloudBackupProviderWebDAV && provider != cloudBackupProviderS3 {
		provider = cloudBackupProviderWebDAV
	}
	return cloudBackupResolvedTarget{
		UserID:     userID,
		Provider:   provider,
		Policy:     defaultCloudBackupPolicy(),
		LastStatus: cloudBackupStatusIdle,
	}
}

func defaultCloudBackupPolicy() cloudBackupPolicy {
	return cloudBackupPolicy{
		ScheduleFrequency: "daily",
		ScheduleTime:      cloudBackupDefaultScheduleTime,
		ScheduleWeekday:   cloudBackupDefaultScheduleWeekday,
		Retention:         cloudBackupDefaultRetention,
	}
}

func (config cloudBackupResolvedConfig) DTO() cloudBackupConfigDTO {
	return cloudBackupConfigDTO{
		Provider:                config.Provider,
		WebDAV:                  config.WebDAV(),
		S3:                      config.S3(),
		CredentialSet:           config.CredentialSet(),
		CredentialSetByProvider: config.CredentialSetByProvider(),
		PolicyByProvider:        config.PolicyByProvider(),
		StatusByProvider:        config.StatusByProvider(),
		UpdatedAt:               optionalStringPtr(config.UpdatedAt),
	}
}

func (config cloudBackupResolvedConfig) WebDAV() *cloudBackupWebDAVSettings {
	if target, ok := config.Targets[cloudBackupProviderWebDAV]; ok {
		return target.WebDAV
	}
	return nil
}

func (config cloudBackupResolvedConfig) S3() *cloudBackupS3Settings {
	if target, ok := config.Targets[cloudBackupProviderS3]; ok {
		return target.S3
	}
	return nil
}

func (config cloudBackupResolvedConfig) CredentialSet() bool {
	if target, ok := config.Targets[config.Provider]; ok {
		return target.CredentialSet()
	}
	return false
}

func (config cloudBackupResolvedConfig) CredentialSetByProvider() cloudBackupCredentialState {
	return cloudBackupCredentialState{
		WebDAV: config.Targets[cloudBackupProviderWebDAV].CredentialSet(),
		S3:     config.Targets[cloudBackupProviderS3].CredentialSet(),
	}
}

func (config cloudBackupResolvedConfig) PolicyByProvider() cloudBackupPolicyState {
	return cloudBackupPolicyState{
		WebDAV: config.policyForProvider(cloudBackupProviderWebDAV),
		S3:     config.policyForProvider(cloudBackupProviderS3),
	}
}

func (config cloudBackupResolvedConfig) StatusByProvider() cloudBackupStatusState {
	return cloudBackupStatusState{
		WebDAV: config.statusForProvider(cloudBackupProviderWebDAV),
		S3:     config.statusForProvider(cloudBackupProviderS3),
	}
}

func (config cloudBackupResolvedConfig) policyForProvider(provider string) cloudBackupPolicy {
	if target, ok := config.Targets[provider]; ok {
		return target.Policy
	}
	return defaultCloudBackupPolicy()
}

func (config cloudBackupResolvedConfig) statusForProvider(provider string) cloudBackupTargetStatus {
	if target, ok := config.Targets[provider]; ok {
		return target.StatusDTO()
	}
	return defaultCloudBackupTarget("", provider).StatusDTO()
}

func (target cloudBackupResolvedTarget) CredentialSet() bool {
	switch target.Provider {
	case cloudBackupProviderWebDAV:
		return strings.TrimSpace(target.Credential.WebDAVPassword) != ""
	case cloudBackupProviderS3:
		return strings.TrimSpace(target.Credential.S3SecretAccessKey) != ""
	default:
		return false
	}
}

func (target cloudBackupResolvedTarget) StatusDTO() cloudBackupTargetStatus {
	return cloudBackupTargetStatus{
		LastBackupAt: optionalStringPtr(target.LastBackupAt),
		LastStatus:   nonEmptyCloudBackupStatus(target.LastStatus),
		LastError:    optionalStringPtr(target.LastError),
		UpdatedAt:    optionalStringPtr(target.UpdatedAt),
	}
}

func nonEmptyCloudBackupStatus(value string) string {
	value = strings.TrimSpace(value)
	if value == cloudBackupStatusSuccess || value == cloudBackupStatusFailed {
		return value
	}
	return cloudBackupStatusIdle
}

func validCloudBackupWeekday(value string) bool {
	switch value {
	case "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday":
		return true
	default:
		return false
	}
}

func optionalStringPtr(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
