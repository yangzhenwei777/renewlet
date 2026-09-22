package main

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func ensureAPITokensCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "api_tokens", func(c *core.Collection) error {
		// API token hash 虽不是明文 secret，也不应经 PocketBase REST 暴露；只允许自定义管理 API 脱敏读写。
		c.ListRule = nil
		c.ViewRule = nil
		c.CreateRule = nil
		c.UpdateRule = nil
		c.DeleteRule = nil
		fields := []core.Field{
			userRelation(users),
			&core.TextField{Name: "name", Required: true, Max: 80},
			&core.TextField{Name: "tokenHash", Required: true, Max: 128, Pattern: `^[A-Za-z0-9_-]{43}$`},
			&core.TextField{Name: "tokenPrefix", Required: true, Max: 16, Pattern: `^rlt_[A-Za-z0-9_-]{2,12}$`},
			&core.JSONField{Name: "scopes", MaxSize: 2048},
			&core.TextField{Name: "lastUsedAt", Max: 40},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		c.Fields.RemoveByName("revokedAt")
		if err := ensureAutodates(c); err != nil {
			return err
		}
		removeIndex(c, "idx_api_tokens_user_revoked")
		c.AddIndex("idx_api_tokens_user_created", false, "user, created", "")
		c.AddIndex("idx_api_tokens_token_hash_unique", true, "tokenHash", "")
		return nil
	})
}

func ensureTelegramBotBindingsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "telegram_bot_bindings", func(c *core.Collection) error {
		// Bot token hash 和 webhook secret hash 都是鉴权材料索引；binding 只能经自定义 API 脱敏访问。
		c.ListRule = nil
		c.ViewRule = nil
		c.CreateRule = nil
		c.UpdateRule = nil
		c.DeleteRule = nil
		fields := []core.Field{
			userRelation(users),
			&core.TextField{Name: "chatId", Required: true, Max: 128},
			&core.TextField{Name: "botTokenHash", Required: true, Max: 128, Pattern: `^[A-Za-z0-9_-]{43}$`},
			&core.TextField{Name: "webhookSecretHash", Required: true, Max: 128, Pattern: `^[A-Za-z0-9_-]{43}$`},
			&core.SelectField{Name: "status", Required: true, Values: []string{"installing", "installed"}},
			&core.NumberField{Name: "lastUpdateId", OnlyInt: true, Min: types.Pointer(0.0)},
			&core.TextField{Name: "lastUsedAt", Max: 40},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.Fields.RemoveByName("commandsVersion")
		c.AddIndex("idx_telegram_bot_bindings_user_unique", true, "user", "")
		c.AddIndex("idx_telegram_bot_bindings_webhook_secret", false, "webhookSecretHash", "")
		return nil
	})
}
