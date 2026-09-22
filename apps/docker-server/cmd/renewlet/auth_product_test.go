package main

import (
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestAppAuthMiddlewareThrottlesLastSeenAt(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	_, token := createRouteTestUser(t, app, "session-touch")

	session := reloadSessionForBearer(t, app, token)
	initialLastSeen := session.GetString("lastSeenAt")
	readFresh := serveTestRequest(t, app, http.MethodGet, "/api/app/settings", "", token)
	if readFresh.Code != http.StatusOK {
		t.Fatalf("expected settings read 200, got %d: %s", readFresh.Code, readFresh.Body.String())
	}
	if got := reloadSessionForBearer(t, app, token).GetString("lastSeenAt"); got != initialLastSeen {
		t.Fatalf("fresh session must not rewrite lastSeenAt, before=%q after=%q", initialLastSeen, got)
	}

	staleLastSeen := time.Now().UTC().Add(-auditTouchInterval - time.Minute).Format(time.RFC3339Nano)
	session = reloadSessionForBearer(t, app, token)
	session.Set("lastSeenAt", staleLastSeen)
	if err := app.Save(session); err != nil {
		t.Fatal(err)
	}
	readStale := serveTestRequest(t, app, http.MethodGet, "/api/app/settings", "", token)
	if readStale.Code != http.StatusOK {
		t.Fatalf("expected stale settings read 200, got %d: %s", readStale.Code, readStale.Body.String())
	}
	touchedLastSeen := reloadSessionForBearer(t, app, token).GetString("lastSeenAt")
	if touchedLastSeen == staleLastSeen {
		t.Fatalf("stale session should refresh lastSeenAt, still %q", touchedLastSeen)
	}
	if touchedAt, err := time.Parse(time.RFC3339Nano, touchedLastSeen); err != nil || !touchedAt.After(time.Now().UTC().Add(-time.Minute)) {
		t.Fatalf("expected refreshed lastSeenAt timestamp, got %q err=%v", touchedLastSeen, err)
	}

	session = reloadSessionForBearer(t, app, token)
	session.Set("lastSeenAt", "not-rfc3339")
	if err := app.Save(session); err != nil {
		t.Fatal(err)
	}
	readInvalid := serveTestRequest(t, app, http.MethodGet, "/api/app/settings", "", token)
	if readInvalid.Code != http.StatusOK {
		t.Fatalf("expected invalid timestamp settings read 200, got %d: %s", readInvalid.Code, readInvalid.Body.String())
	}
	invalidFixed := reloadSessionForBearer(t, app, token).GetString("lastSeenAt")
	if invalidFixed == "not-rfc3339" {
		t.Fatal("invalid lastSeenAt should be repaired on the next authenticated request")
	}
	if _, err := time.Parse(time.RFC3339Nano, invalidFixed); err != nil {
		t.Fatalf("expected repaired lastSeenAt to be RFC3339Nano, got %q: %v", invalidFixed, err)
	}
}

func TestAppAuthMiddlewareRejectsAuthorizationBearerSession(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, productAuth := createRouteTestUser(t, app, "cookie-only")
	sessionToken, _ := routeTestProductSessionParts(t, productAuth)

	res := serveTestRequest(t, app, http.MethodGet, "/api/app/settings", "", "Bearer "+sessionToken)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("expected Authorization bearer product session to be rejected, got %d: %s", res.Code, res.Body.String())
	}

	cookieRes := serveTestRequest(t, app, http.MethodGet, "/api/app/settings", "", productAuth)
	if cookieRes.Code != http.StatusOK {
		t.Fatalf("expected cookie product session for %s to be accepted, got %d: %s", user.Email(), cookieRes.Code, cookieRes.Body.String())
	}
}

func reloadSessionForBearer(t *testing.T, app core.App, token string) *core.Record {
	t.Helper()
	sessionToken, _ := routeTestProductSessionParts(t, token)
	_, session, err := appAuthRecordByToken(app, sessionToken)
	if err != nil {
		t.Fatal(err)
	}
	return session
}
