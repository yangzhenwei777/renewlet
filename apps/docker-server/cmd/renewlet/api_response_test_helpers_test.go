package main

import (
	"encoding/json"
	"testing"
)

type apiSuccessEnvelopeForTest[T any] struct {
	OK   bool `json:"ok"`
	Data T    `json:"data"`
}

func decodeAPISuccessDataForTest[T any](t *testing.T, body []byte) T {
	t.Helper()
	var envelope apiSuccessEnvelopeForTest[T]
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatal(err)
	}
	if !envelope.OK {
		t.Fatalf("expected success envelope ok=true, got %#v", envelope)
	}
	return envelope.Data
}
