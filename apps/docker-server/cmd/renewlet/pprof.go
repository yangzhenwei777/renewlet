package main

// pprof.go 提供显式 opt-in 的独立诊断端口；它不挂产品 middleware，也不允许绑定非 loopback 地址。

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const pprofShutdownTimeout = 2 * time.Second

type pprofRuntime struct {
	server       *http.Server
	listener     net.Listener
	shutdownOnce sync.Once
	shutdownErr  error
}

func startPprofFromEnv() (*pprofRuntime, error) {
	address := strings.TrimSpace(os.Getenv("RENEWLET_PPROF_ADDR"))
	if address == "" {
		return nil, nil
	}
	if err := validatePprofAddress(address); err != nil {
		return nil, err
	}

	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("listen on RENEWLET_PPROF_ADDR: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

	runtime := &pprofRuntime{
		server: &http.Server{
			Addr:              address,
			Handler:           mux,
			ReadHeaderTimeout: 2 * time.Second,
		},
		listener: listener,
	}
	// pprof 与产品 API 使用独立 mux 和 listener；即使主服务暴露到公网，诊断端口也只能显式绑定 loopback。
	go func() {
		if serveErr := runtime.server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			slog.Error("pprof server stopped unexpectedly", "error", serveErr)
		}
	}()
	slog.Info("pprof server enabled", "address", listener.Addr().String())
	return runtime, nil
}

func validatePprofAddress(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid RENEWLET_PPROF_ADDR: %w", err)
	}
	if host != "127.0.0.1" && host != "::1" {
		return errors.New("RENEWLET_PPROF_ADDR must bind to 127.0.0.1 or [::1]")
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return errors.New("RENEWLET_PPROF_ADDR must include a port between 1 and 65535")
	}
	return nil
}

func (runtime *pprofRuntime) Shutdown() error {
	if runtime == nil {
		return nil
	}
	// main 的多个退出分支可重复调用；只执行一次 shutdown，超时后强制关闭 listener，避免诊断 goroutine 阻塞退出。
	runtime.shutdownOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), pprofShutdownTimeout)
		defer cancel()
		runtime.shutdownErr = runtime.server.Shutdown(ctx)
		if runtime.shutdownErr != nil {
			_ = runtime.listener.Close()
		}
	})
	return runtime.shutdownErr
}
