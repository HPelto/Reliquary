// Package gateway is the realtime side of the Keep: one WebSocket per
// client, JSON event envelopes, presence tracking.
package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"reliquary.gg/keep/internal/store"
)

// Event is the relic.v1 wire envelope.
type Event struct {
	T string `json:"t"`
	D any    `json:"d"`
}

// Inbound handles client→server frames the hub doesn't itself understand
// (everything but PING). Satisfied by *voice.Manager — wired in by main so the
// gateway has no compile-time dependency on the voice package.
type Inbound interface {
	HandleVoice(userID int64, t string, d []byte)
	Disconnect(userID int64)
}

type conn struct {
	h      *Hub
	ws     *websocket.Conn
	userID int64
	send   chan Event
}

type Hub struct {
	st *store.Store

	mu    sync.Mutex
	conns map[*conn]struct{}
	// online counts connections per user so multi-device works.
	online  map[int64]int
	inbound Inbound
}

// SetInbound wires the handler for non-PING client frames (the voice manager).
func (h *Hub) SetInbound(in Inbound) { h.inbound = in }

func NewHub(st *store.Store) *Hub {
	return &Hub{
		st:     st,
		conns:  make(map[*conn]struct{}),
		online: make(map[int64]int),
	}
}

// Broadcast queues an event to every connected client. Slow clients are
// dropped rather than allowed to stall the hub.
func (h *Hub) Broadcast(t string, d any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns {
		select {
		case c.send <- Event{T: t, D: d}:
		default:
			// buffer full — abandon this connection; its writer will exit.
			delete(h.conns, c)
			close(c.send)
		}
	}
}

// SendToUser queues an event to every connection belonging to one user. Slow
// connections are dropped, matching Broadcast's policy.
func (h *Hub) SendToUser(userID int64, t string, d any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns {
		if c.userID != userID {
			continue
		}
		select {
		case c.send <- Event{T: t, D: d}:
		default:
			delete(h.conns, c)
			close(c.send)
		}
	}
}

// OnlineUserIDs returns the set of user ids with at least one connection.
func (h *Hub) OnlineUserIDs() map[int64]bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make(map[int64]bool, len(h.online))
	for id, n := range h.online {
		if n > 0 {
			out[id] = true
		}
	}
	return out
}

// ServeHTTP upgrades GET /v1/gateway?token=… into a gateway connection.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	user, err := h.st.UserByToken(r.URL.Query().Get("token"))
	if err != nil {
		http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
		return
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The Electron client connects from a file:// / app:// origin.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}

	c := &conn{h: h, ws: ws, userID: user.ID, send: make(chan Event, 64)}

	h.mu.Lock()
	h.conns[c] = struct{}{}
	h.online[user.ID]++
	firstConn := h.online[user.ID] == 1
	h.mu.Unlock()

	if firstConn {
		h.Broadcast("PRESENCE_UPDATE", map[string]any{"user_id": user.ID, "online": true})
	}

	ctx := r.Context()

	// hello: who you are, so the client can confirm identity post-upgrade.
	_ = wsjson.Write(ctx, ws, Event{T: "HELLO", D: map[string]any{"user": user}})

	go c.writeLoop(ctx)
	c.readLoop(ctx) // blocks until disconnect

	h.mu.Lock()
	if _, ok := h.conns[c]; ok {
		delete(h.conns, c)
		close(c.send)
	}
	h.online[user.ID]--
	lastConn := h.online[user.ID] == 0
	if lastConn {
		delete(h.online, user.ID)
	}
	h.mu.Unlock()

	if lastConn {
		if h.inbound != nil {
			h.inbound.Disconnect(user.ID) // user fully offline — tear down any voice session
		}
		h.Broadcast("PRESENCE_UPDATE", map[string]any{"user_id": user.ID, "online": false})
	}
	ws.Close(websocket.StatusNormalClosure, "bye")
}

func (c *conn) writeLoop(ctx context.Context) {
	for ev := range c.send {
		writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := wsjson.Write(writeCtx, c.ws, ev)
		cancel()
		if err != nil {
			return
		}
	}
}

// readLoop consumes client frames. PING is answered with PONG; VOICE_* frames
// are routed to the inbound handler (the SFU). Reading is also what lets us
// notice disconnects.
func (c *conn) readLoop(ctx context.Context) {
	for {
		var raw json.RawMessage
		if err := wsjson.Read(ctx, c.ws, &raw); err != nil {
			return
		}
		var ev struct {
			T string          `json:"t"`
			D json.RawMessage `json:"d"`
		}
		if json.Unmarshal(raw, &ev) != nil {
			continue
		}
		switch {
		case ev.T == "PING":
			select {
			case c.send <- Event{T: "PONG", D: nil}:
			default:
			}
		case ev.T != "" && c.h.inbound != nil:
			c.h.inbound.HandleVoice(c.userID, ev.T, ev.D)
		}
	}
}
