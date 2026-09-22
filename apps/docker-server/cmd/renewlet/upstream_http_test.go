package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDefaultUpstreamHTTPClientKeepsProxyAndTLSPolicy(t *testing.T) {
	client := defaultUpstreamHTTPClient(15 * time.Second)
	if client.Timeout != 15*time.Second {
		t.Fatalf("unexpected timeout %s", client.Timeout)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", client.Transport)
	}
	if transport.Proxy == nil {
		t.Fatal("expected environment proxy function")
	}
	if reflect.ValueOf(transport.Proxy).Pointer() != reflect.ValueOf(http.ProxyFromEnvironment).Pointer() {
		t.Fatal("expected upstream HTTP client to preserve http.ProxyFromEnvironment")
	}
	if transport.TLSClientConfig == nil || transport.TLSClientConfig.MinVersion != tls.VersionTLS12 {
		t.Fatalf("expected TLS 1.2 minimum, got %#v", transport.TLSClientConfig)
	}
}

func TestDefaultUpstreamHTTPClientRoutesHTTPSThroughEnvironmentProxy(t *testing.T) {
	for _, envName := range []string{"HTTPS_PROXY", "https_proxy"} {
		t.Run(envName, func(t *testing.T) {
			proxyURL, requests := startHTTPProxyRecorder(t)
			runUpstreamHTTPProxyChild(t, "connect", map[string]string{envName: proxyURL})
			assertProxyReceivedTelegramConnect(t, requests)
		})
	}
}

func TestDefaultUpstreamHTTPClientHonorsNoProxyForTelegram(t *testing.T) {
	for _, envNames := range []struct {
		proxy  string
		bypass string
	}{
		{proxy: "HTTPS_PROXY", bypass: "NO_PROXY"},
		{proxy: "https_proxy", bypass: "no_proxy"},
	} {
		t.Run(envNames.bypass, func(t *testing.T) {
			runUpstreamHTTPProxyChild(t, "noproxy", map[string]string{
				envNames.proxy:  "http://127.0.0.1:9",
				envNames.bypass: "api.telegram.org",
			})
		})
	}
}

func TestDefaultUpstreamHTTPClientPrefersUppercaseProxyEnvironment(t *testing.T) {
	upperURL, upperRequests := startHTTPProxyRecorder(t)
	lowerURL, lowerRequests := startHTTPProxyRecorder(t)
	runUpstreamHTTPProxyChild(t, "connect", map[string]string{
		"HTTPS_PROXY": upperURL,
		"https_proxy": lowerURL,
	})
	assertProxyReceivedTelegramConnect(t, upperRequests)
	select {
	case got := <-lowerRequests:
		t.Fatalf("expected uppercase HTTPS_PROXY to win, lowercase proxy received %q", got)
	default:
	}
}

func TestDefaultUpstreamHTTPClientPrefersUppercaseNoProxyEnvironment(t *testing.T) {
	runUpstreamHTTPProxyChild(t, "proxied", map[string]string{
		"HTTPS_PROXY": "http://127.0.0.1:9",
		"NO_PROXY":    "example.com",
		"no_proxy":    "api.telegram.org",
	})
}

func TestUpstreamHTTPProxyChild(t *testing.T) {
	switch os.Getenv("RENEWLET_TEST_UPSTREAM_PROXY_CHILD") {
	case "":
		t.Skip("helper process only")
	case "connect":
		client := defaultUpstreamHTTPClient(2 * time.Second)
		resp, err := client.Get("https://api.telegram.org/botredacted/sendMessage")
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
		if err == nil {
			t.Fatal("expected fake proxy to abort the CONNECT request")
		}
	case "noproxy":
		proxy := upstreamHTTPProxyForTelegram(t)
		if proxy != nil {
			t.Fatalf("expected NO_PROXY to suppress proxy, got %s", proxy.Redacted())
		}
	case "proxied":
		proxy := upstreamHTTPProxyForTelegram(t)
		if proxy == nil {
			t.Fatal("expected uppercase NO_PROXY to take precedence over lowercase no_proxy")
		}
	default:
		t.Fatalf("unknown child mode %q", os.Getenv("RENEWLET_TEST_UPSTREAM_PROXY_CHILD"))
	}
}

func runUpstreamHTTPProxyChild(t *testing.T, mode string, overrides map[string]string) {
	t.Helper()
	// ProxyFromEnvironment 缓存进程级配置；每组环境必须在独立子进程中验证。
	cmd := exec.Command(os.Args[0], "-test.run=^TestUpstreamHTTPProxyChild$", "-test.count=1")
	overrides["RENEWLET_TEST_UPSTREAM_PROXY_CHILD"] = mode
	cmd.Env = upstreamHTTPProxyChildEnv(overrides)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("proxy child failed: %v\n%s", err, output)
	}
}

func upstreamHTTPProxyForTelegram(t *testing.T) *url.URL {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, "https://api.telegram.org/botredacted/sendMessage", nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy, err := defaultUpstreamHTTPTransport().Proxy(request)
	if err != nil {
		t.Fatal(err)
	}
	return proxy
}

func assertProxyReceivedTelegramConnect(t *testing.T, requests <-chan string) {
	t.Helper()
	select {
	case got := <-requests:
		if got != "CONNECT api.telegram.org:443 HTTP/1.1" {
			t.Fatalf("unexpected proxy request line %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected HTTPS request to reach proxy")
	}
}

func TestLogUpstreamHTTPProxyEnvironmentRedactsCredentialsAndDetectsLoopback(t *testing.T) {
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"} {
		t.Setenv(key, "")
	}
	t.Setenv("HTTPS_PROXY", "http://user:secret@127.0.0.1:7890")
	t.Setenv("NO_PROXY", "localhost,.internal")

	summary := upstreamHTTPProxyEnvironmentSummaryFromEnv()
	if strings.Join(summary.Variables, ",") != "HTTPS_PROXY,NO_PROXY" {
		t.Fatalf("unexpected proxy variables: %#v", summary.Variables)
	}
	if summary.credentialsStatus() != "present" || strings.Join(summary.CredentialVariables, ",") != "HTTPS_PROXY" {
		t.Fatalf("expected credential presence without values, got %#v", summary)
	}
	if strings.Join(summary.LoopbackVariables, ",") != "HTTPS_PROXY" {
		t.Fatalf("expected loopback proxy warning variable, got %#v", summary.LoopbackVariables)
	}

	var buffer bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buffer, nil))
	logUpstreamHTTPProxyEnvironment(logger)
	logs := buffer.String()
	for _, forbidden := range []string{"user", "secret", "127.0.0.1:7890"} {
		if strings.Contains(logs, forbidden) {
			t.Fatalf("proxy startup log leaked %q: %s", forbidden, logs)
		}
	}
	for _, want := range []string{"credentials=present", "HTTPS_PROXY", "NO_PROXY", "level=WARN"} {
		if !strings.Contains(logs, want) {
			t.Fatalf("expected proxy startup log to contain %q, got %s", want, logs)
		}
	}
}

func TestUnifiedUpstreamHTTPTransportSharedByAdapters(t *testing.T) {
	// 这组断言防止通知、AI、S3 或 WebDAV adapter 绕开统一 Docker/Go 上游出口。
	notificationTransport, ok := defaultNotificationHTTPClient().Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected notification transport, got %T", defaultNotificationHTTPClient().Transport)
	}
	assertTransportUsesEnvironmentProxy(t, notificationTransport)

	endpoint := resolveAIProviderEndpoint(aiRecognitionSettings{ProviderType: aiProviderTypeGemini, BaseURL: "https://gateway.example.com/custom/api#"})
	aiTransport, ok := aiProviderRuntimeHTTPClient(endpoint, "v1beta").Transport.(aiProviderRuntimeTransport)
	if !ok {
		t.Fatalf("expected AI runtime transport, got %T", aiProviderRuntimeHTTPClient(endpoint, "v1beta").Transport)
	}
	assertRoundTripperUsesEnvironmentProxy(t, aiTransport.inner)

	s3HTTPClient := &s3CaptureHTTPClient{client: defaultUpstreamHTTPClient(45 * time.Second)}
	assertRoundTripperUsesEnvironmentProxy(t, s3HTTPClient.client.Transport)

	webDAVTransport := &webDAVCaptureTransport{base: defaultUpstreamHTTPTransport()}
	assertRoundTripperUsesEnvironmentProxy(t, webDAVTransport.base)
}

func TestUpstreamTransportDiagnosticUsesFullRedactedRequestContext(t *testing.T) {
	request, err := http.NewRequest(
		http.MethodPost,
		"https://discord.com/api/webhooks/123/discord-secret?wait=true&token=bot-secret",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer bot-secret")
	request.Header.Set("Content-Type", "application/json")
	message := upstreamTransportDiagnosticMessage(request, upstreamHTTPRequestOptions{
		Provider: "Discord",
		Timeout:  10 * time.Second,
		Secrets:  []string{"discord-secret", "bot-secret"},
		Body:     []byte(`{"token":"bot-secret","content":"hello"}`),
	}, errors.New("Network connection lost for https://discord.com/api/webhooks/123/discord-secret?wait=true&token=bot-secret"), 10*time.Second, false)

	for _, want := range []string{
		"Discord POST request to https://discord.com/api/webhooks/123/[redacted]?token=%5Bredacted%5D&wait=true failed before response headers",
		"Network connection lost for https://discord.com/api/webhooks/123/[redacted]?token=[redacted]&wait=true",
		`"authorization":"[redacted]"`,
		`"content-type":"application/json"`,
		`"token":"[redacted]"`,
		`"content":"hello"`,
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("expected diagnostic to contain %q, got %q", want, message)
		}
	}
	for _, forbidden := range []string{"discord-secret", "bot-secret"} {
		if strings.Contains(message, forbidden) {
			t.Fatalf("diagnostic leaked %q: %s", forbidden, message)
		}
	}
}

func startHTTPProxyRecorder(t *testing.T) (string, <-chan string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan string, 1)
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		// HTTPS 代理在 TLS 前先发 CONNECT；假代理记录首行即可，不需要完成远端握手。
		line, _ := bufio.NewReader(conn).ReadString('\n')
		requests <- strings.TrimSpace(line)
		_, _ = conn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"))
	}()
	return "http://" + listener.Addr().String(), requests
}

func upstreamHTTPProxyChildEnv(overrides map[string]string) []string {
	clean := []string{}
	// 代理测试必须白盒控制 env；继承宿主机代理会让 CI 和本地结果取决于机器配置。
	blocked := map[string]struct{}{
		"HTTP_PROXY":  {},
		"HTTPS_PROXY": {},
		"NO_PROXY":    {},
		"http_proxy":  {},
		"https_proxy": {},
		"no_proxy":    {},
	}
	for _, item := range os.Environ() {
		key, _, _ := strings.Cut(item, "=")
		if _, ok := blocked[key]; ok {
			continue
		}
		clean = append(clean, item)
	}
	for key, value := range overrides {
		clean = append(clean, key+"="+value)
	}
	return clean
}

func assertRoundTripperUsesEnvironmentProxy(t *testing.T, roundTripper http.RoundTripper) {
	t.Helper()
	transport, ok := roundTripper.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", roundTripper)
	}
	assertTransportUsesEnvironmentProxy(t, transport)
}

func assertTransportUsesEnvironmentProxy(t *testing.T, transport *http.Transport) {
	t.Helper()
	if transport == nil || transport.Proxy == nil {
		t.Fatalf("expected transport to preserve environment proxy, got %#v", transport)
	}
	if reflect.ValueOf(transport.Proxy).Pointer() != reflect.ValueOf(http.ProxyFromEnvironment).Pointer() {
		t.Fatal("expected transport proxy to use http.ProxyFromEnvironment")
	}
}
