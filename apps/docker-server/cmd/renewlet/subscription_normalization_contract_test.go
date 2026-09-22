package main

// 订阅规范化 fixture 锁住 Go hook 与 Worker D1 mapper 的同一组互斥字段语义。

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

type subscriptionNormalizationFixture struct {
	Name     string                          `json:"name"`
	Input    subscriptionNormalizationFields `json:"input"`
	Expected subscriptionNormalizationFields `json:"expected"`
}

type subscriptionNormalizationFields struct {
	BillingCycle                 string  `json:"billingCycle"`
	CustomDays                   *int    `json:"customDays"`
	CustomCycleUnit              *string `json:"customCycleUnit"`
	OneTimeTermCount             *int    `json:"oneTimeTermCount"`
	OneTimeTermUnit              *string `json:"oneTimeTermUnit"`
	AutoRenew                    bool    `json:"autoRenew"`
	AutoCalculateNextBillingDate bool    `json:"autoCalculateNextBillingDate"`
}

func TestNormalizeSubscriptionRecordMatchesSharedFixtures(t *testing.T) {
	fixtures := readSubscriptionNormalizationFixtures(t)
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			record := newFixtureSubscriptionRecord(fixture.Input)
			if err := normalizeSubscriptionRecord(record); err != nil {
				t.Fatal(err)
			}
			if got := nullablePositiveInt(record.GetInt("customDays")); !sameIntPointer(got, fixture.Expected.CustomDays) {
				t.Fatalf("customDays = %v, want %v", got, fixture.Expected.CustomDays)
			}
			if got := nullableStringValue(record.GetString("customCycleUnit")); !sameStringPointer(got, fixture.Expected.CustomCycleUnit) {
				t.Fatalf("customCycleUnit = %v, want %v", got, fixture.Expected.CustomCycleUnit)
			}
			if got := nullablePositiveInt(record.GetInt("oneTimeTermCount")); !sameIntPointer(got, fixture.Expected.OneTimeTermCount) {
				t.Fatalf("oneTimeTermCount = %v, want %v", got, fixture.Expected.OneTimeTermCount)
			}
			if got := nullableStringValue(record.GetString("oneTimeTermUnit")); !sameStringPointer(got, fixture.Expected.OneTimeTermUnit) {
				t.Fatalf("oneTimeTermUnit = %v, want %v", got, fixture.Expected.OneTimeTermUnit)
			}
			if record.GetBool("autoRenew") != fixture.Expected.AutoRenew {
				t.Fatalf("autoRenew = %v, want %v", record.GetBool("autoRenew"), fixture.Expected.AutoRenew)
			}
			if record.GetBool("autoCalculateNextBillingDate") != fixture.Expected.AutoCalculateNextBillingDate {
				t.Fatalf("autoCalculateNextBillingDate = %v, want %v", record.GetBool("autoCalculateNextBillingDate"), fixture.Expected.AutoCalculateNextBillingDate)
			}
		})
	}
}

func readSubscriptionNormalizationFixtures(t *testing.T) []subscriptionNormalizationFixture {
	t.Helper()
	data, err := os.ReadFile("../../../../packages/shared/src/contract-fixtures/subscription-normalization-fixtures.json")
	if err != nil {
		t.Fatalf("read shared subscription normalization fixtures: %v", err)
	}
	var fixtures []subscriptionNormalizationFixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatalf("decode shared subscription normalization fixtures: %v", err)
	}
	return fixtures
}

func newFixtureSubscriptionRecord(fields subscriptionNormalizationFields) *core.Record {
	record := core.NewRecord(core.NewBaseCollection("subscriptions"))
	record.Set("name", "Fixture SaaS")
	record.Set("price", "10")
	record.Set("currency", "USD")
	record.Set("billingCycle", fields.BillingCycle)
	if fields.CustomDays != nil {
		record.Set("customDays", *fields.CustomDays)
	}
	if fields.CustomCycleUnit != nil {
		record.Set("customCycleUnit", *fields.CustomCycleUnit)
	}
	if fields.OneTimeTermCount != nil {
		record.Set("oneTimeTermCount", *fields.OneTimeTermCount)
	}
	if fields.OneTimeTermUnit != nil {
		record.Set("oneTimeTermUnit", *fields.OneTimeTermUnit)
	}
	record.Set("startDate", "2026-01-01")
	record.Set("nextBillingDate", "2026-02-01")
	record.Set("autoRenew", fields.AutoRenew)
	record.Set("autoCalculateNextBillingDate", fields.AutoCalculateNextBillingDate)
	record.Set("tags", []string{})
	record.Set("reminderDays", 3)
	return record
}

func nullablePositiveInt(value int) *int {
	if value <= 0 {
		return nil
	}
	return &value
}

func nullableStringValue(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func sameIntPointer(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sameStringPointer(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
