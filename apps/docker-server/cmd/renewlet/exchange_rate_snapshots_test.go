package main

// 汇率快照测试保护“当前月登录态 capture”和“历史月只能从 Renewlet ZIP 恢复”的边界。

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestExchangeRateSnapshotRoutesCaptureCurrentMonthOnly(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	_, token := createRouteTestUser(t, app, "exchange-rates")
	currentMonth := time.Now().UTC().Format("2006-01")

	putRes := serveTestRequest(t, app, http.MethodPut, "/api/app/exchange-rate-snapshots/"+currentMonth, exchangeRateSnapshotTestBody(t), token)
	if putRes.Code != http.StatusOK {
		t.Fatalf("expected current month capture 200, got %d: %s", putRes.Code, putRes.Body.String())
	}
	putBody := decodeAPISuccessDataForTest[exchangeRateSnapshotResponse](t, putRes.Body.Bytes())
	if putBody.Snapshot.Month != currentMonth || putBody.Snapshot.Provider != "frankfurter" || putBody.Snapshot.Rates["USD"] != 1 {
		t.Fatalf("unexpected snapshot response: %#v", putBody.Snapshot)
	}

	listRes := serveTestRequest(t, app, http.MethodGet, "/api/app/exchange-rate-snapshots?from="+currentMonth+"&to="+currentMonth, "", token)
	if listRes.Code != http.StatusOK {
		t.Fatalf("expected snapshot list 200, got %d: %s", listRes.Code, listRes.Body.String())
	}
	listBody := decodeAPISuccessDataForTest[exchangeRateSnapshotsResponse](t, listRes.Body.Bytes())
	if len(listBody.Snapshots) != 1 || listBody.Snapshots[0].Month != currentMonth {
		t.Fatalf("expected one current month snapshot, got %#v", listBody.Snapshots)
	}

	historyRes := serveTestRequest(t, app, http.MethodPut, "/api/app/exchange-rate-snapshots/2000-01", exchangeRateSnapshotTestBody(t), token)
	if historyRes.Code != http.StatusBadRequest {
		t.Fatalf("expected historical capture to be rejected, got %d: %s", historyRes.Code, historyRes.Body.String())
	}
}

func TestImportRestoresHistoricalExchangeRateSnapshots(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "snapshot-import")
	historical := exchangeRateSnapshotTestDTO("2000-01")
	body := exchangeRateSnapshotImportApplyBody(t, "renewlet", []exchangeRateSnapshotDTO{historical})

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/import/apply", body, token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected import apply 200, got %d: %s", res.Code, res.Body.String())
	}
	response := decodeAPISuccessDataForTest[importApplyResponse](t, res.Body.Bytes())
	if !response.IncludesExchangeRateSnapshots || response.ExchangeRateSnapshotsCount != 1 {
		t.Fatalf("expected preview response to include snapshot count, got %#v", response.importPreviewResponse)
	}
	snapshots, err := listExchangeRateSnapshots(app, user.Id, "2000-01", "2000-01")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || snapshots[0].Month != "2000-01" || snapshots[0].Rates["CNY"] != 7 {
		t.Fatalf("expected restored historical snapshot, got %#v", snapshots)
	}
}

func TestImportRejectsExchangeRateSnapshotsFromNonRenewletSources(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	_, token := createRouteTestUser(t, app, "snapshot-source")

	res := serveTestRequest(
		t,
		app,
		http.MethodPost,
		"/api/app/import/preview",
		exchangeRateSnapshotImportApplyBody(t, "wallos", []exchangeRateSnapshotDTO{exchangeRateSnapshotTestDTO("2000-01")}),
		token,
	)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("expected non-renewlet snapshot payload to be rejected, got %d: %s", res.Code, res.Body.String())
	}
}

func exchangeRateSnapshotTestBody(t *testing.T) string {
	t.Helper()
	body := exchangeRateSnapshotBody{
		Base:              "USD",
		Rates:             map[string]float64{"USD": 1, "CNY": 7},
		RequestedProvider: "frankfurter",
		Provider:          "frankfurter",
		SourceDate:        "2026-08-01",
		Warning: &exchangeRateCoverageWarningDTO{
			Kind:              "partial",
			Provider:          "frankfurter",
			MissingCurrencies: []string{"JPY"},
			FillSources:       map[string]string{"JPY": "builtin"},
		},
	}
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func exchangeRateSnapshotTestDTO(month string) exchangeRateSnapshotDTO {
	return exchangeRateSnapshotDTO{
		SchemaVersion:     1,
		Month:             month,
		Base:              "USD",
		Rates:             map[string]float64{"USD": 1, "CNY": 7},
		RequestedProvider: "floatrates",
		Provider:          "floatrates",
		SourceDate:        "2000-01-31",
		CapturedAt:        "2000-02-01T00:00:00Z",
	}
}

func exchangeRateSnapshotImportApplyBody(t *testing.T, source string, snapshots []exchangeRateSnapshotDTO) string {
	t.Helper()
	body := map[string]interface{}{
		"conflictMode": "skip",
		"payload": map[string]interface{}{
			"source":                source,
			"subscriptions":         []interface{}{},
			"exchangeRateSnapshots": snapshots,
		},
	}
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
