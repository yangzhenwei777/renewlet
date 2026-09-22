package main

import (
	"net/mail"
	"os"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

func configureAppSettings(app core.App) error {
	settings := app.Settings()
	changed := false
	if setStringIfChanged(&settings.Meta.AppName, envString("APP_NAME", "Renewlet")) {
		changed = true
	}
	if appURL := strings.TrimSpace(os.Getenv("APP_URL")); appURL != "" {
		if setStringIfChanged(&settings.Meta.AppURL, appURL) {
			changed = true
		}
	}

	if from := strings.TrimSpace(os.Getenv("SMTP_FROM")); from != "" {
		if address, err := mail.ParseAddress(from); err == nil {
			if address.Name != "" {
				if setStringIfChanged(&settings.Meta.SenderName, address.Name) {
					changed = true
				}
			}
			if setStringIfChanged(&settings.Meta.SenderAddress, address.Address) {
				changed = true
			}
		}
	}

	if smtpHost := strings.TrimSpace(os.Getenv("SMTP_HOST")); smtpHost != "" {
		if !settings.SMTP.Enabled {
			settings.SMTP.Enabled = true
			changed = true
		}
		if setStringIfChanged(&settings.SMTP.Host, smtpHost) {
			changed = true
		}
		if port := envInt("SMTP_PORT", 587); settings.SMTP.Port != port {
			settings.SMTP.Port = port
			changed = true
		}
		if setStringIfChanged(&settings.SMTP.Username, strings.TrimSpace(os.Getenv("SMTP_USER"))) {
			changed = true
		}
		if setStringIfChanged(&settings.SMTP.Password, os.Getenv("SMTP_PASSWORD")) {
			changed = true
		}
		if tls := envBool("SMTP_TLS", envBool("SMTP_SECURE", false)); settings.SMTP.TLS != tls {
			settings.SMTP.TLS = tls
			changed = true
		}
		authMethod := strings.TrimSpace(os.Getenv("SMTP_AUTH_METHOD"))
		if authMethod == "" {
			authMethod = "PLAIN"
		}
		if setStringIfChanged(&settings.SMTP.AuthMethod, authMethod) {
			changed = true
		}
	}

	if !settings.RateLimits.Enabled {
		settings.RateLimits.Enabled = true
		changed = true
	}

	if backupCron := strings.TrimSpace(os.Getenv("BACKUPS_CRON")); backupCron != "" {
		if setStringIfChanged(&settings.Backups.Cron, backupCron) {
			changed = true
		}
		if keep := envInt("BACKUPS_CRON_MAX_KEEP", 3); settings.Backups.CronMaxKeep != keep {
			settings.Backups.CronMaxKeep = keep
			changed = true
		}
	}

	if !changed {
		return nil
	}
	return app.Save(settings)
}

func setStringIfChanged(target *string, value string) bool {
	if *target == value {
		return false
	}
	*target = value
	return true
}
