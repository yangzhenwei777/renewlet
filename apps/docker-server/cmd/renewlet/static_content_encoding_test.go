package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pocketbase/pocketbase/apis"
)

func TestSelectStaticRepresentationHonorsQualityAndAvailability(t *testing.T) {
	staticFS := fstest.MapFS{
		"assets/app.js":    {Data: []byte("identity")},
		"assets/app.js.br": {Data: []byte("brotli")},
		"assets/app.js.gz": {Data: []byte("gzip")},
		"assets/app.css":   {Data: []byte("identity-only")},
		"index.html":       {Data: []byte("index")},
	}
	tests := []struct {
		name     string
		filename string
		header   string
		wantFile string
		wantOK   bool
	}{
		{name: "browser preference tie", filename: "assets/app.js", header: "gzip, deflate, br", wantFile: "assets/app.js.br", wantOK: true},
		{name: "quality outranks server preference", filename: "assets/app.js", header: "br;q=0.7, gzip;q=0.9, identity;q=0.5", wantFile: "assets/app.js.gz", wantOK: true},
		{name: "identity keeps its default quality", filename: "assets/app.js", header: "br;q=0.8, gzip;q=0.8", wantFile: "assets/app.js", wantOK: true},
		{name: "wildcard selects brotli on tie", filename: "assets/app.js", header: "*;q=1", wantFile: "assets/app.js.br", wantOK: true},
		{name: "explicit coding overrides wildcard", filename: "assets/app.js", header: "br;q=0, *;q=0.8, identity;q=0.5", wantFile: "assets/app.js.gz", wantOK: true},
		{name: "all representations rejected", filename: "assets/app.js", header: "br;q=0, gzip;q=0, identity;q=0", wantFile: "assets/app.js", wantOK: false},
		{name: "missing sidecars use identity", filename: "assets/app.css", header: "br, gzip", wantFile: "assets/app.css", wantOK: true},
		{name: "SPA fallback rejects unavailable encoding", filename: "settings", header: "identity;q=0, br", wantFile: "settings", wantOK: false},
		{name: "runtime index rejects identity exclusion", filename: "index.html", header: "identity;q=0, br", wantFile: "index.html", wantOK: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/"+test.filename, nil)
			if test.header != "" {
				request.Header.Set("Accept-Encoding", test.header)
			}
			representation, ok := selectStaticRepresentation(request, staticFS, test.filename)
			if representation.filename != test.wantFile || ok != test.wantOK {
				t.Fatalf("selectStaticRepresentation() = (%q, %v), want (%q, %v)", representation.filename, ok, test.wantFile, test.wantOK)
			}
		})
	}
}

func TestParseHTTPQualityRejectsNonCanonicalWeights(t *testing.T) {
	tests := []struct {
		raw  string
		want int
		ok   bool
	}{
		{raw: "0", want: 0, ok: true},
		{raw: "0.25", want: 250, ok: true},
		{raw: "1.000", want: 1000, ok: true},
		{raw: ".5", ok: false},
		{raw: "0.1234", ok: false},
		{raw: "1.1", ok: false},
	}
	for _, test := range tests {
		t.Run(test.raw, func(t *testing.T) {
			got, ok := parseHTTPQuality(test.raw)
			if got != test.want || ok != test.ok {
				t.Fatalf("parseHTTPQuality(%q) = (%d, %v), want (%d, %v)", test.raw, got, ok, test.want, test.ok)
			}
		})
	}
}

func TestStaticContentEncodingResponseContract(t *testing.T) {
	staticFS := fstest.MapFS{
		"index.html":       {Data: []byte("<!doctype html><main>renewlet-spa</main>")},
		"assets/app.js":    {Data: []byte("identity-javascript")},
		"assets/app.js.br": {Data: []byte("brotli-javascript")},
		"assets/app.js.gz": {Data: []byte("gzip-javascript")},
	}
	app := newSchemaTestApp(t)
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := registerStaticFallback(router, staticFS, customHeadHTMLConfig{}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	serve := func(method string, target string, acceptEncoding string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, target, nil)
		if acceptEncoding != "" {
			request.Header.Set("Accept-Encoding", acceptEncoding)
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		return response
	}

	brotli := serve(http.MethodGet, "/assets/app.js", "gzip, br")
	if brotli.Code != http.StatusOK || brotli.Body.String() != "brotli-javascript" {
		t.Fatalf("expected Brotli body, got %d: %q", brotli.Code, brotli.Body.String())
	}
	if brotli.Header().Get("Content-Encoding") != "br" || !strings.Contains(brotli.Header().Get("Content-Type"), "javascript") {
		t.Fatalf("expected Brotli JavaScript headers, got %#v", brotli.Header())
	}
	if brotli.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("expected Accept-Encoding variance, got %q", brotli.Header().Get("Vary"))
	}
	if brotli.Header().Get("Content-Length") != strconv.Itoa(len("brotli-javascript")) {
		t.Fatalf("unexpected Brotli Content-Length: %q", brotli.Header().Get("Content-Length"))
	}

	head := serve(http.MethodHead, "/assets/app.js", "br")
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Encoding") != "br" {
		t.Fatalf("unexpected HEAD response: status=%d body=%q headers=%#v", head.Code, head.Body.String(), head.Header())
	}
	if head.Header().Get("Content-Length") != strconv.Itoa(len("brotli-javascript")) {
		t.Fatalf("unexpected HEAD Content-Length: %q", head.Header().Get("Content-Length"))
	}

	spa := serve(http.MethodGet, "/settings", "br")
	if spa.Code != http.StatusOK || !strings.Contains(spa.Body.String(), "renewlet-spa") {
		t.Fatalf("expected SPA identity fallback, got %d: %q", spa.Code, spa.Body.String())
	}
	if got := spa.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("SPA index must remain identity, got Content-Encoding=%q", got)
	}
	if spa.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("SPA response must vary by Accept-Encoding, got %q", spa.Header().Get("Vary"))
	}

	spaRejected := serve(http.MethodGet, "/settings", "br, identity;q=0")
	if spaRejected.Code != http.StatusNotAcceptable || spaRejected.Body.Len() != 0 {
		t.Fatalf("expected empty 406 when SPA identity is rejected, got %d: %q", spaRejected.Code, spaRejected.Body.String())
	}
	if spaRejected.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("SPA 406 must vary by Accept-Encoding, got %q", spaRejected.Header().Get("Vary"))
	}

	indexRejected := serve(http.MethodGet, "/index.html", "gzip, identity;q=0")
	if indexRejected.Code != http.StatusNotAcceptable || indexRejected.Body.Len() != 0 {
		t.Fatalf("expected empty 406 when runtime index identity is rejected, got %d: %q", indexRejected.Code, indexRejected.Body.String())
	}
	if indexRejected.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("index 406 must vary by Accept-Encoding, got %q", indexRejected.Header().Get("Vary"))
	}

	rejected := serve(http.MethodGet, "/assets/app.js", "br;q=0, gzip;q=0, identity;q=0")
	if rejected.Code != http.StatusNotAcceptable {
		t.Fatalf("expected 406 for rejected representations, got %d: %s", rejected.Code, rejected.Body.String())
	}
	if rejected.Body.Len() != 0 {
		t.Fatalf("expected empty 406 response, got %q", rejected.Body.String())
	}

	identity := serve(http.MethodGet, "/assets/app.js", "")
	if identity.Code != http.StatusOK || identity.Body.String() != "identity-javascript" {
		t.Fatalf("expected identity response without negotiation header, got %d: %q", identity.Code, identity.Body.String())
	}
	if got := identity.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("unexpected identity Content-Encoding=%q", got)
	}
}
