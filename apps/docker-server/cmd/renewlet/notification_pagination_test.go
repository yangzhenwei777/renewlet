package main

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func TestNotificationCursorVisitsEveryDueAccountOnce(t *testing.T) {
	for _, size := range []int{100, 150, 1000} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			app := newSchemaTestApp(t)
			if err := ensureSchema(app); err != nil {
				t.Fatal(err)
			}
			expected := make([]string, size)
			// 隔离容量夹具只需账号键，不创建登录凭据或外部通知配置。
			if err := app.RunInTransaction(func(txApp core.App) error {
				for index := range size + 2 {
					userID := fmt.Sprintf("u%014d", index)
					if index < size {
						expected[index] = userID
					}
					if _, err := txApp.DB().NewQuery("INSERT INTO users (id, email, tokenKey, name, role, banned) VALUES ({:id}, {:email}, {:id}, 'Cursor', 'user', {:banned})").Bind(dbx.Params{"id": userID, "email": userID + "@example.test", "banned": index == size}).Execute(); err != nil {
						return err
					}
					dueAt := "2026-01-09T08:00:00Z"
					if index == size+1 {
						dueAt = "2026-01-10T08:00:00Z"
					}
					if _, err := txApp.DB().NewQuery("INSERT INTO subscription_scheduler_states (id, user, nextDailyNotificationDueAtUTC) VALUES ({:id}, {:id}, {:due})").Bind(dbx.Params{"id": userID, "due": dueAt}).Execute(); err != nil {
						return err
					}
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			now := time.Date(2026, 1, 9, 8, 0, 0, 0, time.UTC)
			actual := []string{}
			cursor := ""
			pages := 0
			for {
				users, err := listNotificationDueUserIDs(app, now, 50, cursor)
				if err != nil {
					t.Fatal(err)
				}
				pages++
				if len(users) == 0 {
					break
				}
				actual = append(actual, users...)
				if len(actual) > size {
					t.Fatal("cursor revisited due accounts")
				}
				cursor = users[len(users)-1]
				for index, userID := range users {
					if index%2 != 0 {
						continue
					}
					if _, err := app.DB().NewQuery("UPDATE subscription_scheduler_states SET nextDailyNotificationDueAtUTC = '2026-01-10T08:00:00Z' WHERE user = {:user}").Bind(dbx.Params{"user": userID}).Execute(); err != nil {
						t.Fatal(err)
					}
				}
			}
			if !reflect.DeepEqual(expected, actual) || pages != size/50+1 {
				t.Fatalf("incomplete cursor scan: accounts=%d pages=%d", len(actual), pages)
			}
			operations, err := measureSubscriptionDBOperations(app, func() error {
				_, err := listNotificationDueUserIDs(app, now, 50, "u00000000000050")
				return err
			})
			if err != nil || operations.ReadQueries != 1 {
				t.Fatalf("page query budget: %+v %v", operations, err)
			}
			var plan []struct {
				Detail string `db:"detail"`
			}
			if err := app.DB().NewQuery("EXPLAIN QUERY PLAN " + operations.ReadSQL[0]).All(&plan); err != nil {
				t.Fatal(err)
			}
			for _, step := range plan {
				if strings.Contains(step.Detail, "SCAN") || strings.Contains(step.Detail, "TEMP B-TREE") {
					t.Fatalf("cursor query scans or sorts the account table: %+v", plan)
				}
			}
			t.Logf("accounts=%d pages=%d queryPlan=%+v", size, pages, plan)
		})
	}
}
