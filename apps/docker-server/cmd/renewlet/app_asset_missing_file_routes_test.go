package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAssetProductAPIDeleteRemovesMetadataWhenFileIsMissing(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	_, token := createRouteTestUser(t, app, "assets-missing-file")

	upload := serveMultipartTestRequest(
		t,
		app,
		"/api/app/assets",
		token,
		map[string]string{"kind": "logo"},
		"file",
		"missing.svg",
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`,
	)
	if upload.Code != http.StatusCreated {
		t.Fatalf("expected asset upload 201, got %d: %s", upload.Code, upload.Body.String())
	}
	uploaded := decodeAPISuccessDataForTest[uploadAssetResponse](t, upload.Body.Bytes())
	id := strings.TrimPrefix(uploaded.URL, "/api/app/assets/")
	record, err := app.FindRecordById("assets", id)
	if err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(app.DataDir(), "storage", record.Collection().Id, record.Id, record.GetString("file"))
	if err := os.Remove(filePath); err != nil {
		t.Fatal(err)
	}

	del := serveTestRequest(t, app, http.MethodDelete, "/api/app/assets/"+id, "", token)
	if del.Code != http.StatusOK {
		t.Fatalf("expected missing-file asset delete 200, got %d: %s", del.Code, del.Body.String())
	}
	if _, err := app.FindRecordById("assets", id); err == nil {
		t.Fatalf("expected missing-file asset metadata to be deleted")
	}
}
