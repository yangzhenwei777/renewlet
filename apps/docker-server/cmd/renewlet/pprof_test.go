package main

import (
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestValidatePprofAddress(t *testing.T) {
	t.Parallel()
	for _, address := range []string{"127.0.0.1:6060", "[::1]:6060"} {
		address := address
		t.Run("accepts_"+address, func(t *testing.T) {
			t.Parallel()
			if err := validatePprofAddress(address); err != nil {
				t.Fatalf("validatePprofAddress(%q): %v", address, err)
			}
		})
	}
	for _, address := range []string{"0.0.0.0:6060", "localhost:6060", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:65536"} {
		address := address
		t.Run("rejects_"+address, func(t *testing.T) {
			t.Parallel()
			if err := validatePprofAddress(address); err == nil {
				t.Fatalf("validatePprofAddress(%q) unexpectedly succeeded", address)
			}
		})
	}
}

func TestStartPprofFromEnvDisabledByDefault(t *testing.T) {
	t.Setenv("RENEWLET_PPROF_ADDR", "")
	runtime, err := startPprofFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if runtime != nil {
		t.Fatal("pprof runtime should remain disabled without RENEWLET_PPROF_ADDR")
	}
}

func TestPprofRuntimeServesAndShutsDown(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := probe.Addr().String()
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RENEWLET_PPROF_ADDR", address)

	runtime, err := startPprofFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Shutdown() })

	client := &http.Client{Timeout: time.Second}
	response, err := client.Get("http://" + runtime.listener.Addr().String() + "/debug/pprof/")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pprof index status = %d", response.StatusCode)
	}

	startedAt := time.Now()
	if err := runtime.Shutdown(); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(startedAt); elapsed > pprofShutdownTimeout {
		t.Fatalf("pprof shutdown exceeded timeout: %v", elapsed)
	}
	if err := runtime.Shutdown(); err != nil {
		t.Fatalf("second shutdown must be idempotent: %v", err)
	}
}
