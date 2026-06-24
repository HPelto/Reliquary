package gateway

import (
	"testing"
	"time"
)

// TestDisconnectUser verifies the force-disconnect path: a subscribed user's
// stream is closed and they go offline, the RTC layer's later unsub is a safe
// no-op (no double-close), and disconnecting an unknown user does nothing.
func TestDisconnectUser(t *testing.T) {
	h := NewHub(nil)
	stream, unsub := h.Subscribe(7)
	if !h.OnlineUserIDs()[7] {
		t.Fatal("user not online after subscribe")
	}

	if n := h.DisconnectUser(7); n != 1 {
		t.Fatalf("DisconnectUser dropped %d connections, want 1", n)
	}
	if h.OnlineUserIDs()[7] {
		t.Fatal("user still online after DisconnectUser")
	}

	// the subscriber's stream must drain + close
	deadline := time.After(time.Second)
	for {
		select {
		case _, ok := <-stream:
			if !ok {
				goto closed
			}
		case <-deadline:
			t.Fatal("stream not closed after DisconnectUser")
		}
	}
closed:
	unsub()                         // RTC layer unsubscribes afterwards — must not panic
	if h.DisconnectUser(999) != 0 { // unknown user
		t.Fatal("DisconnectUser of an unknown user should drop 0")
	}
	if h.DisconnectUser(7) != 0 { // already gone
		t.Fatal("DisconnectUser of an already-dropped user should drop 0")
	}
}
