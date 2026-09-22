package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
)

func TestAssetsProductAPIRejectsOversizedMultipartBeforeSave(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "assets-upload-limit")

	upload := serveMultipartTestRequest(
		t,
		app,
		"/api/app/assets",
		token,
		map[string]string{"kind": "logo"},
		"file",
		"huge.svg",
		strings.Repeat("x", maxAssetUploadBodyBytes+1),
	)
	if upload.Code != http.StatusBadRequest {
		t.Fatalf("expected oversized multipart upload 400, got %d: %s", upload.Code, upload.Body.String())
	}
	rows, err := app.FindRecordsByFilter("assets", "user = {:user}", "", 10, 0, dbx.Params{"user": user.Id})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("oversized multipart upload must not create asset records, got %d", len(rows))
	}
}
