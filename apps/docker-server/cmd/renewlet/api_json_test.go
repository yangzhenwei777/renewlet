package main

import (
	"bytes"
	"encoding/json/jsontext"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

func TestProductJSONResponseKeepsWireSemantics(t *testing.T) {
	type payload struct {
		OptionalCount int               `json:"optionalCount,omitempty"`
		OptionalFlag  bool              `json:"optionalFlag,omitempty"`
		Count         int               `json:"count"`
		Flag          bool              `json:"flag"`
		Values        []string          `json:"values"`
		Labels        map[string]string `json:"labels"`
		Price         string            `json:"price"`
	}
	for _, query := range []string{"", "?fields=ok,data"} {
		t.Run(query, func(t *testing.T) {
			out := httptest.NewRecorder()
			event := &core.RequestEvent{Event: router.Event{
				Response: out, Request: httptest.NewRequest(http.MethodGet, "/api/app/fixture"+query, nil),
			}}
			if err := apiSuccessJSON(event, http.StatusOK, payload{Price: "123456789.012345"}); err != nil {
				t.Fatal(err)
			}
			if out.Code != http.StatusOK || out.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("unexpected HTTP metadata: %d %v", out.Code, out.Header())
			}
			actual := jsontext.Value(out.Body.Bytes())
			expected := jsontext.Value(`{"ok":true,"data":{"count":0,"flag":false,"values":null,"labels":null,"price":"123456789.012345"}}`)
			if err := actual.Canonicalize(); err != nil {
				t.Fatal(err)
			}
			if err := expected.Canonicalize(); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(actual, expected) {
				t.Fatalf("wire semantics changed: %s", out.Body.String())
			}
		})
	}
}

func TestProductJSONErrorKeepsWireSemantics(t *testing.T) {
	for _, query := range []string{"", "?fields=error"} {
		t.Run(query, func(t *testing.T) {
			out := httptest.NewRecorder()
			event := &core.RequestEvent{Event: router.Event{
				Response: out, Request: httptest.NewRequest(http.MethodGet, "/api/app/fixture"+query, nil),
			}}
			if err := apiErrorJSON(event, http.StatusBadRequest, "INVALID_PAYLOAD", "Invalid payload", nil); err != nil {
				t.Fatal(err)
			}
			if out.Code != http.StatusBadRequest || string(bytes.TrimSpace(out.Body.Bytes())) != `{"error":{"code":"INVALID_PAYLOAD","message":"Invalid payload"}}` {
				t.Fatalf("error wire semantics changed: %d %s", out.Code, out.Body.String())
			}
		})
	}
}
