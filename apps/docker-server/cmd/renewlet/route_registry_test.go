package main

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
)

func TestExportProductRouteManifest(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	manifest := registerRoutes(app, router)
	if len(manifest) == 0 {
		t.Fatal("product route manifest is empty")
	}
	fixture := loadSubscriptionCollectionContractFixture(t)
	assertManifestRoute(t, manifest, "/api/app/notifications/overview", http.MethodGet)
	assertManifestRoute(t, manifest, "/api/app/notifications/history", http.MethodGet)
	for _, route := range fixture.ManifestRoutes {
		for _, method := range route.Methods {
			assertManifestRoute(t, manifest, route.Path, method)
		}
	}

	outputPath := os.Getenv("RENEWLET_ROUTE_MANIFEST_OUTPUT")
	if outputPath == "" {
		return
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(outputPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertManifestRoute(t *testing.T, manifest []apiRouteContract, path string, method string) {
	t.Helper()
	for _, route := range manifest {
		if route.Path != path {
			continue
		}
		for _, candidate := range route.Methods {
			if candidate == method {
				return
			}
		}
	}
	t.Fatalf("route manifest is missing %s %s", method, path)
}
