package main

// 系统版本 route 测试单独承载权限投影，避免通用 routes_test 继续膨胀并掩盖更新边界。

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSystemUpdateActionsRequireAdmin(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, userToken := createRouteTestUser(t, app, "user")

	cases := []struct {
		name     string
		method   string
		target   string
		token    string
		wantCode int
	}{
		{name: "anonymous update", method: http.MethodPost, target: "/api/app/admin/system/update", token: "", wantCode: http.StatusUnauthorized},
		{name: "non admin update", method: http.MethodPost, target: "/api/app/admin/system/update", token: userToken, wantCode: http.StatusForbidden},
		{name: "anonymous update status", method: http.MethodGet, target: "/api/app/admin/system/update/status", token: "", wantCode: http.StatusUnauthorized},
		{name: "non admin update status", method: http.MethodGet, target: "/api/app/admin/system/update/status", token: userToken, wantCode: http.StatusForbidden},
		{name: "anonymous restart", method: http.MethodPost, target: "/api/app/admin/system/restart", token: "", wantCode: http.StatusUnauthorized},
		{name: "non admin restart", method: http.MethodPost, target: "/api/app/admin/system/restart", token: userToken, wantCode: http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := ""
			if tc.method == http.MethodPost {
				body = `{}`
			}
			res := serveTestRequest(t, app, tc.method, tc.target, body, tc.token)
			if res.Code != tc.wantCode {
				t.Fatalf("expected system action auth status %d, got %d: %s", tc.wantCode, res.Code, res.Body.String())
			}
		})
	}
}

func TestSystemUpdateRouteReturnsAcceptedAndContinuesAfterRequest(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, adminToken := createRouteTestUser(t, app, "admin")
	service, client, _ := newExecutableSystemUpdateService(t, "1.0.0", "1.1.0")
	client.fetchDelay = 500 * time.Millisecond
	oldService := defaultSystemUpdateService
	defaultSystemUpdateService = service
	t.Cleanup(func() { defaultSystemUpdateService = oldService })

	invalid := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/system/update", `{"unexpected":true}`, adminToken)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("strict update body status = %d, want 400: %s", invalid.Code, invalid.Body.String())
	}
	startedAt := time.Now()
	started := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/system/update", `{}`, adminToken)
	if started.Code != http.StatusAccepted {
		t.Fatalf("update status = %d, want 202: %s", started.Code, started.Body.String())
	}
	if elapsed := time.Since(startedAt); elapsed >= 250*time.Millisecond {
		t.Fatalf("update POST waited for background work: %s", elapsed)
	}
	if started.Header().Get("Location") != "/api/app/admin/system/update/status" || started.Header().Get("Retry-After") != "1" {
		t.Fatalf("missing async response headers: %#v", started.Header())
	}
	if started.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("accepted update response must not be cached: %#v", started.Header())
	}
	startedBody := decodeAPISuccessDataForTest[systemUpdateOperationResponse](t, started.Body.Bytes())
	if startedBody.Operation == nil || startedBody.Operation.Status != systemUpdateStatusRunning {
		t.Fatalf("unexpected accepted operation: %#v", startedBody.Operation)
	}

	repeated := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/system/update", `{}`, adminToken)
	if repeated.Code != http.StatusAccepted {
		t.Fatalf("repeated update status = %d, want 202: %s", repeated.Code, repeated.Body.String())
	}
	repeatedBody := decodeAPISuccessDataForTest[systemUpdateOperationResponse](t, repeated.Body.Bytes())
	if repeatedBody.Operation == nil || repeatedBody.Operation.ID != startedBody.Operation.ID {
		t.Fatalf("repeated update did not reuse task: %#v", repeatedBody.Operation)
	}

	statusStartedAt := time.Now()
	status := serveTestRequest(t, app, http.MethodGet, "/api/app/admin/system/update/status", "", adminToken)
	if status.Code != http.StatusOK || status.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("update status response = %d %#v", status.Code, status.Header())
	}
	if elapsed := time.Since(statusStartedAt); elapsed >= 250*time.Millisecond {
		t.Fatalf("status GET waited for background work: %s", elapsed)
	}
	statusBody := decodeAPISuccessDataForTest[systemUpdateOperationResponse](t, status.Body.Bytes())
	if statusBody.Operation == nil || statusBody.Operation.ID != startedBody.Operation.ID {
		t.Fatalf("status endpoint lost active operation: %#v", statusBody.Operation)
	}

	completed := waitForSystemUpdateTerminal(t, service)
	if completed.Status != systemUpdateStatusSucceeded {
		t.Fatalf("request completion canceled background update: %#v", completed)
	}
}

func TestSystemVersionRouteIsReadableBySignedInUsers(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, adminToken := createRouteTestUser(t, app, "admin")
	_, userToken := createRouteTestUser(t, app, "user")
	tempDir := t.TempDir()
	binaryPath := filepath.Join(tempDir, "renewlet")
	if err := os.WriteFile(binaryPath, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RENEWLET_SELF_UPDATE_ENABLED", "true")
	t.Setenv("RENEWLET_SELF_UPDATE_BINARY", binaryPath)
	t.Setenv("RENEWLET_SELF_UPDATE_BACKUP_DIR", filepath.Join(tempDir, "backups"))
	oldService, oldVersion, oldBuildType := defaultSystemUpdateService, Version, BuildType
	Version, BuildType = "1.0.0", "release"
	release := releaseFixture("v1.1.0")
	defaultSystemUpdateService = newSystemUpdateService(&fakeSystemReleaseClient{release: &release})
	t.Cleanup(func() {
		defaultSystemUpdateService = oldService
		Version, BuildType = oldVersion, oldBuildType
	})
	readOnlyReason := serverText(defaultAppLocale, "auth.adminRequiredShort")

	cases := []struct {
		name     string
		target   string
		token    string
		wantCode int
	}{
		{name: "anonymous", target: "/api/app/system/version", token: "", wantCode: http.StatusUnauthorized},
		{name: "non admin", target: "/api/app/system/version", token: userToken, wantCode: http.StatusOK},
		{name: "admin", target: "/api/app/system/version", token: adminToken, wantCode: http.StatusOK},
		{name: "old admin route removed", target: "/api/app/admin/system/version", token: adminToken, wantCode: http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := serveTestRequest(t, app, http.MethodGet, tc.target, "", tc.token)
			if res.Code != tc.wantCode {
				t.Fatalf("expected version auth status %d, got %d: %s", tc.wantCode, res.Code, res.Body.String())
			}
			if tc.name == "admin" {
				body := decodeAPISuccessDataForTest[systemVersionResponse](t, res.Body.Bytes())
				if !body.HasUpdate || body.LatestVersion != "1.1.0" {
					t.Fatalf("expected admin version response to keep release facts, got %#v", body)
				}
				if !body.UpdateSupported && body.UnsupportedReason == readOnlyReason {
					t.Fatalf("expected admin version response not to be projected as read-only, got %#v", body)
				}
			}
			if tc.name == "non admin" {
				body := decodeAPISuccessDataForTest[systemVersionResponse](t, res.Body.Bytes())
				if body.UpdateSupported || body.UnsupportedReason != readOnlyReason || body.ErrorDetails != nil {
					t.Fatalf("expected non-admin version response to be read-only, got %#v", body)
				}
			}
		})
	}
}

func TestSystemVersionRouteHidesRawDetailsFromNonAdmins(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, adminToken := createRouteTestUser(t, app, "admin")
	_, userToken := createRouteTestUser(t, app, "user")
	oldService, oldVersion, oldBuildType := defaultSystemUpdateService, Version, BuildType
	Version, BuildType = "1.0.0", "release"
	defaultSystemUpdateService = newSystemUpdateService(&httpSystemReleaseClient{
		metadataClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusForbidden,
				Status:     "403 Forbidden",
				Header:     http.Header{"Content-Type": []string{"text/plain"}},
				Body:       io.NopCloser(strings.NewReader("release feed unavailable")),
				Request:    request,
			}, nil
		})},
	})
	t.Cleanup(func() {
		defaultSystemUpdateService = oldService
		Version, BuildType = oldVersion, oldBuildType
	})

	admin := serveTestRequest(t, app, http.MethodGet, "/api/app/system/version?force=true", "", adminToken)
	if admin.Code != http.StatusOK {
		t.Fatalf("expected admin version status 200, got %d: %s", admin.Code, admin.Body.String())
	}
	adminBody := decodeAPISuccessDataForTest[systemVersionResponse](t, admin.Body.Bytes())
	if adminBody.ErrorDetails == nil || adminBody.ErrorDetails.RawResponseText == nil || *adminBody.ErrorDetails.RawResponseText != "release feed unavailable" {
		t.Fatalf("expected admin version response to keep one-shot raw details, got %#v", adminBody.ErrorDetails)
	}

	user := serveTestRequest(t, app, http.MethodGet, "/api/app/system/version?force=true", "", userToken)
	if user.Code != http.StatusOK {
		t.Fatalf("expected non-admin version status 200, got %d: %s", user.Code, user.Body.String())
	}
	userBody := decodeAPISuccessDataForTest[systemVersionResponse](t, user.Body.Bytes())
	if userBody.ErrorDetails != nil || userBody.UpdateSupported || userBody.UnsupportedReason != serverText(defaultAppLocale, "auth.adminRequiredShort") {
		t.Fatalf("expected non-admin version response to hide raw details and update ability, got %#v", userBody)
	}
}
