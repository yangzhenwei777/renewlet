package main

// users.go 管理产品侧用户 DTO、初始化管理员和管理员保护规则。
//
// 架构位置：PocketBase 提供认证记录，Renewlet 在 users collection 上增加 role/banned/banReason，
// 并由管理员 API 与登录 hook 统一消费这些字段。
//
// 注意： 这里的自锁保护是最后一道后端防线；前端按钮禁用不能替代这些检查。
import (
	"errors"
	"net/mail"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type userDTO struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Email           string   `json:"email"`
	Role            string   `json:"role"`
	Banned          bool     `json:"banned"`
	MFAEnabled      bool     `json:"mfaEnabled"`
	MFAMethods      []string `json:"mfaMethods"`
	PasskeysEnabled bool     `json:"passkeysEnabled"`
	PasskeyCount    int      `json:"passkeyCount"`
	BanReason       *string  `json:"banReason,omitempty"`
	CreatedAt       string   `json:"createdAt"`
	UpdatedAt       string   `json:"updatedAt"`
}

var errSetupAlreadyInitialized = errors.New("SETUP_ALREADY_INITIALIZED")

// requireAdmin 是管理员 API 的权限中间件。
// 注意： 前端禁用按钮只是体验优化；所有管理员写操作都必须经过这里和后续防自锁校验。
func requireAdmin(e *core.RequestEvent) error {
	if e.Auth == nil || e.Auth.GetString("role") != "admin" || e.Auth.GetBool("banned") {
		return e.ForbiddenError(serverText(requestLocale(e.Request), "auth.adminRequiredShort"), nil)
	}
	return e.Next()
}

// normalizeRole 将未知 role 收敛为普通用户。
// 新增角色时不要复用这个 fallback，需要先扩展前后端枚举和权限策略。
func normalizeRole(role string) string {
	if role == "admin" {
		return "admin"
	}
	return "user"
}

// createInitialAdmin 在事务内创建首个管理员、账号设置和 PocketBase superuser。
// 事务用于避免并发 setup 请求同时通过 hasEnabledAdmin 检查。
func createInitialAdmin(app core.App, name string, email string, password string) error {
	return app.RunInTransaction(func(txApp core.App) error {
		if hasEnabledAdmin(txApp) {
			return errSetupAlreadyInitialized
		}
		user, err := createUser(txApp, name, email, password, "admin")
		if err != nil {
			return err
		}
		if _, err := createSettingsRecord(txApp, user.Id, defaultAppSettings()); err != nil {
			return err
		}
		return createInitialSuperuserIfMissing(txApp, email, password)
	})
}

func createUser(app core.App, name string, email string, password string, role string) (*core.Record, error) {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	email = strings.TrimSpace(email)
	if name == "" {
		return nil, errors.New("USER_NAME_REQUIRED")
	}
	if len(name) > 80 {
		return nil, errors.New("USER_NAME_TOO_LONG")
	}
	if _, err := mail.ParseAddress(email); err != nil || len(email) > 254 {
		return nil, errors.New("USER_EMAIL_INVALID")
	}
	if len(password) < 8 || len(password) > 128 {
		return nil, errors.New("USER_PASSWORD_INVALID")
	}
	user := core.NewRecord(users)
	user.Set("name", name)
	user.SetEmail(email)
	user.SetEmailVisibility(true)
	user.SetVerified(true)
	user.SetPassword(password)
	user.Set("role", normalizeRole(role))
	user.Set("banned", false)
	if err := app.Save(user); err != nil {
		return nil, err
	}
	return user, nil
}

// createInitialSuperuserIfMissing 确保首次部署后 PocketBase 管理入口可恢复。
// 注意： 已存在非安装器 superuser 时不覆盖，避免破坏用户已有管理账号。
func createInitialSuperuserIfMissing(app core.App, email string, password string) error {
	hasSuperuser, err := hasNonInstallerSuperuser(app)
	if err != nil {
		return err
	}
	if hasSuperuser {
		return nil
	}
	superusers, err := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		return err
	}
	superuser := core.NewRecord(superusers)
	superuser.SetEmail(strings.TrimSpace(email))
	superuser.SetPassword(password)
	return app.Save(superuser)
}

// hasNonInstallerSuperuser 判断是否已有用户掌控的 PocketBase superuser。
// 默认 installer 邮箱只是 PocketBase 初始化哨兵，不能阻止 Renewlet 创建真正可登录的管理入口。
func hasNonInstallerSuperuser(app core.App) (bool, error) {
	total, err := app.CountRecords(core.CollectionNameSuperusers, dbx.Not(dbx.HashExp{
		"email": core.DefaultInstallerEmail,
	}))
	if err != nil {
		return false, err
	}
	return total > 0, nil
}

// hasEnabledAdmin 判断产品侧是否已有可用管理员，供 setup route 做最终裁决。
func hasEnabledAdmin(app core.App) bool {
	users, err := app.FindAllRecords("users", dbx.HashExp{"role": "admin", "banned": false})
	return err == nil && len(users) > 0
}

// enabledAdminCount 返回仍可登录的管理员数量，用于防止自锁。
func enabledAdminCount(app core.App) int {
	users, err := app.FindAllRecords("users", dbx.HashExp{"role": "admin", "banned": false})
	if err != nil {
		return 0
	}
	return len(users)
}

// preventLastAdminMutation 拦截降级、禁用当前账号或最后管理员的写入。
// 该函数同时保护 API、SDK 和管理后台触发的 record save，不能只依赖 route 层。
func preventLastAdminMutation(app core.App, current *core.Record, target *core.Record) error {
	if current != nil && current.Id == target.Id && (target.GetString("role") != "admin" || target.GetBool("banned")) {
		return errors.New("CURRENT_ACCOUNT_PROTECTED")
	}
	if target.Original().GetString("role") == "admin" && !target.Original().GetBool("banned") {
		if (target.GetString("role") != "admin" || target.GetBool("banned")) && enabledAdminCount(app) <= 1 {
			return errors.New("LAST_ADMIN_PROTECTED")
		}
	}
	return nil
}

// preventUserDelete 拦截删除当前账号或最后管理员。
// 删除会连带清理用户数据，因此必须在真正执行删除前做后端裁决。
func preventUserDelete(app core.App, current *core.Record, target *core.Record) error {
	if current != nil && current.Id == target.Id {
		return errors.New("CURRENT_ACCOUNT_DELETE_PROTECTED")
	}
	if target.GetString("role") == "admin" && !target.GetBool("banned") && enabledAdminCount(app) <= 1 {
		return errors.New("LAST_ADMIN_PROTECTED")
	}
	return nil
}

func localizeAdminMutationError(locale appLocale, err error) string {
	if err == nil {
		return ""
	}
	switch err.Error() {
	case "CURRENT_ACCOUNT_PROTECTED":
		return serverText(locale, "auth.cannotDisableOrDemoteCurrentSignedIn")
	case "LAST_ADMIN_PROTECTED":
		return serverText(locale, "auth.atLeastOneEnabledAdminShort")
	case "CURRENT_ACCOUNT_DELETE_PROTECTED":
		return serverText(locale, "auth.cannotDeleteCurrentSignedIn")
	default:
		return err.Error()
	}
}

// toUserDTO 将 PocketBase 用户记录转换为前端可见 DTO。
// 注意： 不要在 DTO 中暴露认证内部字段或密码相关状态。
func toUserDTO(app core.App, user *core.Record) userDTO {
	var banReason *string
	if reason := strings.TrimSpace(user.GetString("banReason")); reason != "" {
		banReason = &reason
	}
	mfaEnabled, mfaMethods, _ := authenticatorMfaEnabledForUser(app, user.Id)
	passkeyCount, _ := passkeyCredentialCount(app, user.Id)
	return userDTO{
		ID:              user.Id,
		Name:            user.GetString("name"),
		Email:           user.Email(),
		Role:            normalizeRole(user.GetString("role")),
		Banned:          user.GetBool("banned"),
		MFAEnabled:      mfaEnabled,
		MFAMethods:      mfaMethods,
		PasskeysEnabled: passkeyCount > 0,
		PasskeyCount:    passkeyCount,
		BanReason:       banReason,
		CreatedAt:       user.GetDateTime("created").String(),
		UpdatedAt:       user.GetDateTime("updated").String(),
	}
}
