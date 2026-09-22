package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

// 这组测试覆盖 Turnstile 安全边界：secret 单向写入、公开 status 脱敏、登录前置校验和上游 raw 不外泄。
func TestAuthSecurityAdminRouteManagesTurnstileWithoutSecretEcho(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "admin")

	incomplete := serveTestRequest(t, app, http.MethodPut, "/api/app/admin/auth-security", `{"turnstile":{"enabled":true,"siteKey":"site-key"}}`, token)
	if incomplete.Code != http.StatusBadRequest || !strings.Contains(incomplete.Body.String(), "TURNSTILE_CONFIG_INCOMPLETE") {
		t.Fatalf("expected incomplete config rejection, got %d: %s", incomplete.Code, incomplete.Body.String())
	}

	save := serveTestRequest(t, app, http.MethodPut, "/api/app/admin/auth-security", `{"turnstile":{"enabled":true,"siteKey":"site-key","secret":"secret-value"}}`, token)
	if save.Code != http.StatusOK {
		t.Fatalf("expected auth security save 200, got %d: %s", save.Code, save.Body.String())
	}
	if strings.Contains(save.Body.String(), "secret-value") || strings.Contains(save.Body.String(), "turnstileSecret") {
		t.Fatalf("auth security response leaked secret: %s", save.Body.String())
	}
	saved := decodeAPISuccessDataForTest[authSecurityResponse](t, save.Body.Bytes())
	if !saved.Turnstile.Enabled || saved.Turnstile.SiteKey != "site-key" || !saved.Turnstile.SecretConfigured {
		t.Fatalf("unexpected saved auth security response: %#v", saved)
	}

	status := serveTestRequest(t, app, http.MethodGet, "/api/app/status", "", "")
	if status.Code != http.StatusOK {
		t.Fatalf("expected app status 200, got %d: %s", status.Code, status.Body.String())
	}
	if strings.Contains(status.Body.String(), "secret") {
		t.Fatalf("app status leaked secret metadata: %s", status.Body.String())
	}
	statusData := decodeAPISuccessDataForTest[appStatusResponse](t, status.Body.Bytes())
	if !statusData.Turnstile.Enabled || statusData.Turnstile.SiteKey != "site-key" {
		t.Fatalf("expected public status to expose only enabled site key, got %#v", statusData.Turnstile)
	}

	retain := serveTestRequest(t, app, http.MethodPut, "/api/app/admin/auth-security", `{"turnstile":{"enabled":true,"siteKey":"site-key-2"}}`, token)
	if retain.Code != http.StatusOK {
		t.Fatalf("expected secret retention save 200, got %d: %s", retain.Code, retain.Body.String())
	}
	retained, err := readAuthSecuritySettings(app)
	if err != nil {
		t.Fatal(err)
	}
	if retained.TurnstileSiteKey != "site-key-2" || retained.TurnstileSecret != "secret-value" {
		t.Fatalf("expected omitted secret to retain old value, got %#v", retained)
	}

	clear := serveTestRequest(t, app, http.MethodPut, "/api/app/admin/auth-security", `{"turnstile":{"enabled":false,"siteKey":"site-key-2","secret":""}}`, token)
	if clear.Code != http.StatusOK {
		t.Fatalf("expected secret clear 200, got %d: %s", clear.Code, clear.Body.String())
	}
	cleared := decodeAPISuccessDataForTest[authSecurityResponse](t, clear.Body.Bytes())
	if cleared.Turnstile.Enabled || cleared.Turnstile.SecretConfigured {
		t.Fatalf("expected cleared secret to disable Turnstile, got %#v", cleared)
	}
}

func TestAuthLoginRequiresTurnstileBeforePasswordFlow(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "user")
	if err := saveAuthSecuritySettings(app, authSecurityStoredSettings{
		TurnstileEnabled: true,
		TurnstileSiteKey: "site-key",
		TurnstileSecret:  "secret-value",
	}); err != nil {
		t.Fatal(err)
	}

	originalVerify := verifyTurnstileToken
	t.Cleanup(func() {
		verifyTurnstileToken = originalVerify
	})
	calls := make([]string, 0, 2)
	// verifyTurnstileToken 是包级替换点，测试用它证明登录在密码流程前完成 Siteverify 且失败响应脱敏。
	verifyTurnstileToken = func(_ context.Context, secret string, token string, remoteIP string) error {
		calls = append(calls, secret+"|"+token+"|"+remoteIP)
		return errors.New("cloudflare raw failure")
	}

	missing := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/login", `{"email":"`+user.Email()+`","password":"password123"}`, "")
	if missing.Code != http.StatusBadRequest || !strings.Contains(missing.Body.String(), "TURNSTILE_REQUIRED") {
		t.Fatalf("expected missing Turnstile token to be rejected, got %d: %s", missing.Code, missing.Body.String())
	}
	if len(calls) != 0 {
		t.Fatalf("missing token should not call Siteverify, got %#v", calls)
	}

	failed := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/login", `{"email":"`+user.Email()+`","password":"password123","turnstileToken":"bad-token"}`, "")
	if failed.Code != http.StatusBadRequest || !strings.Contains(failed.Body.String(), "TURNSTILE_FAILED") {
		t.Fatalf("expected failed Turnstile token to be rejected, got %d: %s", failed.Code, failed.Body.String())
	}
	if strings.Contains(failed.Body.String(), "cloudflare raw failure") || strings.Contains(failed.Body.String(), "secret-value") {
		t.Fatalf("Turnstile failure response leaked raw upstream details: %s", failed.Body.String())
	}

	verifyTurnstileToken = func(_ context.Context, secret string, token string, remoteIP string) error {
		calls = append(calls, secret+"|"+token+"|"+remoteIP)
		return nil
	}
	success := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/app/auth/login", `{"email":"`+user.Email()+`","password":"password123","turnstileToken":"ok-token"}`, "", map[string]string{
		"CF-Connecting-IP": "203.0.113.9",
	})
	if success.Code != http.StatusOK {
		t.Fatalf("expected successful password login after Turnstile, got %d: %s", success.Code, success.Body.String())
	}
	if calls[len(calls)-1] != "secret-value|ok-token|203.0.113.9" {
		t.Fatalf("expected Siteverify to receive secret, token and remote IP, got %#v", calls)
	}
}

func TestAuthSecurityTurnstileTestRouteVerifiesDraftAndStoredSecret(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "admin")

	originalVerify := verifyTurnstileToken
	t.Cleanup(func() {
		verifyTurnstileToken = originalVerify
	})
	calls := make([]string, 0, 2)
	// 这里显式记录 Siteverify 入参，防止测试接口以后误改成保存草稿 secret 或忽略 remoteip。
	verifyTurnstileToken = func(_ context.Context, secret string, token string, remoteIP string) error {
		calls = append(calls, secret+"|"+token+"|"+remoteIP)
		return nil
	}

	draft := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/app/admin/auth-security/turnstile/test", `{"turnstile":{"siteKey":"site-key","secret":"draft-secret","turnstileToken":"draft-token"}}`, token, map[string]string{
		"CF-Connecting-IP": "203.0.113.9",
	})
	if draft.Code != http.StatusOK || !strings.Contains(draft.Body.String(), `"verified":true`) {
		t.Fatalf("expected draft secret test success, got %d: %s", draft.Code, draft.Body.String())
	}
	if calls[len(calls)-1] != "draft-secret|draft-token|203.0.113.9" {
		t.Fatalf("expected draft secret Siteverify call, got %#v", calls)
	}
	if strings.Contains(draft.Body.String(), "draft-secret") || strings.Contains(draft.Body.String(), "draft-token") {
		t.Fatalf("turnstile test response leaked draft credentials: %s", draft.Body.String())
	}

	if err := saveAuthSecuritySettings(app, authSecurityStoredSettings{
		TurnstileEnabled: false,
		TurnstileSiteKey: "stored-site-key",
		TurnstileSecret:  "stored-secret",
	}); err != nil {
		t.Fatal(err)
	}
	stored := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/auth-security/turnstile/test", `{"turnstile":{"siteKey":"stored-site-key","secret":"","turnstileToken":"stored-token"}}`, token)
	if stored.Code != http.StatusOK {
		t.Fatalf("expected stored secret test success, got %d: %s", stored.Code, stored.Body.String())
	}
	// 无代理头时 httptest RemoteAddr 仍是 best-effort 客户端 IP，避免测试接口退化成永远不传 remoteip。
	if calls[len(calls)-1] != "stored-secret|stored-token|192.0.2.1" {
		t.Fatalf("expected stored secret fallback Siteverify call, got %#v", calls)
	}
}

func TestAuthSecurityTurnstileTestRouteFailsClosedWithoutLeaks(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "admin")

	originalVerify := verifyTurnstileToken
	t.Cleanup(func() {
		verifyTurnstileToken = originalVerify
	})
	calls := 0
	verifyTurnstileToken = func(_ context.Context, secret string, token string, remoteIP string) error {
		calls++
		return errors.New("cloudflare raw failure secret-value token-value")
	}

	incomplete := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/auth-security/turnstile/test", `{"turnstile":{"siteKey":"","secret":"","turnstileToken":"token-value"}}`, token)
	if incomplete.Code != http.StatusBadRequest || !strings.Contains(incomplete.Body.String(), "TURNSTILE_CONFIG_INCOMPLETE") {
		t.Fatalf("expected incomplete config error, got %d: %s", incomplete.Code, incomplete.Body.String())
	}

	missingToken := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/auth-security/turnstile/test", `{"turnstile":{"siteKey":"site-key","secret":"secret-value"}}`, token)
	if missingToken.Code != http.StatusBadRequest || !strings.Contains(missingToken.Body.String(), "TURNSTILE_REQUIRED") {
		t.Fatalf("expected missing token error, got %d: %s", missingToken.Code, missingToken.Body.String())
	}
	if calls != 0 {
		t.Fatalf("missing token must not call Siteverify, got %d calls", calls)
	}

	failed := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/auth-security/turnstile/test", `{"turnstile":{"siteKey":"site-key","secret":"secret-value","turnstileToken":"token-value"}}`, token)
	if failed.Code != http.StatusBadRequest || !strings.Contains(failed.Body.String(), "TURNSTILE_TEST_FAILED") {
		t.Fatalf("expected test failure code, got %d: %s", failed.Code, failed.Body.String())
	}
	if strings.Contains(failed.Body.String(), "cloudflare raw failure") || strings.Contains(failed.Body.String(), "secret-value") || strings.Contains(failed.Body.String(), "token-value") {
		t.Fatalf("turnstile test failure leaked upstream details: %s", failed.Body.String())
	}
}
