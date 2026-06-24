// Package gateway is the realtime side of the Keep: one WebSocket per
// client, JSON event envelopes, presence tracking.
package gateway

import (
	"context"
	"encoding/json"
	"log"
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

// sub is a non-WebSocket gateway listener — a client reached over the RTC data
// channel transport. It receives the same event stream as a WebSocket conn and
// counts toward presence, but has no ws/readLoop; its events are forwarded by
// the RTC layer.
type sub struct {
	userID int64
	send   chan Event
	once   sync.Once // tear down exactly once (RTC-layer unsub OR force-disconnect)
}

type Hub struct {
	st *store.Store

	mu    sync.Mutex
	conns map[*conn]struct{}
	subs  map[*sub]struct{}
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
		subs:   make(map[*sub]struct{}),
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
	ev := Event{T: t, D: d}
	for c := range h.conns {
		select {
		case c.send <- ev:
		default:
			// buffer full — abandon this connection; its writer will exit.
			delete(h.conns, c)
			close(c.send)
		}
	}
	for s := range h.subs {
		select {
		case s.send <- ev:
		default:
			// drop the event (the client resyncs); keep the subscription, which
			// the RTC layer owns and tears down on channel close.
		}
	}
}

// Subscribe registers a non-WebSocket gateway listener (the RTC transport). It
// returns the event stream to forward to that client and an unsubscribe func,
// and counts toward presence exactly like a WebSocket connection. The channel is
// buffered; an overwhelmed consumer loses individual events (and resyncs), never
// the whole subscription. unsubscribe is idempotent.
func (h *Hub) Subscribe(userID int64) (<-chan Event, func()) {
	s := &sub{userID: userID, send: make(chan Event, 64)}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.online[userID]++
	firstConn := h.online[userID] == 1
	h.mu.Unlock()
	if firstConn {
		h.broadcastPresence(userID)
	}
	return s.send, func() { h.removeSub(s) }
}

// removeSub tears down one RTC subscription exactly once — whether the RTC layer
// unsubscribes on channel close or DisconnectUser force-drops it — updating
// presence exactly like a WebSocket disconnect.
func (h *Hub) removeSub(s *sub) {
	s.once.Do(func() {
		h.mu.Lock()
		delete(h.subs, s)
		close(s.send)
		h.online[s.userID]--
		lastConn := h.online[s.userID] == 0
		if lastConn {
			delete(h.online, s.userID)
			delete(h.state, s.userID)
		}
		h.mu.Unlock()
		if lastConn {
			if h.inbound != nil {
				h.inbound.Disconnect(s.userID)
			}
			h.broadcastPresence(s.userID)
		}
	})
}

// DisconnectUser force-drops every live connection (WebSocket + RTC) for a user,
// so a session revocation takes effect immediately instead of lingering on an
// already-open channel that no longer re-checks the token. Returns how many
// connections were dropped.
func (h *Hub) DisconnectUser(userID int64) int {
	h.mu.Lock()
	var wsConns []*conn
	var rtcSubs []*sub
	for c := range h.conns {
		if c.userID == userID {
			wsConns = append(wsConns, c)
		}
	}
	for s := range h.subs {
		if s.userID == userID {
			rtcSubs = append(rtcSubs, s)
		}
	}
	h.mu.Unlock()

	// WebSocket: closing the socket unblocks readLoop, which runs the normal
	// ServeHTTP cleanup (presence + online count). Don't close its send channel
	// here — that would race the cleanup's own close.
	for _, c := range wsConns {
		c.ws.Close(websocket.StatusPolicyViolation, "session revoked")
	}
	// RTC: tear down via removeSub (idempotent with the RTC layer's own unsub).
	for _, s := range rtcSubs {
		h.removeSub(s)
	}
	return len(wsConns) + len(rtcSubs)
}

// SendToUser queues an event to every connection belonging to one user. Slow
// connections are dropped, matching Broadcast's policy.
func (h *Hub) SendToUser(userID int64, t string, d any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ev := Event{T: t, D: d}
	for c := range h.conns {
		if c.userID != userID {
			continue
		}
		select {
		case c.send <- ev:
		default:
			delete(h.conns, c)
			close(c.send)
		}
	}
	for s := range h.subs {
		if s.userID != userID {
			continue
		}
		select {
		case s.send <- ev:
		default:
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

// originAllowed authorizes the WebSocket upgrade's Origin. A real browser always
// sends an Origin header it controls, so we permit only origins that belong to
// our own desktop client and reject any other web page (defense against
// cross-site WebSocket hijacking). Non-browser clients send no Origin and still
// have to pass token auth, so they're let through here.
//
// The packaged Electron client loads from file://, whose Origin is sent as
// either the literal "null" or "file://" depending on the Chromium build — both
// are local-only and impossible for a remote attacker page to forge, so both are
// allowed. This is defense-in-depth on top of the per-connection token.
func originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	switch origin {
	case "", "null":
		return true // non-browser client, or an Electron file:// page (opaque origin)
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	switch u.Scheme {
	case "file", "app", "tauri":
		return true // packaged desktop clients (file://, custom app protocols)
	}
	if u.Host == r.Host {
		return true // same-origin (e.g. the Keep's own /admin pages)
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return true // dev server / local console
	}
	return false
}

// ServeHTTP upgrades GET /v1/gateway?token=… into a gateway connection.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// CSWSH guard: reject cross-site WebSocket upgrades from arbitrary web pages
	// before doing any work. A browser always sets Origin itself, so this stops a
	// malicious page from driving a reachable Keep's gateway.
	if !originAllowed(r) {
		log.Printf("gateway: rejected upgrade from disallowed Origin %q", r.Header.Get("Origin"))
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
		// PING answers on THIS exact connection, so it stays here; everything else
		// goes through the shared inbound router (also used by the RTC upstream).
		if ev.T == "PING" {
			select {
			case c.send <- Event{T: "PONG", D: nil}:
			default:
			}
			continue
		}
		c.h.RouteInbound(c.userID, ev.T, ev.D)
	}
}

// RouteInbound dispatches a client→server gateway frame that isn't connection-
// specific — a presence change or voice signaling — so the WebSocket read loop
// and the RTC data-channel upstream share one path.
func (h *Hub) RouteInbound(userID int64, t string, d json.RawMessage) {
	switch {
	case t == "PRESENCE_SET":
		var p struct {
			State string `json:"state"`
		}
		if json.Unmarshal(d, &p) == nil && validPresence(p.State) {
			h.setPresence(userID, p.State)
		}
	case t != "" && h.inbound != nil:
		h.inbound.HandleVoice(userID, t, d)
	}
}
