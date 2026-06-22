// Package gateway is the realtime side of the Keep: one WebSocket per
// client, JSON event envelopes, presence tracking.
package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
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
	online map[int64]int
	// state holds each connected user's chosen presence (online/idle/dnd/
	// invisible). Ephemeral — the client re-asserts it on connect.
	state   map[int64]string
	inbound Inbound
}

// SetInbound wires the handler for non-PING client frames (the voice manager).
func (h *Hub) SetInbound(in Inbound) { h.inbound = in }

func NewHub(st *store.Store) *Hub {
	return &Hub{
		st:     st,
		conns:  make(map[*conn]struct{}),
		online: make(map[int64]int),
		state:  make(map[int64]string),
	}
}

func validPresence(s string) bool {
	switch s {
	case "online", "idle", "dnd", "invisible":
		return true
	}
	return false
}

// effectiveStateLocked is the presence other members should see: offline when
// disconnected OR invisible, otherwise the chosen state (default online).
// Caller holds h.mu.
func (h *Hub) effectiveStateLocked(userID int64) string {
	if h.online[userID] <= 0 {
		return "offline"
	}
	s := h.state[userID]
	if s == "" {
		s = "online"
	}
	if s == "invisible" {
		return "offline" // hidden from others
	}
	return s
}

// setPresence records a user's chosen state and broadcasts the change.
func (h *Hub) setPresence(userID int64, state string) {
	h.mu.Lock()
	h.state[userID] = state
	h.mu.Unlock()
	h.broadcastPresence(userID)
}

// broadcastPresence tells every client the user's current wire-visible state.
func (h *Hub) broadcastPresence(userID int64) {
	h.mu.Lock()
	st := h.effectiveStateLocked(userID)
	h.mu.Unlock()
	h.Broadcast("PRESENCE_UPDATE", map[string]any{
		"user_id": userID,
		"online":  st != "offline",
		"state":   st,
	})
}

// PresenceSnapshot returns the wire-visible state for each connected user
// (offline/invisible users are absent — callers default them to "offline").
func (h *Hub) PresenceSnapshot() map[int64]string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make(map[int64]string, len(h.online))
	for id, n := range h.online {
		if n > 0 {
			if st := h.effectiveStateLocked(id); st != "offline" {
				out[id] = st
			}
		}
	}
	return out
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

// originAllowed authorizes the WebSocket upgrade's Origin. Browsers always send
// an Origin header they control, so we permit only origins that belong to our
// own client and reject any other web page (defense against cross-site
// WebSocket hijacking). Non-browser clients send no Origin and still have to
// pass token auth, so they're let through here.
//
// Note: the production Electron renderer loads from file://, whose Origin is the
// literal "null". That value is also producible by sandboxed iframes, so this is
// defense-in-depth layered on top of the per-connection token — not a sole gate.
func originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	switch origin {
	case "":
		return true // non-browser client (no Origin header)
	case "null":
		return true // Electron renderer from a file:// page (packaged build)
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if u.Host == r.Host {
		return true // same-origin (e.g. the Keep's own /admin pages)
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return true // Electron dev server
	}
	return false
}

// ServeHTTP upgrades GET /v1/gateway?token=… into a gateway connection.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// CSWSH guard: reject cross-site WebSocket upgrades from arbitrary web pages
	// before doing any work. A browser always sets Origin itself, so this stops a
	// malicious page from driving a reachable Keep's gateway.
	if !originAllowed(r) {
		http.Error(w, `{"error":"forbidden origin"}`, http.StatusForbidden)
		return
	}

	user, err := h.st.UserByToken(r.URL.Query().Get("token"))
	if err != nil {
		http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
		return
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin is validated above by originAllowed(). We skip the library's
		// built-in same-origin check because the Electron client connects from a
		// file:// page, whose Origin is "null" — which that check would reject.
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
		h.broadcastPresence(user.ID) // defaults to "online" until the client sets a state
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
		delete(h.state, user.ID)
	}
	h.mu.Unlock()

	if lastConn {
		if h.inbound != nil {
			h.inbound.Disconnect(user.ID) // user fully offline — tear down any voice session
		}
		h.broadcastPresence(user.ID) // now resolves to offline
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
		case ev.T == "PRESENCE_SET":
			var d struct {
				State string `json:"state"`
			}
			if json.Unmarshal(ev.D, &d) == nil && validPresence(d.State) {
				c.h.setPresence(c.userID, d.State)
			}
		case ev.T != "" && c.h.inbound != nil:
			c.h.inbound.HandleVoice(c.userID, ev.T, ev.D)
		}
	}
}
