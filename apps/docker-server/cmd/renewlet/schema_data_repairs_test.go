package main

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestCleanupInvalidSubscriptionLogosButKeepsHttpLinks(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.SetEmail("schema-logo-cleanup@example.com")
	user.SetPassword("password123")
	user.SetVerified(true)
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	subscriptions, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		t.Fatal(err)
	}

	insert := func(name string, logo string) string {
		t.Helper()
		record := core.NewRecord(subscriptions)
		record.Set("user", user.Id)
		record.Set("name", name)
		record.Set("price", "1")
		record.Set("currency", "USD")
		record.Set("billingCycle", "monthly")
		record.Set("category", "productivity")
		record.Set("status", "active")
		record.Set("startDate", "2026-05-14")
		record.Set("nextBillingDate", "2026-06-14")
		record.Set("autoRenew", true)
		record.Set("autoCalculateNextBillingDate", true)
		record.Set("tags", []string{})
		record.Set("extra", emptyJSONPayload{})
		record.Set("reminderDays", 3)
		record.Set("repeatReminderEnabled", false)
		record.Set("repeatReminderInterval", defaultRepeatReminderInterval)
		record.Set("repeatReminderWindow", defaultRepeatReminderWindow)
		record.Set("logo", logo)
		if err := app.SaveNoValidate(record); err != nil {
			t.Fatal(err)
		}
		return record.Id
	}

	httpID := insert("HTTP Logo", "http://example.com/logo.png")
	dataID := insert("Data Logo", "data:image/png;base64,aGVsbG8=")
	userinfoID := insert("Userinfo Logo", "https://user:pass@example.com/logo.png")
	privateID := insert("Private Logo", "/api/app/assets/2pbs0lgyypqhjoy")

	if err := cleanupInvalidSubscriptionLogos(app); err != nil {
		t.Fatal(err)
	}

	assertLogo := func(id string, want string) {
		t.Helper()
		record, err := app.FindRecordById("subscriptions", id)
		if err != nil {
			t.Fatal(err)
		}
		if got := record.GetString("logo"); got != want {
			t.Fatalf("logo for %s = %q, want %q", id, got, want)
		}
	}
	assertLogo(httpID, "http://example.com/logo.png")
	assertLogo(privateID, "/api/app/assets/2pbs0lgyypqhjoy")
	assertLogo(dataID, "")
	assertLogo(userinfoID, "")
}
