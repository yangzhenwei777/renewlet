package main

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pocketbase/pocketbase/apis"
)

type customHeadHTMLFixtureSet struct {
	MaxBytes int                         `json:"maxBytes"`
	Cases    []customHeadHTMLFixtureCase `json:"cases"`
}

type customHeadHTMLFixtureCase struct {
	Name    string                       `json:"name"`
	Raw     string                       `json:"raw"`
	Repeat  *customHeadHTMLFixtureRepeat `json:"repeat"`
	Valid   bool                         `json:"valid"`
	Enabled bool                         `json:"enabled"`
}

type customHeadHTMLFixtureRepeat struct {
	Prefix string `json:"prefix"`
	Value  string `json:"value"`
	Count  int    `json:"count"`
	Suffix string `json:"suffix"`
}

func (fixture customHeadHTMLFixtureCase) Value() string {
	if fixture.Repeat == nil {
		return fixture.Raw
	}
	return fixture.Repeat.Prefix + strings.Repeat(fixture.Repeat.Value, fixture.Repeat.Count) + fixture.Repeat.Suffix
}

func loadCustomHeadHTMLFixtures(t *testing.T) customHeadHTMLFixtureSet {
	t.Helper()
	content, err := os.ReadFile("../../../../packages/shared/src/contract-fixtures/custom-head-html-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures customHeadHTMLFixtureSet
	if err := json.Unmarshal(content, &fixtures); err != nil {
		t.Fatal(err)
	}
	return fixtures
}

func TestParseCustomHeadHTMLMatchesSharedFixtures(t *testing.T) {
	fixtures := loadCustomHeadHTMLFixtures(t)
	if fixtures.MaxBytes != customHeadHTMLMaxBytes {
		t.Fatalf("fixture maxBytes = %d, want %d", fixtures.MaxBytes, customHeadHTMLMaxBytes)
	}
	for _, fixture := range fixtures.Cases {
		t.Run(fixture.Name, func(t *testing.T) {
			raw := fixture.Value()
			config, err := parseCustomHeadHTML(raw)
			if fixture.Valid && err != nil {
				t.Fatal(err)
			}
			if !fixture.Valid && err == nil {
				t.Fatal("expected fixture to be rejected")
			}
			if !fixture.Valid {
				return
			}
			if config.Enabled() != fixture.Enabled {
				t.Fatalf("Enabled() = %v, want %v", config.Enabled(), fixture.Enabled)
			}
			if fixture.Enabled && config.Markup != raw {
				t.Fatal("validated markup was not preserved byte-for-byte")
			}
		})
	}
}

func TestCustomHeadHTMLFromEnvFailsInvalidStartupConfiguration(t *testing.T) {
	t.Setenv(customHeadHTMLEnvName, "<body>escaped</body>")
	if _, err := customHeadHTMLFromEnv(); err == nil {
		t.Fatal("expected invalid startup configuration to fail")
	}
}

func TestParseCustomHeadHTMLRejectsInvalidUTF8(t *testing.T) {
	if _, err := parseCustomHeadHTML(string([]byte{0xff})); err == nil {
		t.Fatal("expected invalid UTF-8 to be rejected")
	}
}

func TestPrepareCustomHeadHTMLFSInjectsOnlyIndexAndReportsSize(t *testing.T) {
	raw := "\n<script>window.__renewletCustomHead = '原样';</script>\n"
	config, err := parseCustomHeadHTML(raw)
	if err != nil {
		t.Fatal(err)
	}
	asset := []byte("console.log('app')")
	prepared, err := prepareCustomHeadHTMLFS(fstest.MapFS{
		"index.html":            {Data: []byte("<!doctype html><html><head><title>Renewlet</title></head><body></body></html>")},
		"assets/application.js": {Data: asset},
	}, config)
	if err != nil {
		t.Fatal(err)
	}

	indexFile, err := prepared.Open("index.html")
	if err != nil {
		t.Fatal(err)
	}
	defer indexFile.Close()
	indexHTML, err := io.ReadAll(indexFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(indexHTML), raw) {
		t.Fatalf("custom head HTML was not injected verbatim: %q", string(indexHTML))
	}
	if !strings.Contains(string(indexHTML), raw+"\n</head>") {
		t.Fatalf("custom head HTML was not injected before </head>: %q", string(indexHTML))
	}
	info, err := indexFile.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != int64(len(indexHTML)) {
		t.Fatalf("index size = %d, want %d", info.Size(), len(indexHTML))
	}

	assetFile, err := prepared.Open("assets/application.js")
	if err != nil {
		t.Fatal(err)
	}
	defer assetFile.Close()
	assetContent, err := io.ReadAll(assetFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(assetContent) != string(asset) {
		t.Fatalf("asset changed: %q", assetContent)
	}
}

func TestPrepareCustomHeadHTMLFSRejectsHostWithoutHead(t *testing.T) {
	config, err := parseCustomHeadHTML("<script>window.__loaded = true;</script>")
	if err != nil {
		t.Fatal(err)
	}
	_, err = prepareCustomHeadHTMLFS(fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html><html><body>Renewlet</body></html>")},
	}, config)
	if err == nil {
		t.Fatal("expected missing host head to fail")
	}
}

func TestCustomHeadHTMLConfigurationIsImmutableAfterStartup(t *testing.T) {
	original := "<script>window.__startupValue = 'original';</script>"
	t.Setenv(customHeadHTMLEnvName, original)
	config, err := customHeadHTMLFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(customHeadHTMLEnvName, "<body>changed after startup</body>")

	prepared, err := prepareCustomHeadHTMLFS(fstest.MapFS{
		"index.html": {Data: []byte("<html><head></head><body></body></html>")},
	}, config)
	if err != nil {
		t.Fatal(err)
	}
	content, err := fs.ReadFile(prepared, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), original) || strings.Contains(string(content), "changed after startup") {
		t.Fatalf("prepared index did not keep startup configuration: %q", content)
	}
}

func TestCustomHeadHTMLStaticFallbackAndContentSecurityPolicy(t *testing.T) {
	config, err := parseCustomHeadHTML("<script>window.__loaded = true;</script>")
	if err != nil {
		t.Fatal(err)
	}
	app := newSchemaTestApp(t)
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := registerStaticFallback(router, fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><html><head></head><body>renewlet-spa</body></html>")},
		"assets/app.js": {Data: []byte("console.log('app')")},
	}, config); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	serve := func(method string, target string, https bool) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, target, nil)
		if https {
			request.Header.Set("X-Forwarded-Proto", "https")
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		return response
	}

	for _, target := range []string{"/", "/settings"} {
		response := serve(http.MethodGet, target, false)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), config.Markup) {
			t.Fatalf("%s did not serve the injected index: %d %q", target, response.Code, response.Body.String())
		}
		if response.Header().Get("Content-Length") != strconv.Itoa(response.Body.Len()) {
			t.Fatalf("%s Content-Length = %q, want %d", target, response.Header().Get("Content-Length"), response.Body.Len())
		}
		if got := response.Header().Get("Content-Security-Policy"); got != "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" {
			t.Fatalf("unexpected trusted extension CSP: %q", got)
		}
	}
	indexRedirect := serve(http.MethodGet, "/index.html", false)
	if indexRedirect.Code != http.StatusMovedPermanently {
		t.Fatalf("explicit index URL status = %d, want %d", indexRedirect.Code, http.StatusMovedPermanently)
	}

	assetResponse := serve(http.MethodGet, "/assets/app.js", false)
	if assetResponse.Body.String() != "console.log('app')" {
		t.Fatalf("asset changed: %q", assetResponse.Body.String())
	}
	httpsResponse := serve(http.MethodGet, "/", true)
	if got := httpsResponse.Header().Get("Content-Security-Policy"); got != "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests" {
		t.Fatalf("unexpected HTTPS trusted extension CSP: %q", got)
	}
}
