package main

// SSRF fixture 通过 resolver 注入只替换测试 DNS 结果，不改变生产外发 URL 策略。

import (
	"encoding/json"
	"net"
	"os"
	"testing"
)

type outboundURLPolicyFixture struct {
	Name        string   `json:"name"`
	URL         string   `json:"url"`
	ResolvedIPs []string `json:"resolvedIps"`
	Safe        bool     `json:"safe"`
	ExpectedURL string   `json:"expectedUrl"`
}

func TestOutboundURLPolicyMatchesSharedFixtures(t *testing.T) {
	fixtures := readOutboundURLPolicyFixtures(t)
	original := outboundURLResolver
	t.Cleanup(func() {
		outboundURLResolver = original
	})
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			outboundURLResolver = func(host string) ([]net.IPAddr, error) {
				out := make([]net.IPAddr, 0, len(fixture.ResolvedIPs))
				for _, value := range fixture.ResolvedIPs {
					out = append(out, net.IPAddr{IP: net.ParseIP(value)})
				}
				return out, nil
			}
			got, err := assertSafeOutboundURL(fixture.URL, "Webhook", defaultAppLocale)
			if fixture.Safe {
				if err != nil {
					t.Fatalf("expected safe URL, got error: %v", err)
				}
				expected := fixture.ExpectedURL
				if expected == "" {
					expected = fixture.URL
				}
				if got.String() != expected {
					t.Fatalf("url = %q, want %q", got.String(), expected)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected unsafe URL to fail")
			}
		})
	}
}

func readOutboundURLPolicyFixtures(t *testing.T) []outboundURLPolicyFixture {
	t.Helper()
	data, err := os.ReadFile("../../../../packages/shared/src/contract-fixtures/outbound-url-policy-fixtures.json")
	if err != nil {
		t.Fatalf("read shared outbound URL fixtures: %v", err)
	}
	var fixtures []outboundURLPolicyFixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatalf("decode shared outbound URL fixtures: %v", err)
	}
	return fixtures
}
