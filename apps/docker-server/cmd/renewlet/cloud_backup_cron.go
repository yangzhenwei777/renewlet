package main

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

const (
	cloudBackupCronPageSize = 200
	cloudBackupLockDuration = 15 * time.Minute
)

var cloudBackupCronMu sync.Mutex

func registerCloudBackupCron(app core.App) error {
	if !envBool("CLOUD_BACKUP_SCHEDULER_ENABLED", true) {
		return nil
	}
	expr := envString("CLOUD_BACKUP_SCHEDULER_CRON", "* * * * *")
	return app.Cron().Add("renewlet_cloud_backups", expr, func() {
		if !cloudBackupCronMu.TryLock() {
			// 自动云备份包含远端上传；慢网络下跳过重入，避免同一用户并发写出多个等价快照。
			slog.Info("cloud backup scheduler skipped overlapping tick")
			return
		}
		defer cloudBackupCronMu.Unlock()
		if err := runDueCloudBackups(app, time.Now().UTC()); err != nil {
			slog.Error("cloud backup scheduler failed", "error", err)
		}
	})
}

func runDueCloudBackups(app core.App, now time.Time) error {
	type dueGroup struct {
		user    *core.Record
		targets []cloudBackupTarget
	}
	groups := map[string]dueGroup{}
	for offset := 0; ; offset += cloudBackupCronPageSize {
		rows, err := app.FindRecordsByFilter(
			"cloud_backup_targets",
			"scheduleEnabled = true",
			"updated",
			cloudBackupCronPageSize,
			offset,
		)
		if err != nil {
			return err
		}
		for _, row := range rows {
			userID := row.GetString("user")
			target := cloudBackupTargetFromRecord(userID, row)
			user, err := app.FindRecordById("users", userID)
			if err != nil || user.GetBool("banned") {
				markCloudBackupStatus(app, userID, target.Provider, cloudBackupStatusFailed, "CLOUD_BACKUP_USER_UNAVAILABLE")
				continue
			}
			if demoModePolicy.IsUserRecord(user) {
				// UI 已禁止 demo 配置云备份；cron 仍要防历史残留配置被后台 tick 上传到真实远端。
				continue
			}
			settings, err := currentUserSettings(app, user)
			if err != nil {
				settings = defaultAppSettings()
			}
			if !cloudBackupTargetDue(target, settings.Timezone, now) {
				continue
			}
			if !tryAcquireCloudBackupLock(app, row, now) {
				continue
			}
			// 锁和状态都挂在 provider 行上；同一用户 WebDAV/S3 可分别到期，失败也只污染自己的 lastError。
			client, err := cloudBackupRemoteClientForTarget(target)
			if err != nil {
				markCloudBackupStatus(app, userID, target.Provider, cloudBackupStatusFailed, err.Error())
				continue
			}
			group := groups[userID]
			group.user = user
			group.targets = append(group.targets, cloudBackupTarget{Provider: target.Provider, Client: client, Retention: target.Policy.Retention})
			groups[userID] = group
		}
		if len(rows) < cloudBackupCronPageSize {
			break
		}
	}
	for userID, group := range groups {
		if len(group.targets) == 0 || group.user == nil {
			continue
		}
		// 同一用户同一轮可能有多个 provider 到期；只生成一次 ZIP，随后按 provider 独立上传和落状态。
		payload, err := buildCloudBackupSnapshotPayload(app, group.user)
		if err != nil {
			for _, target := range group.targets {
				markCloudBackupStatus(app, userID, target.Provider, cloudBackupStatusFailed, persistedCloudBackupErrorMessage(err))
			}
			continue
		}
		_ = withCloudBackupSnapshotPayload(userID, payload, func(payload cloudBackupSnapshotPayload) error {
			for _, target := range group.targets {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				_, err := uploadCloudBackupSnapshotToTarget(ctx, app, userID, payload, target)
				cancel()
				if err != nil {
					markCloudBackupStatus(app, userID, target.Provider, cloudBackupStatusFailed, persistedCloudBackupErrorMessage(err))
				}
			}
			return nil
		})
	}
	return nil
}

func cloudBackupTargetDue(target cloudBackupResolvedTarget, timezone string, now time.Time) bool {
	if !target.Policy.ScheduleEnabled {
		return false
	}
	scheduledAt := latestCloudBackupScheduledInstant(now, timezone, target.Policy)
	if scheduledAt.IsZero() || scheduledAt.After(now) {
		return false
	}
	lastBackupAt, err := parseCloudBackupInstant(target.LastBackupAt)
	if err != nil {
		return true
	}
	return lastBackupAt.Before(scheduledAt)
}

func latestCloudBackupScheduledInstant(now time.Time, timezone string, policy cloudBackupPolicy) time.Time {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		// 云备份定时依赖用户 IANA timezone；设置缺失或非法时回退 UTC，避免任务永久失效。
		loc = time.UTC
		timezone = "UTC"
	}
	if err := policy.NormalizeAndValidate(defaultAppLocale); err != nil {
		policy = defaultCloudBackupPolicy()
	}
	localNow := now.In(loc)
	localDate := localNow.Format("2006-01-02")
	if policy.ScheduleFrequency == "weekly" {
		targetWeekday := cloudBackupWeekday(policy.ScheduleWeekday)
		daysBack := (int(localNow.Weekday()) - int(targetWeekday) + 7) % 7
		localDate = localNow.AddDate(0, 0, -daysBack).Format("2006-01-02")
	}
	instant, err := getScheduleInstant(localDate, policy.ScheduleTime, timezone)
	if err != nil {
		return time.Time{}
	}
	if instant.After(now) {
		if policy.ScheduleFrequency == "weekly" {
			instant, _ = getScheduleInstant(localNow.AddDate(0, 0, -7).Format("2006-01-02"), policy.ScheduleTime, timezone)
		} else {
			instant, _ = getScheduleInstant(localNow.AddDate(0, 0, -1).Format("2006-01-02"), policy.ScheduleTime, timezone)
		}
	}
	return instant
}

func cloudBackupWeekday(value string) time.Weekday {
	switch value {
	case "sunday":
		return time.Sunday
	case "tuesday":
		return time.Tuesday
	case "wednesday":
		return time.Wednesday
	case "thursday":
		return time.Thursday
	case "friday":
		return time.Friday
	case "saturday":
		return time.Saturday
	default:
		return time.Monday
	}
}

func parseCloudBackupInstant(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err == nil {
		return parsed, nil
	}
	return time.Parse(time.RFC3339, value)
}

func tryAcquireCloudBackupLock(app core.App, record *core.Record, now time.Time) bool {
	if lockedUntil := strings.TrimSpace(record.GetString("lockedUntil")); lockedUntil != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, lockedUntil); err == nil && parsed.After(now) {
			return false
		}
	}
	record.Set("lockedUntil", now.Add(cloudBackupLockDuration).Format(time.RFC3339Nano))
	if err := app.Save(record); err != nil {
		slog.Warn("cloud backup lock update failed", "user", record.GetString("user"), "error", err)
		return false
	}
	return true
}
