package rtc

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestRecorderServeContent checks that http.ServeContent (how the Keep serves
// media) writes its full body + Content-Type through the minimal recorder the
// tunnel replays responses into. If this drops bytes, media GETs over the data
// channel return a truncated/empty blob → a broken <img>.
func TestRecorderServeContent(t *testing.T) {
	// a PNG-ish blob bigger than ServeContent's internal copy buffer
	content := bytes.Repeat([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a}, 30000) // ~180 KB

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(content))
	})

	rec := &recorder{header: http.Header{}, status: http.StatusOK}
	req := httptest.NewRequest(http.MethodGet, "/v1/media/x", nil)
	handler.ServeHTTP(rec, req)

	if rec.status != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.status)
	}
	if got := rec.header.Get("Content-Type"); got != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png", got)
	}
	if !bytes.Equal(rec.body.Bytes(), content) {
		t.Fatalf("body mismatch: got %d bytes, want %d", rec.body.Len(), len(content))
	}
}
