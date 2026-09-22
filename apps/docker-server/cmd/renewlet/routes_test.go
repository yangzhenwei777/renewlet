package main

// Route 测试保护自定义 API 的认证、严格 JSON、管理员防自锁、私有资产和跨运行面契约边界。
// 新增 route 时优先在这里证明 Go/PocketBase 行为与前端 Zod、Cloudflare Worker 契约一致。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const routeTestProductSessionPrefix = "product-session:"

func routeTestProductSessionAuth(token string, csrfToken string) string {
	return routeTestProductSessionPrefix + token + ":" + csrfToken
}

func servePocketBaseTestRequest(t *testing.T, app core.App, method string, target string, body string, token string) *httptest.ResponseRecorder {
	t.Helper()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	registerRoutes(app, router)
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	req.Header.Set("content-type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func serveTestRequest(t *testing.T, app core.App, method string, target string, body string, token string) *httptest.ResponseRecorder {
	return serveTestRequestWithHeaders(t, app, method, target, body, token, nil)
}

func serveTestRequestWithHeaders(t *testing.T, app core.App, method string, target string, body string, token string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	registerRoutes(app, router)
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	req.Header.Set("content-type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	applyRouteTestAuth(req, token)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func serveMultipartTestRequest(t *testing.T, app core.App, target string, token string, fields map[string]string, fileField string, filename string, content string) *httptest.ResponseRecorder {
	t.Helper()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	registerRoutes(app, router)
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile(fileField, filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, target, &body)
	req.Header.Set("content-type", writer.FormDataContentType())
	applyRouteTestAuth(req, token)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func createRouteTestUser(t *testing.T, app core.App, role string) (*core.Record, string) {
	t.Helper()
	user, err := createUser(app, "Admin", "admin-"+role+"@example.com", "password123", role)
	if err != nil {
		t.Fatal(err)
	}
	token, csrfToken, _, err := createAppSession(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	return user, routeTestProductSessionAuth(token, csrfToken)
}

func createRouteTestUserWithPocketBaseToken(t *testing.T, app core.App, role string) (*core.Record, string) {
	t.Helper()
	user, err := createUser(app, "Admin", "admin-"+role+"@example.com", "password123", role)
	if err != nil {
		t.Fatal(err)
	}
	token, err := user.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	return user, token
}

func createRouteTestSubscription(t *testing.T, app core.App, userID string, overrides map[string]interface{}) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Load(map[string]interface{}{
		"user":                         userID,
		"name":                         "Route Subscription",
		"price":                        "12",
		"currency":                     "USD",
		"billingCycle":                 "monthly",
		"category":                     "productivity",
		"status":                       "active",
		"pinned":                       false,
		"publicHidden":                 false,
		"startDate":                    "2026-01-01",
		"nextBillingDate":              "2026-02-01",
		"autoRenew":                    true,
		"autoCalculateNextBillingDate": true,
		"tags":                         []string{},
		"extra":                        emptyJSONPayload{},
		"reminderDays":                 3,
		"repeatReminderEnabled":        false,
		"repeatReminderInterval":       defaultRepeatReminderInterval,
		"repeatReminderWindow":         defaultRepeatReminderWindow,
	})
	for key, value := range overrides {
		record.Set(key, value)
	}
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func applyRouteTestAuth(req *http.Request, token string) {
	if token == "" {
		if strings.HasPrefix(req.URL.Path, "/api/app/") && isUnsafeHTTPMethod(req.Method) {
			applyRouteTestSameOrigin(req)
		}
		return
	}
	if strings.HasPrefix(token, routeTestProductSessionPrefix) {
		parts := strings.SplitN(strings.TrimPrefix(token, routeTestProductSessionPrefix), ":", 2)
		req.AddCookie(&http.Cookie{Name: appSessionCookieName, Value: parts[0]})
		if len(parts) == 2 {
			req.AddCookie(&http.Cookie{Name: appCSRFCookieName, Value: parts[1]})
			if isUnsafeHTTPMethod(req.Method) {
				req.Header.Set(appCSRFHeaderName, parts[1])
			}
		}
		if strings.HasPrefix(req.URL.Path, "/api/app/") && isUnsafeHTTPMethod(req.Method) {
			applyRouteTestSameOrigin(req)
		}
		return
	}
	req.Header.Set("Authorization", token)
}

func applyRouteTestSameOrigin(req *http.Request) {
	// 测试请求要模拟浏览器最终到达服务端后的 Origin；先应用 X-Forwarded-Proto，再生成同源头。
	if origin := requestOrigin(req); origin != "" {
		req.Header.Set("Origin", origin)
	}
}

func createRouteTestSuperuser(t *testing.T, app core.App, email string, password string) *core.Record {
	t.Helper()
	superusers, err := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		t.Fatal(err)
	}
	superuser := core.NewRecord(superusers)
	superuser.SetEmail(email)
	superuser.SetPassword(password)
	if err := app.Save(superuser); err != nil {
		t.Fatal(err)
	}
	return superuser
}

func TestPocketBaseInstallerIsDisabled(t *testing.T) {
	event := &core.ServeEvent{
		InstallerFunc: func(core.App, *core.Record, string) error {
			t.Fatal("PocketBase installer should not run for Renewlet")
			return nil
		},
	}

	disablePocketBaseInstaller(event)

	if event.InstallerFunc != nil {
		t.Fatal("expected PocketBase installer to be disabled")
	}
}

func TestProductAPIFallbacksUseErrorEnvelope(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}

	notFound := serveTestRequest(t, app, http.MethodGet, "/api/app/does-not-exist", "", "")
	if notFound.Code != http.StatusNotFound {
		t.Fatalf("expected product API fallback 404, got %d: %s", notFound.Code, notFound.Body.String())
	}
	var notFoundBody apiErrorEnvelope
	if err := json.Unmarshal(notFound.Body.Bytes(), &notFoundBody); err != nil {
		t.Fatal(err)
	}
	if notFoundBody.Error.Code != "NOT_FOUND" {
		t.Fatalf("expected NOT_FOUND envelope, got %#v", notFoundBody)
	}

	wrongMethod := serveTestRequest(t, app, http.MethodPost, "/api/app/health", "", "")
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected product API fallback 405, got %d: %s", wrongMethod.Code, wrongMethod.Body.String())
	}
	var wrongMethodBody apiErrorEnvelope
	if err := json.Unmarshal(wrongMethod.Body.Bytes(), &wrongMethodBody); err != nil {
		t.Fatal(err)
	}
	if wrongMethodBody.Error.Code != "METHOD_NOT_ALLOWED" {
		t.Fatalf("expected METHOD_NOT_ALLOWED envelope, got %#v", wrongMethodBody)
	}
}

func TestSetupRouteHonorsSetupEnabledAndCreatedStatus(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}

	t.Setenv("SETUP_ENABLED", "false")
	res := serveTestRequest(t, app, http.MethodGet, "/api/app/setup", "", "")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"setupEnabled":false`) {
		t.Fatalf("unexpected setup status response %d: %s", res.Code, res.Body.String())
	}

	res = serveTestRequest(t, app, http.MethodPost, "/api/app/setup", `{"name":"Admin","email":"admin@example.com","password":"password123"}`, "")
	if res.Code != http.StatusForbidden {
		t.Fatalf("expected disabled setup to be forbidden, got %d: %s", res.Code, res.Body.String())
	}

	t.Setenv("SETUP_ENABLED", "true")
	res = serveTestRequest(t, app, http.MethodPost, "/api/app/setup", `{"name":"Admin","email":"admin@example.com","password":"password123"}`, "")
	if res.Code != http.StatusCreated {
		t.Fatalf("expected setup create status 201, got %d: %s", res.Code, res.Body.String())
	}

	admin, err := app.FindAuthRecordByEmail("users", "admin@example.com")
	if err != nil {
		t.Fatalf("expected setup admin user: %v", err)
	}
	if admin.GetString("role") != "admin" {
		t.Fatalf("expected setup user role admin, got %q", admin.GetString("role"))
	}
	superuser, err := app.FindAuthRecordByEmail(core.CollectionNameSuperusers, "admin@example.com")
	if err != nil {
		t.Fatalf("expected setup superuser: %v", err)
	}
	if !superuser.ValidatePassword("password123") {
		t.Fatal("expected setup superuser password to match setup password")
	}
}

func TestSetupRouteCreatesAutoSettingsRegardlessOfRequestLocale(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}

	res := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/app/setup", `{"name":"Admin","email":"admin@example.com","password":"password123"}`, "", map[string]string{
		"X-Renewlet-Locale": "zh-CN",
	})
	if res.Code != http.StatusCreated {
		t.Fatalf("expected setup create status 201, got %d: %s", res.Code, res.Body.String())
	}
	admin, err := app.FindAuthRecordByEmail("users", "admin@example.com")
	if err != nil {
		t.Fatalf("expected setup admin user: %v", err)
	}
	if got := settingsRecordLocalePreference(t, app, admin.Id); got != string(autoLocalePreference) {
		t.Fatalf("expected setup settings locale preference auto, got %q", got)
	}
}

func TestSetupRouteDoesNotOverwriteExistingSuperuser(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	createRouteTestSuperuser(t, app, "pb-admin@example.com", "oldpassword123")

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/setup", `{"name":"Admin","email":"admin@example.com","password":"password123"}`, "")
	if res.Code != http.StatusCreated {
		t.Fatalf("expected setup create status 201, got %d: %s", res.Code, res.Body.String())
	}

	existing, err := app.FindAuthRecordByEmail(core.CollectionNameSuperusers, "pb-admin@example.com")
	if err != nil {
		t.Fatalf("expected existing superuser: %v", err)
	}
	if !existing.ValidatePassword("oldpassword123") {
		t.Fatal("expected existing superuser password to remain unchanged")
	}
	if _, err := app.FindAuthRecordByEmail(core.CollectionNameSuperusers, "admin@example.com"); err == nil {
		t.Fatal("expected setup to skip creating a second superuser when one already exists")
	}
	if _, err := app.FindAuthRecordByEmail("users", "admin@example.com"); err != nil {
		t.Fatalf("expected setup admin user to still be created: %v", err)
	}
}

func TestAssetsCollectionCreateAcceptsSvgUpload(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUserWithPocketBaseToken(t, app, "authenticated")

	res := serveMultipartTestRequest(
		t,
		app,
		"/api/collections/assets/records",
		token,
		map[string]string{
			"user": user.Id,
			"kind": "logo",
		},
		"file",
		"logo.svg",
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`,
	)

	if res.Code != http.StatusOK {
		t.Fatalf("expected SVG asset create 200, got %d: %s", res.Code, res.Body.String())
	}
	var body struct {
		MimeType string `json:"mimeType"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.MimeType != "image/svg+xml" {
		t.Fatalf("mimeType = %q, want image/svg+xml", body.MimeType)
	}
}

func TestAssetsCollectionCreateAcceptsIcoUpload(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUserWithPocketBaseToken(t, app, "authenticated")

	res := serveMultipartTestRequest(
		t,
		app,
		"/api/collections/assets/records",
		token,
		map[string]string{
			"user": user.Id,
			"kind": "logo",
		},
		"file",
		"logo.ico",
		"\x00\x00\x01\x00\x01\x00\x10\x10\x00\x00",
	)

	if res.Code != http.StatusOK {
		t.Fatalf("expected ICO asset create 200, got %d: %s", res.Code, res.Body.String())
	}
	var body struct {
		MimeType string `json:"mimeType"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.MimeType != "image/x-icon" {
		t.Fatalf("mimeType = %q, want image/x-icon", body.MimeType)
	}
}

func TestSubscriptionsCollectionCreateAcceptsPrivateAssetLogoPath(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUserWithPocketBaseToken(t, app, "authenticated")

	uploadRes := serveMultipartTestRequest(
		t,
		app,
		"/api/collections/assets/records",
		token,
		map[string]string{
			"user": user.Id,
			"kind": "logo",
		},
		"file",
		"logo.svg",
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`,
	)
	if uploadRes.Code != http.StatusOK {
		t.Fatalf("expected SVG asset create 200, got %d: %s", uploadRes.Code, uploadRes.Body.String())
	}
	var uploadBody struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(uploadRes.Body.Bytes(), &uploadBody); err != nil {
		t.Fatal(err)
	}
	if uploadBody.ID == "" {
		t.Fatalf("expected uploaded asset id: %s", uploadRes.Body.String())
	}

	logoPath := "/api/app/assets/" + uploadBody.ID
	createRes := serveTestRequest(
		t,
		app,
		http.MethodPost,
		"/api/collections/subscriptions/records",
		fmt.Sprintf(`{
			"user":%q,
			"name":"test",
			"logo":%q,
			"price":"0",
			"currency":"CNY",
			"billingCycle":"monthly",
			"customDays":null,
			"category":"productivity",
			"status":"active",
			"paymentMethod":null,
			"startDate":"2026-05-15",
			"nextBillingDate":"2026-06-15",
			"autoCalculateNextBillingDate":true,
			"trialEndDate":null,
			"website":null,
			"notes":null,
			"tags":[],
			"reminderDays":3
		}`, user.Id, logoPath),
		token,
	)
	if createRes.Code != http.StatusOK {
		t.Fatalf("expected subscription create 200, got %d: %s", createRes.Code, createRes.Body.String())
	}
	var createBody struct {
		Logo string `json:"logo"`
	}
	if err := json.Unmarshal(createRes.Body.Bytes(), &createBody); err != nil {
		t.Fatal(err)
	}
	if createBody.Logo != logoPath {
		t.Fatalf("subscription logo = %q, want %q", createBody.Logo, logoPath)
	}
}

func TestSubscriptionsCollectionCreateValidatesLogoURLContract(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUserWithPocketBaseToken(t, app, "logo-url")

	createBody := func(logo string) string {
		return fmt.Sprintf(`{
			"user":%q,
			"name":"logo-url-test",
			"logo":%q,
			"price":"0",
			"currency":"CNY",
			"billingCycle":"monthly",
			"customDays":null,
			"category":"productivity",
			"status":"active",
			"paymentMethod":null,
			"startDate":"2026-05-15",
			"nextBillingDate":"2026-06-15",
			"autoCalculateNextBillingDate":true,
			"trialEndDate":null,
			"website":null,
			"notes":null,
			"tags":[],
			"reminderDays":3
		}`, user.Id, logo)
	}

	for _, logo := range []string{"https://example.com/logo.png", "http://example.com/logo.png"} {
		res := serveTestRequest(t, app, http.MethodPost, "/api/collections/subscriptions/records", createBody(logo), token)
		if res.Code != http.StatusOK {
			t.Fatalf("expected logo %q to be accepted, got %d: %s", logo, res.Code, res.Body.String())
		}
	}
	for _, logo := range []string{"data:image/png;base64,aGVsbG8=", "https://user:pass@example.com/logo.png"} {
		res := serveTestRequest(t, app, http.MethodPost, "/api/collections/subscriptions/records", createBody(logo), token)
		if res.Code == http.StatusOK {
			t.Fatalf("expected logo %q to be rejected, got %d: %s", logo, res.Code, res.Body.String())
		}
	}
}

func TestSetupRouteRejectsStrictJSONViolations(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		body string
	}{
		{
			name: "unknown field",
			body: `{"name":"Admin","email":"admin@example.com","password":"password123","extra":true}`,
		},
		{
			name: "multiple json values",
			body: `{"name":"Admin","email":"admin@example.com","password":"password123"} {}`,
		},
		{
			name: "empty body",
			body: ``,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := serveTestRequest(t, app, http.MethodPost, "/api/app/setup", tc.body, "")
			if res.Code != http.StatusBadRequest {
				t.Fatalf("expected setup strict JSON violation to return 400, got %d: %s", res.Code, res.Body.String())
			}
		})
	}
}

func TestSetupRouteIgnoresPocketBaseInstallerSuperuser(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	createRouteTestSuperuser(t, app, core.DefaultInstallerEmail, "installerpassword123")

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/setup", `{"name":"Admin","email":"admin@example.com","password":"password123"}`, "")
	if res.Code != http.StatusCreated {
		t.Fatalf("expected setup create status 201, got %d: %s", res.Code, res.Body.String())
	}

	superuser, err := app.FindAuthRecordByEmail(core.CollectionNameSuperusers, "admin@example.com")
	if err != nil {
		t.Fatalf("expected real setup superuser: %v", err)
	}
	if !superuser.ValidatePassword("password123") {
		t.Fatal("expected real setup superuser password to match setup password")
	}
}
