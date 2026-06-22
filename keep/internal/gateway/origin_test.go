package gateway

import (
	"net/http/httptest"
	"testing"
)

func TestOriginAllowed(t *testing.T) {
	const host = "keep.example:7777"
	cases := []struct {
		name   string
		origin string // "" = no Origin header sent
		want   bool
	}{
		{"non-browser client (no origin)", "", true},
		{"electron packaged (file:// → null)", "null", true},
		{"electron dev (localhost)", "http://localhost:5173", true},
		{"electron dev (127.0.0.1)", "http://127.0.0.1:5173", true},
		{"same-origin admin page", "http://keep.example:7777", true},
		{"malicious web page", "https://evil.example", false},
		{"lookalike host suffix", "https://localhost.evil.example", false},
		{"malformed origin", "http://%zz", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/v1/gateway", nil)
			r.Host = host
			if c.origin != "" {
				r.Header.Set("Origin", c.origin)
			}
			if got := originAllowed(r); got != c.want {
				t.Fatalf("originAllowed(origin=%q) = %v, want %v", c.origin, got, c.want)
			}
		})
	}
}
