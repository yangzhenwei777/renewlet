package main

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func ensureAuthMFACollections(app core.App, users *core.Collection) error {
	if err := ensureAppSessionsCollection(app, users); err != nil {
		return err
	}
	if err := ensureMFATOTPCredentialsCollection(app, users); err != nil {
		return err
	}
	if err := ensureMFARecoveryCodesCollection(app, users); err != nil {
		return err
	}
	if err := ensureMFAAuthTicketsCollection(app, users); err != nil {
		return err
	}
	if err := ensurePasskeyCredentialsCollection(app, users); err != nil {
		return err
	}
	return ensurePasskeyChallengesCollection(app, users)
}

func secretCollectionRules(c *core.Collection) {
	// 认证与 MFA collection 保存 token hash、恢复码 hash 或加密 seed，只允许产品 route 访问。
	c.ListRule = nil
	c.ViewRule = nil
	c.CreateRule = nil
	c.UpdateRule = nil
	c.DeleteRule = nil
}

func ensureAppSessionsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "app_sessions", func(c *core.Collection) error {
		secretCollectionRules(c)
		fields := []core.Field{
			userRelation(users),
			&core.TextField{Name: "tokenHash", Required: true, Max: 128, Pattern: `^[A-Za-z0-9_-]{43}$`},
			// csrfTokenHash 只校验 unsafe 请求的同站脚本证明；真实登录态仍只看 HttpOnly session token hash。
			&core.TextField{Name: "csrfTokenHash", Max: 128, Pattern: `^$|^[A-Za-z0-9_-]{43}$`},
			&core.TextField{Name: "expiresAt", Required: true, Max: 40},
			&core.TextField{Name: "lastSeenAt", Required: true, Max: 40},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_app_sessions_token_hash_unique", true, "tokenHash", "")
		c.AddIndex("idx_app_sessions_csrf_hash", false, "csrfTokenHash", "")
		c.AddIndex("idx_app_sessions_user", false, "user", "")
		c.AddIndex("idx_app_sessions_expires", false, "expiresAt", "")
		return nil
	})
}

func ensureMFATOTPCredentialsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "mfa_totp_credentials", func(c *core.Collection) error {
		secretCollectionRules(c)
		fields := []core.Field{
			userRelation(users),
			// TOTP seed 加密保存；验证只解密到内存，不进入导出、日志或普通 settings。
			&core.TextField{Name: "secretCiphertext", Required: true, Max: 4096},
			&core.NumberField{Name: "lastAcceptedStep", OnlyInt: true},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_mfa_totp_user_unique", true, "user", "")
		return nil
	})
}

func ensureMFARecoveryCodesCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "mfa_recovery_codes", func(c *core.Collection) error {
		secretCollectionRules(c)
		fields := []core.Field{
			userRelation(users),
			// 恢复码明文只在生成响应出现一次；数据库只保存 HMAC hash。
			&core.TextField{Name: "codeHash", Required: true, Max: 128},
			&core.TextField{Name: "usedAt", Max: 40},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_mfa_recovery_user_hash_unique", true, "user, codeHash", "")
		c.AddIndex("idx_mfa_recovery_user_used", false, "user, usedAt", "")
		return nil
	})
}

func ensureMFAAuthTicketsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "mfa_auth_tickets", func(c *core.Collection) error {
		secretCollectionRules(c)
		fields := []core.Field{
			userRelation(users),
			// ticket 是密码已通过但二因子未完成的短期状态，不能被当成 session。
			&core.TextField{Name: "ticketHash", Required: true, Max: 128, Pattern: `^[A-Za-z0-9_-]{43}$`},
			&core.TextField{Name: "expiresAt", Required: true, Max: 40},
			&core.NumberField{Name: "attempts", OnlyInt: true, Min: types.Pointer(0.0), Max: types.Pointer(10.0)},
			&core.JSONField{Name: "methods", MaxSize: 1024},
			// TOTP setup 先放短期加密 payload；只有验证码自证成功后才升级为正式 credential。
			&core.TextField{Name: "payloadCiphertext", Max: 4096},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_mfa_tickets_hash_unique", true, "ticketHash", "")
		c.AddIndex("idx_mfa_tickets_user_expires", false, "user, expiresAt", "")
		return nil
	})
}

func ensurePasskeyCredentialsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "passkey_credentials", func(c *core.Collection) error {
		secretCollectionRules(c)
		fields := []core.Field{
			userRelation(users),
			&core.TextField{Name: "name", Required: true, Max: 80},
			&core.TextField{Name: "credentialId", Required: true, Max: 2048},
			&core.TextField{Name: "publicKey", Required: true, Max: 8192},
			// Go WebAuthn 需要完整 credential 记录；publicKey/counter 字段给跨运行面状态和管理查询使用。
			&core.TextField{Name: "credentialJson", Required: true, Max: 65535},
			&core.NumberField{Name: "counter", OnlyInt: true, Min: types.Pointer(0.0)},
			&core.JSONField{Name: "transports", MaxSize: 2048},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_passkeys_credential_unique", true, "credentialId", "")
		c.AddIndex("idx_passkeys_user", false, "user", "")
		return nil
	})
}

func ensurePasskeyChallengesCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "passkey_challenges", func(c *core.Collection) error {
		secretCollectionRules(c)
		fields := []core.Field{
			&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1},
			&core.TextField{Name: "challengeIdHash", Required: true, Max: 128, Pattern: `^[A-Za-z0-9_-]{43}$`},
			&core.SelectField{Name: "kind", Required: true, Values: []string{"registration", "authentication"}},
			&core.TextField{Name: "challenge", Required: true, Max: 2048},
			// authentication challenge 在用户未知时先不绑定 user；finish 后由 credential 的 userHandle 反查账号。
			// SessionData 是 WebAuthn 库的原子状态；不能拆字段后再自行拼回，否则 origin/RP/allowList 校验会漂移。
			&core.TextField{Name: "sessionDataJson", Required: true, Max: 65535},
			&core.TextField{Name: "expiresAt", Required: true, Max: 40},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_passkey_challenge_unique", true, "challengeIdHash", "")
		c.AddIndex("idx_passkey_challenge_user_kind", false, "user, kind", "")
		return nil
	})
}
