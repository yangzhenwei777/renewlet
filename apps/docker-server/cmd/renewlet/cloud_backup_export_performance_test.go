package main

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestCloudBackupExportPerformance(t *testing.T) {
	if os.Getenv("RENEWLET_PERF_TEST") != "1" {
		t.Skip("set RENEWLET_PERF_TEST=1 for local allocation and CPU sampling")
	}
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "export-performance")
	if err := app.RunInTransaction(func(tx core.App) error {
		for index := range 1000 {
			createRouteTestSubscription(t, tx, user.Id, map[string]interface{}{"name": fmt.Sprintf("Subscription %04d", index), "price": "123456789.012345"})
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)
	result := testing.Benchmark(func(b *testing.B) {
		for b.Loop() {
			bundle, err := buildCloudBackupExportBundle(app, user, now)
			if err != nil || bundle.Manifest.Subscriptions != 1000 {
				b.Fatalf("export: subscriptions=%d err=%v", bundle.Manifest.Subscriptions, err)
			}
		}
	})
	t.Logf("environment=Go+PocketBase-local subscriptions=1000 ns/op=%d B/op=%d allocs/op=%d", result.NsPerOp(), result.AllocedBytesPerOp(), result.AllocsPerOp())
}
