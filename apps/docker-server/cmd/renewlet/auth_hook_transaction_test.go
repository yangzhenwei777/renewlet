package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

func TestAuthHooksReadUncommittedProtection(t *testing.T) {
	for _, credential := range []string{"totp", "passkey"} {
		for _, hook := range []string{"password", "refresh", "auth"} {
			t.Run(credential+"/"+hook, func(t *testing.T) {
				app := newMFATestApp(t)
				user, _ := createRouteTestUser(t, app, "auth-transaction")
				rollback := errors.New("fixture rollback")
				err := app.RunInTransaction(func(tx core.App) error {
					if credential == "totp" {
						createTestTOTPCredential(t, tx, user.Id)
					} else {
						createTestPasskeyCredential(t, tx, user.Id)
					}
					request := &core.RequestEvent{App: tx}
					request.Request = httptest.NewRequest(http.MethodPost, "/api/collections/users/auth-with-password", nil)
					var authErr error
					switch hook {
					case "password":
						event := &core.RecordAuthWithPasswordRequestEvent{RequestEvent: request, Record: user}
						event.Collection = user.Collection()
						authErr = tx.OnRecordAuthWithPasswordRequest().Trigger(event)
					case "refresh":
						event := &core.RecordAuthRefreshRequestEvent{RequestEvent: request, Record: user}
						event.Collection = user.Collection()
						authErr = tx.OnRecordAuthRefreshRequest().Trigger(event)
					case "auth":
						event := &core.RecordAuthRequestEvent{RequestEvent: request, Record: user}
						event.Collection = user.Collection()
						authErr = tx.OnRecordAuthRequest().Trigger(event)
					}
					var response *router.ApiError
					if !errors.As(authErr, &response) || response.Status != http.StatusUnauthorized {
						t.Fatalf("uncommitted %s must block native %s auth: %v", credential, hook, authErr)
					}
					return rollback
				})
				if !errors.Is(err, rollback) {
					t.Fatal(err)
				}
				if protected, err := productAuthProtectedForUser(app, user.Id); err != nil || protected {
					t.Fatalf("fixture credential must roll back: protected=%v err=%v", protected, err)
				}
			})
		}
	}
}
