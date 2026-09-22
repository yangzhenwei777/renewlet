package main

// MFA 测试锁住产品 session 与二阶段登录边界；这些断言防止 Docker 前端或 PB 原生 API 绕过二因子。

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

const testTOTPSecret = "JBSWY3DPEHPK3PXP"

func newMFATestApp(t *testing.T) core.App {
	t.Helper()
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	return app
}

func resetMFATestKeyCache(t *testing.T) {
	t.Helper()
	resetAccountSecurityKeyRingCacheForTest()
}

func loginJSON(email string) string {
	return fmt.Sprintf(`{"email":%q,"password":"password123"}`, email)
}

func createTestTOTPCredential(t *testing.T, app core.App, userID string) {
	t.Helper()
	ciphertext, err := encryptMFASecret(app, testTOTPSecret)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := app.FindCollectionByNameOrId("mfa_totp_credentials")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("secretCiphertext", ciphertext)
	record.Set("lastAcceptedStep", 0)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
}

func createTestPasskeyCredential(t *testing.T, app core.App, userID string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("passkey_credentials")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("name", "Test Passkey")
	record.Set("credentialId", "test-passkey-"+userID)
	record.Set("publicKey", "AA")
	record.Set("credentialJson", "{}")
	record.Set("counter", 0)
	record.Set("transports", []string{"internal"})
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
}

func currentTestTOTPCode(t *testing.T) string {
	t.Helper()
	return totpCodeForSecret(t, testTOTPSecret)
}

func totpCodeForSecret(t *testing.T, secret string) string {
	t.Helper()
	code, err := totp.GenerateCodeCustom(secret, time.Now().UTC(), totp.ValidateOpts{
		Period:    mfaTOTPPeriodSeconds,
		Skew:      0,
		Digits:    otp.DigitsSix,
		Algorithm: otp.AlgorithmSHA1,
	})
	if err != nil {
		t.Fatal(err)
	}
	return code
}

func parseProductSessionAuthFromResponse(t *testing.T, res *http.Response) string {
	t.Helper()
	var sessionToken string
	var csrfToken string
	for _, cookie := range res.Cookies() {
		switch cookie.Name {
		case appSessionCookieName:
			sessionToken = cookie.Value
			if !cookie.HttpOnly {
				t.Fatalf("%s must be HttpOnly", appSessionCookieName)
			}
		case appCSRFCookieName:
			csrfToken = cookie.Value
			if cookie.HttpOnly {
				t.Fatalf("%s must stay readable by same-origin JS for CSRF headers", appCSRFCookieName)
			}
		}
	}
	if sessionToken == "" || csrfToken == "" {
		t.Fatalf("expected product session and CSRF cookies, got %#v", res.Cookies())
	}
	return routeTestProductSessionAuth(sessionToken, csrfToken)
}

func routeTestProductSessionParts(t *testing.T, token string) (string, string) {
	t.Helper()
	if !strings.HasPrefix(token, routeTestProductSessionPrefix) {
		t.Fatalf("expected route product session token, got %q", token)
	}
	parts := strings.SplitN(strings.TrimPrefix(token, routeTestProductSessionPrefix), ":", 2)
	if len(parts) != 2 {
		t.Fatalf("expected route product session + csrf pair, got %q", token)
	}
	return parts[0], parts[1]
}

func parseMFATicket(t *testing.T, res *http.Response) string {
	t.Helper()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	body := decodeAPISuccessDataForTest[mfaRequiredResponse](t, data)
	if body.Type != "mfa_required" || body.TicketID == "" {
		t.Fatalf("expected MFA-required response, got %#v", body)
	}
	return body.TicketID
}

func loginAndReadMFATicket(t *testing.T, app core.App, email string) string {
	t.Helper()
	res := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/login", loginJSON(email), "")
	if res.Code != http.StatusOK {
		t.Fatalf("expected MFA login challenge 200, got %d: %s", res.Code, res.Body.String())
	}
	return parseMFATicket(t, res.Result())
}

func countMFARecords(t *testing.T, app core.App, collection string, userID string) int {
	t.Helper()
	count, err := app.CountRecords(collection, dbx.HashExp{"user": userID})
	if err != nil {
		t.Fatal(err)
	}
	return int(count)
}

func TestProductAuthLoginWithoutMFAIssuesSession(t *testing.T) {
	app := newMFATestApp(t)
	user, err := createUser(app, "No MFA", "nomfa@example.com", "password123", "admin")
	if err != nil {
		t.Fatal(err)
	}

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/login", loginJSON(user.Email()), "")
	if res.Code != http.StatusOK {
		t.Fatalf("expected login 200, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[sessionResponse](t, res.Body.Bytes())
	if body.Type != "session" || body.Session.ExpiresAt == "" {
		t.Fatalf("expected product session response, got %#v", body)
	}
	_ = parseProductSessionAuthFromResponse(t, res.Result())
	if got := countMFARecords(t, app, "app_sessions", user.Id); got != 1 {
		t.Fatalf("expected exactly one app session, got %d", got)
	}
	if got := countMFARecords(t, app, "mfa_auth_tickets", user.Id); got != 0 {
		t.Fatalf("expected no MFA ticket for non-MFA login, got %d", got)
	}
}

func TestSelfServiceTOTPEnableRenewsProductSession(t *testing.T) {
	resetMFATestKeyCache(t)
	app := newMFATestApp(t)
	user, oldToken := createRouteTestUser(t, app, "self-mfa")
	otherToken, otherCSRFToken, _, err := createAppSession(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	otherAuth := routeTestProductSessionAuth(otherToken, otherCSRFToken)
	setup, err := startTOTPSetup(app, user)
	if err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"setupId":%q,"code":%q,"currentPassword":"password123"}`, setup.SetupID, totpCodeForSecret(t, setup.Secret))

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/mfa/totp/enable", body, oldToken)
	if res.Code != http.StatusOK {
		t.Fatalf("expected TOTP enable 200, got %d: %s", res.Code, res.Body.String())
	}
	response := decodeAPISuccessDataForTest[mfaRecoveryCodesResponse](t, res.Body.Bytes())
	if response.Type != "session" || response.Session.ExpiresAt == "" || len(response.RecoveryCodes) != mfaRecoveryCodeCount {
		t.Fatalf("expected renewed session with recovery codes, got %#v", response)
	}
	renewedAuth := parseProductSessionAuthFromResponse(t, res.Result())
	renewedToken, _ := routeTestProductSessionParts(t, renewedAuth)
	oldSessionToken, _ := routeTestProductSessionParts(t, oldToken)
	if renewedToken == oldSessionToken || renewedToken == otherToken {
		t.Fatalf("expected TOTP enable to rotate away from old tokens")
	}

	for _, token := range []string{oldToken, otherAuth} {
		staleRes := serveTestRequest(t, app, http.MethodGet, "/api/app/auth/mfa/status", "", token)
		if staleRes.Code != http.StatusUnauthorized {
			t.Fatalf("expected old token to be unauthorized, got %d: %s", staleRes.Code, staleRes.Body.String())
		}
	}
	statusRes := serveTestRequest(t, app, http.MethodGet, "/api/app/auth/mfa/status", "", renewedAuth)
	if statusRes.Code != http.StatusOK {
		t.Fatalf("expected renewed token to read MFA status, got %d: %s", statusRes.Code, statusRes.Body.String())
	}
	status := decodeAPISuccessDataForTest[mfaStatusResponse](t, statusRes.Body.Bytes())
	if !status.Enabled || status.RecoveryCodesRemaining != mfaRecoveryCodeCount {
		t.Fatalf("expected enabled MFA status after renewal, got %#v", status)
	}
	if got := countMFARecords(t, app, "app_sessions", user.Id); got != 1 {
		t.Fatalf("expected only renewed app session to remain, got %d", got)
	}
	if got := countMFARecords(t, app, "mfa_auth_tickets", user.Id); got != 0 {
		t.Fatalf("expected setup ticket to be consumed, got %d", got)
	}
}

func TestAccountSecurityKeyAutoGeneratesAndReusesFile(t *testing.T) {
	resetAccountSecurityKeyRingCacheForTest()
	app := newMFATestApp(t)

	if _, err := accountSecurityKeyRingForApp(app); err != nil {
		t.Fatal(err)
	}
	keyPath := accountSecurityKeyPath(app.DataDir())
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("expected account security key file mode 0600, got %o", got)
	}
	first, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}

	resetAccountSecurityKeyRingCacheForTest()
	if _, err := accountSecurityKeyRingForApp(app); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatalf("expected account security key file to be reused")
	}
}

func TestAccountSecurityKeyCorruptionFailsClosed(t *testing.T) {
	resetAccountSecurityKeyRingCacheForTest()
	app := newMFATestApp(t)
	keyPath := accountSecurityKeyPath(app.DataDir())
	if err := os.MkdirAll(filepath.Dir(keyPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte(`{"version":1,"key":"bad"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := accountSecurityKeyRingForApp(app); err == nil {
		t.Fatalf("expected corrupted account security key to fail closed")
	}
}

func TestProductAuthLoginWithMFAIssuesTicketOnly(t *testing.T) {
	resetMFATestKeyCache(t)
	app := newMFATestApp(t)
	user, err := createUser(app, "MFA User", "mfa@example.com", "password123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	createTestTOTPCredential(t, app, user.Id)

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/login", loginJSON(user.Email()), "")
	if res.Code != http.StatusOK {
		t.Fatalf("expected login 200, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[mfaRequiredResponse](t, res.Body.Bytes())
	if body.Type != "mfa_required" || body.TicketID == "" || !strings.Contains(strings.Join(body.Methods, ","), mfaMethodTOTP) {
		t.Fatalf("expected MFA ticket with TOTP method, got %#v", body)
	}
	if got := countMFARecords(t, app, "app_sessions", user.Id); got != 0 {
		t.Fatalf("expected no app session before MFA verify, got %d", got)
	}
	if got := countMFARecords(t, app, "mfa_auth_tickets", user.Id); got != 1 {
		t.Fatalf("expected one MFA ticket, got %d", got)
	}
}

func TestProductAuthLoginWithPasskeyOnlyIssuesSession(t *testing.T) {
	app := newMFATestApp(t)
	user, err := createUser(app, "Passkey Only", "passkey-only@example.com", "password123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	createTestPasskeyCredential(t, app, user.Id)

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/login", loginJSON(user.Email()), "")
	if res.Code != http.StatusOK {
		t.Fatalf("expected passkey-only password login 200, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[sessionResponse](t, res.Body.Bytes())
	if body.Type != "session" || body.Session.ExpiresAt == "" {
		t.Fatalf("expected passkey-only password login to issue product session, got %#v", body)
	}
	_ = parseProductSessionAuthFromResponse(t, res.Result())
	if got := countMFARecords(t, app, "mfa_auth_tickets", user.Id); got != 0 {
		t.Fatalf("expected no MFA ticket for passkey-only password login, got %d", got)
	}
}

func TestPasskeyRegisterOptionsDoesNotRenewSession(t *testing.T) {
	resetMFATestKeyCache(t)
	app := newMFATestApp(t)
	_, token := createRouteTestUser(t, app, "passkey-options")

	res := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/app/auth/passkeys/register/options", `{"name":"MacBook Touch ID","currentPassword":"password123"}`, token, map[string]string{
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "renewlet.example",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("expected Passkey register options 200, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[passkeyWebAuthnOptionsResponse](t, res.Body.Bytes())
	if body.ChallengeID == "" || body.ExpiresAt == "" || body.Options == nil {
		t.Fatalf("expected Passkey register options challenge response, got %#v", body)
	}
	for _, cookie := range res.Result().Cookies() {
		if cookie.Name == appSessionCookieName || cookie.Name == appCSRFCookieName {
			t.Fatalf("Passkey register options must not renew session cookies, got %#v", res.Result().Cookies())
		}
	}
}

func TestPasskeyAuthenticateOptionsIsPreAuthenticationChallenge(t *testing.T) {
	resetMFATestKeyCache(t)
	app := newMFATestApp(t)

	res := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/app/auth/passkeys/authenticate/options", `{}`, "", map[string]string{
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "renewlet.example",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("expected unauthenticated Passkey options 200, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[passkeyWebAuthnOptionsResponse](t, res.Body.Bytes())
	if body.ChallengeID == "" || body.ExpiresAt == "" || body.Options == nil {
		t.Fatalf("expected Passkey options challenge response, got %#v", body)
	}
}

func TestPasskeyAuthenticateOptionsInitializationFailureIsBadRequest(t *testing.T) {
	app := newSchemaTestApp(t)

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/passkeys/authenticate/options", `{}`, "")
	if res.Code != http.StatusBadRequest {
		t.Fatalf("expected Passkey options initialization failure to return 400, got %d: %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "Session has expired") || strings.Contains(res.Body.String(), "登录已失效") {
		t.Fatalf("Passkey options initialization failure must not look like session expiry: %s", res.Body.String())
	}
}

func TestMFAVerifyRejectsReplayedTOTPStep(t *testing.T) {
	resetMFATestKeyCache(t)
	app := newMFATestApp(t)
	user, err := createUser(app, "TOTP User", "totp@example.com", "password123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	createTestTOTPCredential(t, app, user.Id)

	code := currentTestTOTPCode(t)
	ticketID := loginAndReadMFATicket(t, app, user.Email())
	verify := fmt.Sprintf(`{"method":"totp","ticketId":%q,"code":%q}`, ticketID, code)
	res := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/mfa/verify", verify, "")
	if res.Code != http.StatusOK {
		t.Fatalf("expected first TOTP verify 200, got %d: %s", res.Code, res.Body.String())
	}

	replayTicketID := loginAndReadMFATicket(t, app, user.Email())
	replay := fmt.Sprintf(`{"method":"totp","ticketId":%q,"code":%q}`, replayTicketID, code)
	replayRes := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/mfa/verify", replay, "")
	if replayRes.Code != http.StatusUnauthorized {
		t.Fatalf("expected replayed TOTP step to return 401, got %d: %s", replayRes.Code, replayRes.Body.String())
	}
}

func TestMFARecoveryCodeCanOnlyBeUsedOnce(t *testing.T) {
	resetMFATestKeyCache(t)
	app := newMFATestApp(t)
	user, err := createUser(app, "Recovery User", "recovery@example.com", "password123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	codes, err := replaceRecoveryCodes(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	code := codes[0]

	ticketID := loginAndReadMFATicket(t, app, user.Email())
	verify := fmt.Sprintf(`{"method":"recovery_code","ticketId":%q,"code":%q}`, ticketID, code)
	res := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/mfa/verify", verify, "")
	if res.Code != http.StatusOK {
		t.Fatalf("expected first recovery code verify 200, got %d: %s", res.Code, res.Body.String())
	}

	replayTicketID := loginAndReadMFATicket(t, app, user.Email())
	replay := fmt.Sprintf(`{"method":"recovery_code","ticketId":%q,"code":%q}`, replayTicketID, code)
	replayRes := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/mfa/verify", replay, "")
	if replayRes.Code != http.StatusUnauthorized {
		t.Fatalf("expected reused recovery code to return 401, got %d: %s", replayRes.Code, replayRes.Body.String())
	}
}

func TestPocketBaseNativePasswordAuthRejectsMFAProtectedUsers(t *testing.T) {
	resetMFATestKeyCache(t)
	app := newMFATestApp(t)
	user, err := createUser(app, "Native MFA", "native-mfa@example.com", "password123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	createTestTOTPCredential(t, app, user.Id)

	body := fmt.Sprintf(`{"identity":%q,"password":"password123"}`, user.Email())
	res := servePocketBaseTestRequest(t, app, http.MethodPost, "/api/collections/users/auth-with-password", body, "")
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("expected PocketBase native auth to reject MFA user, got %d: %s", res.Code, res.Body.String())
	}
}

func TestPocketBaseNativePasswordAuthRejectsPasskeyUsers(t *testing.T) {
	app := newMFATestApp(t)
	user, err := createUser(app, "Native Passkey", "native-passkey@example.com", "password123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	createTestPasskeyCredential(t, app, user.Id)

	body := fmt.Sprintf(`{"identity":%q,"password":"password123"}`, user.Email())
	res := servePocketBaseTestRequest(t, app, http.MethodPost, "/api/collections/users/auth-with-password", body, "")
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("expected PocketBase native auth to reject passkey user, got %d: %s", res.Code, res.Body.String())
	}
}

func TestAdminResetMFAClearsCredentialsSessionsAndTickets(t *testing.T) {
	resetMFATestKeyCache(t)
	app := newMFATestApp(t)
	admin, adminToken := createRouteTestUser(t, app, "admin")
	target, err := createUser(app, "Target MFA", "target-mfa@example.com", "password123", "user")
	if err != nil {
		t.Fatal(err)
	}
	createTestTOTPCredential(t, app, target.Id)
	createTestPasskeyCredential(t, app, target.Id)
	if _, err := replaceRecoveryCodes(app, target.Id); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := createAppSession(app, target.Id); err != nil {
		t.Fatal(err)
	}
	if _, _, err := createMfaTicketRecord(app, target.Id, []string{mfaMethodTOTP}, ""); err != nil {
		t.Fatal(err)
	}

	selfRes := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/users/"+admin.Id+"/mfa/reset", "", adminToken)
	if selfRes.Code != http.StatusBadRequest {
		t.Fatalf("expected current admin MFA reset to return 400, got %d: %s", selfRes.Code, selfRes.Body.String())
	}

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/users/"+target.Id+"/mfa/reset", "", adminToken)
	if res.Code != http.StatusOK {
		t.Fatalf("expected admin MFA reset 200, got %d: %s", res.Code, res.Body.String())
	}
	for _, collection := range []string{"mfa_totp_credentials", "mfa_recovery_codes", "mfa_auth_tickets", "app_sessions"} {
		if got := countMFARecords(t, app, collection, target.Id); got != 0 {
			t.Fatalf("expected %s to be cleared, got %d", collection, got)
		}
	}
	if got := countMFARecords(t, app, "passkey_credentials", target.Id); got != 1 {
		t.Fatalf("expected admin MFA reset to preserve passkeys, got %d", got)
	}
}

func TestAdminResetPasskeysPreservesAuthenticatorCredentials(t *testing.T) {
	resetMFATestKeyCache(t)
	app := newMFATestApp(t)
	admin, adminToken := createRouteTestUser(t, app, "admin")
	target, err := createUser(app, "Target Passkey", "target-passkey@example.com", "password123", "user")
	if err != nil {
		t.Fatal(err)
	}
	createTestTOTPCredential(t, app, target.Id)
	createTestPasskeyCredential(t, app, target.Id)
	if _, err := replaceRecoveryCodes(app, target.Id); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := createAppSession(app, target.Id); err != nil {
		t.Fatal(err)
	}
	if _, _, err := createMfaTicketRecord(app, target.Id, []string{mfaMethodTOTP}, ""); err != nil {
		t.Fatal(err)
	}

	selfRes := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/users/"+admin.Id+"/passkeys/reset", "", adminToken)
	if selfRes.Code != http.StatusBadRequest {
		t.Fatalf("expected current admin passkey reset to return 400, got %d: %s", selfRes.Code, selfRes.Body.String())
	}

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/users/"+target.Id+"/passkeys/reset", "", adminToken)
	if res.Code != http.StatusOK {
		t.Fatalf("expected admin passkey reset 200, got %d: %s", res.Code, res.Body.String())
	}
	for _, collection := range []string{"passkey_credentials", "mfa_auth_tickets", "app_sessions"} {
		if got := countMFARecords(t, app, collection, target.Id); got != 0 {
			t.Fatalf("expected %s to be cleared, got %d", collection, got)
		}
	}
	if got := countMFARecords(t, app, "mfa_totp_credentials", target.Id); got != 1 {
		t.Fatalf("expected admin passkey reset to preserve TOTP credentials, got %d", got)
	}
	if got := countMFARecords(t, app, "mfa_recovery_codes", target.Id); got != mfaRecoveryCodeCount {
		t.Fatalf("expected admin passkey reset to preserve recovery codes, got %d", got)
	}
}
