package gateway

import (
	"testing"
	"time"
)

// TestSubscribeReceivesEvents verifies the non-WebSocket gateway path: a
// subscriber gets Broadcast + its own SendToUser events, doesn't get another
// user's, counts toward presence, and is cleanly torn down on unsubscribe.
func TestSubscribeReceivesEvents(t *testing.T) {
	h := NewHub(nil) // Subscribe/Broadcast/SendToUser don't touch the store

	stream, unsub := h.Subscribe(42)

	expect := func(typ string) {
		deadline := time.After(2 * time.Second)
		for {
			select {
			case ev := <-stream:
				if ev.T == typ {
					return
				}
			case <-deadline:
				t.Fatalf("never received %q", typ)
			}
		}
	}
	// ok-aware: returns on empty (default) OR closed (ok==false) — a plain
	// `case <-stream` would spin forever on a closed channel.
	drain := func() {
		for {
			select {
			case _, ok := <-stream:
				if !ok {
					return
				}
			default:
				return
			}
		}
	}

	if !h.OnlineUserIDs()[42] {
		t.Fatal("subscriber not counted online")
	}

	h.Broadcast("MESSAGE_CREATE", map[string]any{"x": 1})
	expect("MESSAGE_CREATE")

	h.SendToUser(42, "DIRECT_TO_42", nil)
	expect("DIRECT_TO_42")

	// an event for another user must not leak to this subscriber
	drain()
	h.SendToUser(99, "ONLY_99", nil)
	select {
	case ev := <-stream:
		if ev.T == "ONLY_99" {
			t.Fatal("event for user 99 leaked to user 42's subscriber")
		}
	case <-time.After(200 * time.Millisecond):
	}

	unsub()
	if h.OnlineUserIDs()[42] {
		t.Fatal("still online after unsubscribe")
	}
	// the stream must drain any buffered events and then report closed
	closed := false
	deadline := time.After(time.Second)
	for !closed {
		select {
		case _, ok := <-stream:
			if !ok {
				closed = true
			}
		case <-deadline:
			t.Fatal("stream not closed after unsubscribe")
		}
	}

	unsub() // idempotent — must not panic or double-decrement
}
