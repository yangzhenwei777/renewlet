package main

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestEnsureSchemaCreatesExchangeRateSnapshotContract(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}

	assertFields(t, app, "exchange_rate_snapshots", map[string]string{
		"user":              core.FieldTypeRelation,
		"reportMonth":       core.FieldTypeText,
		"base":              core.FieldTypeText,
		"rates":             core.FieldTypeJSON,
		"requestedProvider": core.FieldTypeSelect,
		"provider":          core.FieldTypeSelect,
		"sourceDate":        core.FieldTypeText,
		"capturedAt":        core.FieldTypeText,
		"warning":           core.FieldTypeJSON,
		"created":           core.FieldTypeAutodate,
		"updated":           core.FieldTypeAutodate,
	})
	assertSelectFieldValues(t, app, "exchange_rate_snapshots", "requestedProvider", "frankfurter", "floatrates", "exchange-api")
	assertSelectFieldValues(t, app, "exchange_rate_snapshots", "provider", "frankfurter", "floatrates", "exchange-api")
	assertIndex(t, app, "exchange_rate_snapshots", "idx_exchange_rate_snapshots_user_month_unique")
}
