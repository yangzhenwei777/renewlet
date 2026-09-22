package main

// 图标索引 route 测试保护管理员边界、空 body 契约、失败不切 active，以及媒体候选切换 runtime resolver。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMediaIconIndexStatusRequiresAdmin(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, userToken := createRouteTestUser(t, app, "user")
	_, adminToken := createRouteTestUser(t, app, "admin")

	cases := []struct {
		name     string
		token    string
		wantCode int
	}{
		{name: "anonymous", token: "", wantCode: http.StatusUnauthorized},
		{name: "non admin", token: userToken, wantCode: http.StatusForbidden},
		{name: "admin", token: adminToken, wantCode: http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := serveTestRequest(t, app, http.MethodGet, "/api/app/admin/media/icon-index", "", tc.token)
			if res.Code != tc.wantCode {
				t.Fatalf("expected status %d, got %d: %s", tc.wantCode, res.Code, res.Body.String())
			}
		})
	}
}

func TestMediaIconIndexRefreshUsesStrictEmptyBody(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, adminToken := createRouteTestUser(t, app, "admin")

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/media/icon-index/providers/thesvg/refresh", `{}`, adminToken)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("expected refresh with JSON body to return 400, got %d: %s", res.Code, res.Body.String())
	}
}

func TestMediaIconIndexStatusUsesSeedProviderVersions(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, adminToken := createRouteTestUser(t, app, "admin")

	res := serveTestRequest(t, app, http.MethodGet, "/api/app/admin/media/icon-index", "", adminToken)
	if res.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", res.Code, res.Body.String())
	}
	status := decodeAPISuccessDataForTest[builtInIconIndexStatusResponse](t, res.Body.Bytes())
	assertSeedProviderVersions(t, status, nil)
}

func TestMediaIconIndexStatusDoesNotLoadEmbeddedSearchIndex(t *testing.T) {
	_, _ = loadEmbeddedBuiltInResolver()
	embeddedBuiltInResolverCache.Lock()
	embeddedBuiltInResolverCache.hash = ""
	embeddedBuiltInResolverCache.resolver = builtInResolverIndex{}
	embeddedBuiltInResolverCache.loaded = false
	embeddedBuiltInResolverCache.Unlock()

	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	status := builtInIconIndexStatus(app)
	if status.Source != "embedded" || status.IconCount == 0 || status.ProviderCounts.TheSVG == 0 {
		t.Fatalf("expected metadata-backed embedded status, got %#v", status)
	}
	embeddedBuiltInResolverCache.RLock()
	loaded := embeddedBuiltInResolverCache.loaded
	embeddedBuiltInResolverCache.RUnlock()
	if loaded {
		t.Fatal("expected status read to avoid loading embedded search index")
	}
}

func TestMediaIconIndexCheckProviderDoesNotSwitchActive(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, adminToken := createRouteTestUser(t, app, "admin")

	server := newMediaIconRegistryServer(t, http.StatusOK)
	withBuiltInIconGitHubBase(t, server.URL)
	res := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/media/icon-index/providers/thesvg/check", "", adminToken)
	if res.Code != http.StatusOK {
		t.Fatalf("expected check success 200, got %d: %s", res.Code, res.Body.String())
	}
	response := decodeAPISuccessDataForTest[builtInIconIndexProviderCheckResponse](t, res.Body.Bytes())
	if response.Status.Source != "embedded" || response.Status.Refreshing || response.Provider.Refreshing || response.Provider.Latest == nil || response.Provider.Latest.CommitSHA == nil || response.Provider.Latest.ReleaseTag == nil {
		t.Fatalf("unexpected check status: %#v", response.Status)
	}
	if *response.Provider.Latest.ReleaseTag != "thesvg@9.9.9" {
		t.Fatalf("expected TheSVG release tag from Atom feed, got %#v", response.Provider.Latest.ReleaseTag)
	}
	record, err := findMediaIconIndexRecord(app)
	if err != nil {
		t.Fatal(err)
	}
	if record == nil || record.GetString("hash") != "" || record.GetString("searchIndexGzipBase64") != "" || record.GetString("detailIndexGzipBase64") != "" {
		t.Fatalf("expected check to keep active index empty, got %#v", record)
	}
}

func TestMediaIconIndexCheckProviderRecordsAtomFailureWithoutSwitchingActive(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, adminToken := createRouteTestUser(t, app, "admin")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "atom feed unavailable", http.StatusTooManyRequests)
	}))
	defer server.Close()
	withBuiltInIconGitHubBase(t, server.URL)

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/media/icon-index/providers/selfhst/check", "", adminToken)
	if res.Code != http.StatusOK {
		t.Fatalf("expected failed check to keep a usable 200 response, got %d: %s", res.Code, res.Body.String())
	}
	response := decodeAPISuccessDataForTest[builtInIconIndexProviderCheckResponse](t, res.Body.Bytes())
	if response.Provider.LastError == nil || !strings.Contains(*response.Provider.LastError, "GitHub commit feed HTTP 429") {
		t.Fatalf("expected Atom feed failure in lastError, got %#v", response.Provider.LastError)
	}
	if response.ErrorDetails == nil || response.ErrorDetails.RawResponseText == nil {
		t.Fatalf("expected one-shot upstream details, got %#v", response.ErrorDetails)
	}
	if !strings.Contains(*response.ErrorDetails.RawResponseText, "atom feed unavailable") {
		t.Fatalf("expected redacted upstream body, got %#v", response.ErrorDetails.RawResponseText)
	}
	record, err := findMediaIconIndexRecord(app)
	if err != nil {
		t.Fatal(err)
	}
	if record == nil || record.GetString("hash") != "" || record.GetString("searchIndexGzipBase64") != "" || record.GetString("detailIndexGzipBase64") != "" {
		t.Fatalf("expected failed check to keep active index empty, got %#v", record)
	}
	providerStatusPayload, _ := json.Marshal(record.Get("providerStatus"))
	if strings.Contains(string(providerStatusPayload), "atom feed unavailable") {
		t.Fatalf("provider status persisted raw upstream details: %s", providerStatusPayload)
	}
}

func TestMediaIconIndexCheckUsesAtomETagWithoutCallingRestAPI(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, adminToken := createRouteTestUser(t, app, "admin")
	cached := providerVersionForTest("abc1234567890abcdef")
	record, err := mediaIconIndexRecord(app)
	if err != nil {
		t.Fatal(err)
	}
	states := emptyProviderStates()
	state := states["selfhst"]
	state.Latest = cached
	state.ETag = `"cached"`
	states["selfhst"] = state
	record.Set("providerStatus", states)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/repos/") {
			t.Fatalf("provider check must not call GitHub REST path %s", r.URL.Path)
		}
		if r.Header.Get("If-None-Match") != `"cached"` {
			t.Fatalf("expected Atom ETag conditional request, got %q", r.Header.Get("If-None-Match"))
		}
		if r.Header.Get("User-Agent") == "" {
			t.Fatal("expected Atom request user agent")
		}
		if r.URL.Path != "/selfhst/icons/commits/main.atom" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("ETag", `"cached"`)
		w.WriteHeader(http.StatusNotModified)
	}))
	defer server.Close()
	withBuiltInIconGitHubBase(t, server.URL)

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/media/icon-index/providers/selfhst/check", "", adminToken)
	if res.Code != http.StatusOK {
		t.Fatalf("expected check success 200, got %d: %s", res.Code, res.Body.String())
	}
	response := decodeAPISuccessDataForTest[builtInIconIndexProviderCheckResponse](t, res.Body.Bytes())
	if response.Provider.Latest == nil || response.Provider.Latest.CommitSHA == nil || *response.Provider.Latest.CommitSHA != "abc1234567890abcdef" {
		t.Fatalf("expected cached latest on Atom 304, got %#v", response.Provider.Latest)
	}
}

func TestMediaIconIndexRefreshSuccessAndFailureKeepsPreviousRuntimeIndex(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, adminToken := createRouteTestUser(t, app, "admin")

	successServer := newMediaIconRegistryServer(t, http.StatusOK)
	withMediaResolverProviderBase(t, successServer.URL)
	withBuiltInIconGitHubBase(t, successServer.URL)
	res := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/media/icon-index/providers/thesvg/refresh", "", adminToken)
	if res.Code != http.StatusOK {
		t.Fatalf("expected refresh success 200, got %d: %s", res.Code, res.Body.String())
	}
	success := decodeAPISuccessDataForTest[builtInIconIndexProviderRefreshResponse](t, res.Body.Bytes())
	if success.Status.Source != "runtime" || success.Status.Refreshing || success.Provider.Refreshing || success.Status.ProviderCounts.TheSVG != 1 || success.Status.Hash == nil || success.Provider.Current == nil || success.Provider.Current.CommitSHA == nil {
		t.Fatalf("unexpected success status: %#v", success.Status)
	}
	if success.Job.Status != "succeeded" || success.Job.Provider != "thesvg" || success.Job.Attempts != 1 || success.Job.IndexHash == nil || *success.Job.IndexHash != *success.Status.Hash {
		t.Fatalf("expected Docker refresh to return succeeded job with active hash, got %#v", success.Job)
	}
	assertSeedProviderVersions(t, success.Status, map[string]bool{"thesvg": true})
	activeHash := *success.Status.Hash

	failingServer := newMediaIconRegistryServer(t, http.StatusInternalServerError)
	withMediaResolverProviderBase(t, failingServer.URL)
	withBuiltInIconGitHubBase(t, failingServer.URL)
	res = serveTestRequest(t, app, http.MethodPost, "/api/app/admin/media/icon-index/providers/thesvg/refresh", "", adminToken)
	if res.Code != http.StatusBadGateway {
		t.Fatalf("expected refresh failure 502, got %d: %s", res.Code, res.Body.String())
	}
	var failure apiErrorEnvelope
	if err := json.Unmarshal(res.Body.Bytes(), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Error.Code != "MEDIA_ICON_INDEX_REFRESH_FAILED" {
		t.Fatalf("expected refresh failure error code, got %#v", failure)
	}
	details, ok := failure.Error.Details.(map[string]any)
	rawResponseText, rawOK := details["rawResponseText"].(string)
	if !ok || !rawOK || !strings.Contains(rawResponseText, "registry failed") {
		t.Fatalf("expected current error response to include upstream details, got %#v", failure.Error.Details)
	}
	failureStatus := builtInIconIndexStatus(app)
	failureProvider := providerStatusFromResponse(failureStatus, "thesvg")
	if failureStatus.Source != "runtime" || failureStatus.Refreshing || failureProvider.Refreshing || failureStatus.Hash == nil || *failureStatus.Hash != activeHash {
		t.Fatalf("expected failure to keep old active hash %q, got %#v", activeHash, failureStatus)
	}
	if failureProvider.LastError == nil || *failureProvider.LastError == "" {
		t.Fatalf("expected failure status to expose last error, got %#v", failureStatus)
	}
	if failureProvider.Current == nil || failureProvider.Current.CommitSHA == nil || *failureProvider.Current.CommitSHA != *success.Provider.Current.CommitSHA {
		t.Fatalf("expected failed refresh to keep previous current version, got %#v", failureProvider.Current)
	}
}

func TestMediaIconIndexCheckIgnoresRefreshOperationLock(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, adminToken := createRouteTestUser(t, app, "admin")
	server := newMediaIconRegistryServer(t, http.StatusOK)
	withBuiltInIconGitHubBase(t, server.URL)

	if !acquireBuiltInIconIndexOperation("thesvg") {
		t.Fatal("expected to acquire refresh operation lock")
	}
	defer releaseBuiltInIconIndexOperation()

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/media/icon-index/providers/selfhst/check", "", adminToken)
	if res.Code != http.StatusOK {
		t.Fatalf("expected check to ignore refresh lock and return 200, got %d: %s", res.Code, res.Body.String())
	}
	response := decodeAPISuccessDataForTest[builtInIconIndexProviderCheckResponse](t, res.Body.Bytes())
	if response.Provider.Provider != "selfhst" || response.Provider.Latest == nil || response.Provider.Latest.CommitSHA == nil {
		t.Fatalf("expected check to update provider latest while refresh lock is held, got %#v", response.Provider)
	}
	if !response.Status.Refreshing {
		t.Fatalf("expected status to still report the active refresh operation, got %#v", response.Status)
	}
}

func TestMediaIconIndexRefreshReportsConcurrentLock(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, adminToken := createRouteTestUser(t, app, "admin")

	builtInIconIndexRefreshMu.Lock()
	defer builtInIconIndexRefreshMu.Unlock()

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/admin/media/icon-index/providers/thesvg/refresh", "", adminToken)
	if res.Code != http.StatusConflict {
		t.Fatalf("expected locked refresh 409, got %d: %s", res.Code, res.Body.String())
	}
	var response apiErrorEnvelope
	if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Error.Code != "MEDIA_ICON_INDEX_REFRESHING" {
		t.Fatalf("expected locked refresh error code, got %#v", response)
	}
}

func TestMediaCandidatesUseRuntimeIconIndex(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "user")

	icons := []builtInIcon{iconRecord(builtInIcon{
		Provider: "thesvg",
		Slug:     "runtime-only",
		Title:    "Runtime Only",
		Variants: []builtInIconVariant{{Name: "default", Path: "/public/icons/runtime-only/default.svg"}},
	})}
	encoded, err := encodeBuiltInIconIndex(icons)
	if err != nil {
		t.Fatal(err)
	}
	commit := "abc1234567890abcdef"
	short := "abc1234"
	version := &builtInIconProviderVersionResponse{
		SourceRef:          commit,
		DisplayVersion:     short,
		CommitSHA:          &commit,
		CommitShortSHA:     &short,
		CommitDate:         nil,
		ReleaseTag:         nil,
		ReleasePublishedAt: nil,
	}
	if err := saveMediaIconProviderRefreshSuccess(app, "thesvg", "2026-06-11T00:00:00Z", encoded, icons, version, ""); err != nil {
		t.Fatal(err)
	}

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/media/candidates", `{"kind":"logo","mode":"search","items":[{"id":"runtime","name":"Runtime Only"}],"limit":4}`, token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected media candidates 200, got %d: %s", res.Code, res.Body.String())
	}
	response := decodeAPISuccessDataForTest[mediaCandidateResolveResponse](t, res.Body.Bytes())
	if len(response.Items) != 1 || len(response.Items[0].Candidates.BuiltIn) == 0 {
		t.Fatalf("expected runtime built-in candidate, got %#v", response)
	}
	candidate := response.Items[0].Candidates.BuiltIn[0]
	if candidate.Label != "Runtime Only" || candidate.Provider != "thesvg" || candidate.MatchedQuery != "runtime only" {
		t.Fatalf("unexpected runtime candidate: %#v", candidate)
	}
}

func assertSeedProviderVersions(t *testing.T, status builtInIconIndexStatusResponse, skip map[string]bool) {
	t.Helper()
	for _, provider := range status.Providers {
		if skip != nil && skip[provider.Provider] {
			continue
		}
		if provider.Current == nil || provider.Current.CommitSHA == nil || provider.Current.CommitShortSHA == nil || provider.Current.CommitDate == nil {
			t.Fatalf("expected %s to expose seed commit metadata, got %#v", provider.Provider, provider.Current)
		}
		if provider.Current.SourceRef == "embedded" || provider.Current.SourceRef == "runtime" {
			t.Fatalf("expected %s current version to use a real commit sourceRef, got %#v", provider.Provider, provider.Current)
		}
		if len(*provider.Current.CommitShortSHA) != 7 {
			t.Fatalf("expected %s short sha length 7, got %q", provider.Provider, *provider.Current.CommitShortSHA)
		}
	}
}

func newMediaIconRegistryServer(t *testing.T, statusCode int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if statusCode != http.StatusOK {
			http.Error(w, "registry failed", statusCode)
			return
		}
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/glincker/thesvg/commits/main.atom", "/selfhst/icons/commits/main.atom", "/homarr-labs/dashboard-icons/commits/main.atom":
			w.Header().Set("content-type", "application/atom+xml")
			_, _ = w.Write([]byte(gitHubCommitAtomFixture("abc1234567890abcdef", "2026-06-11T00:00:00Z")))
		case "/glincker/thesvg/releases.atom":
			w.Header().Set("content-type", "application/atom+xml")
			_, _ = w.Write([]byte(gitHubReleaseAtomFixture("thesvg@9.9.9", "2026-06-11T00:00:00Z")))
		case "/src/data/icons.json":
			_, _ = w.Write([]byte(`[{"slug":"go-registry","title":"Go Registry","variants":{"default":"/icons/go-registry/default.svg"}}]`))
		case "/index.json":
			_, _ = w.Write([]byte(`[{"Reference":"go-selfhst","Name":"Go selfh.st","SVG":"Yes","Light":"N","Dark":"N"}]`))
		case "/metadata.json":
			_, _ = w.Write([]byte(`{"go-dashboard":{"aliases":["Go Dashboard"],"categories":["Test"]}}`))
		case "/tree.json":
			_, _ = w.Write([]byte(`{"svg":["go-dashboard.svg"]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func gitHubCommitAtomFixture(sha string, updated string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Grit::Commit/` + sha + `</id>
    <updated>` + updated + `</updated>
  </entry>
</feed>`
}

func gitHubReleaseAtomFixture(tag string, updated string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <link type="text/html" rel="alternate" href="https://github.com/glincker/thesvg/releases/tag/` + strings.ReplaceAll(tag, "@", "%40") + `"/>
    <updated>` + updated + `</updated>
  </entry>
</feed>`
}

func providerVersionForTest(commit string) *builtInIconProviderVersionResponse {
	short := commit
	if len(short) > 7 {
		short = short[:7]
	}
	updated := "2026-06-11T00:00:00Z"
	return &builtInIconProviderVersionResponse{
		SourceRef:      commit,
		DisplayVersion: short,
		CommitSHA:      &commit,
		CommitShortSHA: &short,
		CommitDate:     &updated,
	}
}

func withMediaResolverProviderBase(t *testing.T, base string) {
	t.Helper()
	previous := mediaResolverCfg.BuiltInProviders
	next := make([]struct {
		Provider string `json:"provider"`
		CDNBase  string `json:"cdnBase"`
		GitHub   struct {
			Owner         string `json:"owner"`
			Repo          string `json:"repo"`
			Branch        string `json:"branch"`
			LatestRelease bool   `json:"latestRelease"`
		} `json:"github"`
		PreferredVariants []string `json:"preferredVariants"`
	}, len(previous))
	copy(next, previous)
	for index := range next {
		next[index].CDNBase = base
	}
	mediaResolverCfg.BuiltInProviders = next
	t.Cleanup(func() {
		mediaResolverCfg.BuiltInProviders = previous
	})
}

func withBuiltInIconGitHubBase(t *testing.T, base string) {
	t.Helper()
	previous := builtInIconGitHubBase
	builtInIconGitHubBase = base
	t.Cleanup(func() {
		builtInIconGitHubBase = previous
	})
}
