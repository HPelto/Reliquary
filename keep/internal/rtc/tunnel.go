// Package rtc tunnels the Keep's HTTP API (relic.v1) over a WebRTC DataChannel,
// so a client can reach the whole server through a hole-punched peer connection
// instead of a directly-reachable port.
//
// Signaling (the SDP offer/answer) happens over ordinary HTTP — which in
// production rides a Cloudflare tunnel or a small forwarded "handshake" port —
// while the actual API requests and responses flow peer-to-peer over the data
// channel, DTLS-encrypted for free. The genius is that we don't reimplement any
// endpoint: each framed request is replayed through the existing http.Handler,
// so the full middleware + router + auth stack is reused verbatim.
package rtc

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

// label is the data channel the client opens to carry the API.
const label = "relic"

// maxChunk is the payload bytes per data-channel message. SCTP/WebRTC caps the
// size of a single message (and it varies by stack), so larger payloads — big
// /world responses, media — are split into framed chunks and reassembled. 16 KiB
// is safe everywhere.
const maxChunk = 16 * 1024

// gatherCap bounds how long Answer() waits for ICE gathering before returning the
// SDP. Host candidates gather in milliseconds; this only bites when a slow or
// unreachable STUN/TURN server would otherwise stall every connect for seconds.
const gatherCap = 1200 * time.Millisecond

// gatewayPath is the pseudo-route a peer "GET"s over the data channel to open a
// realtime gateway subscription. It deliberately mirrors the HTTP gateway route,
// but it is NOT replayed through the handler — the gateway is a long-lived push
// stream, not a request/response, so the Tunnel handles it specially.
const gatewayPath = "/v1/gateway"

// wireRequest / wireResponse frame one API call. Body is []byte, which JSON
// encodes as base64, so binary payloads (media) survive intact. ID lets the
// client multiplex many in-flight requests over the one channel.
type wireRequest struct {
	ID      uint64            `json:"id"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    []byte            `json:"body,omitempty"`
}

type wireResponse struct {
	ID      uint64            `json:"id"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    []byte            `json:"body,omitempty"`
}

// GatewayEvent is one realtime push the server streams to a subscribed peer —
// the relic.v1 {t,d} envelope, identical to what the WebSocket gateway sends.
type GatewayEvent struct {
	T string `json:"t"`
	D any    `json:"d"`
}

// wirePush is a server→client frame carrying a gateway event rather than a
// response. The non-empty "gw" field is what the client uses to tell a push
// apart from a wireResponse on the shared channel.
type wirePush struct {
	Gw *GatewayEvent `json:"gw"`
}

// upstreamFrame is a client→server gateway frame (the {t,d} envelope), e.g. a
// presence change or voice-signaling message. D stays raw so the hub decodes it.
type upstreamFrame struct {
	T string          `json:"t"`
	D json.RawMessage `json:"d"`
}

// inboundFrame is the one shape the data channel carries client→server: an API
// request (id/method/path/…), OR a gateway upstream frame (the "up" field). The
// non-nil field decides which.
type inboundFrame struct {
	ID      uint64            `json:"id"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    []byte            `json:"body,omitempty"`
	Up      *upstreamFrame    `json:"up,omitempty"`
}

// Gateway turns an authenticated peer into a realtime event subscriber, so the
// data-channel transport can carry the relic.v1 gateway alongside request/
// response traffic. It is satisfied by the Keep (token auth + hub) and wired in
// by api.New, keeping this package free of any dependency on the api/gateway/
// store packages.
type Gateway interface {
	// Subscribe authenticates the bearer token and, if valid, begins delivering
	// gateway events to push until the returned stop is called. It returns the
	// userID the subscription belongs to (so upstream frames can be attributed).
	// push returns false once the peer's channel is gone, which the
	// implementation treats as an unsubscribe. ok is false for an invalid token.
	Subscribe(token string, push func(t string, d any) bool) (userID int64, stop func(), ok bool)
	// HandleInbound routes one client→server gateway frame (presence, voice
	// signaling) for an authenticated user.
	HandleInbound(userID int64, t string, d json.RawMessage)
}

// Tunnel answers WebRTC offers and serves an http.Handler over each peer's data
// channel. One Tunnel handles many peers.
type Tunnel struct {
	handler    http.Handler
	gw         Gateway                   // optional realtime gateway; nil = request/response only
	iceServers func() []webrtc.ICEServer // owner-configured STUN/TURN, read fresh per connect
	api        *webrtc.API               // media-capable (Opus) so the same PC can also carry voice
	cfg        webrtc.Configuration
	mu         sync.Mutex
	peers      map[*webrtc.PeerConnection]*session // session is nil until its channel opens
}

// New builds a Tunnel that serves handler over the data channel. iceServers are
// the STUN/TURN servers used for hole-punching (nil = host candidates only,
// enough for same-LAN / loopback). The PC is media-capable (default Opus codec +
// interceptors) so voice can later ride the same connection (A6b) — data-channel
// behavior is unaffected.
func New(handler http.Handler, iceServers []webrtc.ICEServer) *Tunnel {
	me := &webrtc.MediaEngine{}
	_ = me.RegisterDefaultCodecs()
	ir := &interceptor.Registry{}
	_ = webrtc.RegisterDefaultInterceptors(me, ir)
	api := webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithInterceptorRegistry(ir))
	return &Tunnel{
		handler: handler,
		api:     api,
		cfg:     webrtc.Configuration{ICEServers: iceServers},
		peers:   map[*webrtc.PeerConnection]*session{},
	}
}

// SetGateway enables the realtime gateway over the data channel: a peer that
// "GET"s gatewayPath becomes a subscriber whose hub events stream back as push
// frames. Without it, the Tunnel serves request/response only.
func (t *Tunnel) SetGateway(gw Gateway) { t.gw = gw }

// SetICEServers wires the owner-configured STUN/TURN set (read fresh per connect)
// so the answerer PC gathers the same relay candidates the client does.
func (t *Tunnel) SetICEServers(fn func() []webrtc.ICEServer) { t.iceServers = fn }

// Answer takes a client's SDP offer, stands up a peer connection whose data
// channel tunnels HTTP to the handler, and returns the SDP answer with all ICE
// candidates already gathered (non-trickle — one round trip, no candidate
// signaling channel needed).
func (t *Tunnel) Answer(offer webrtc.SessionDescription) (*webrtc.SessionDescription, error) {
	cfg := t.cfg
	if t.iceServers != nil {
		cfg.ICEServers = t.iceServers()
	}
	pc, err := t.api.NewPeerConnection(cfg)
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	t.peers[pc] = nil
	t.mu.Unlock()

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != label {
			return
		}
		sess := newSession(dc)
		sess.onMessage = func(data []byte) { go t.dispatch(sess, data) }
		dc.OnMessage(func(msg webrtc.DataChannelMessage) { sess.receive(msg.Data) })
		dc.OnClose(func() { sess.stopGateway() })
		t.mu.Lock()
		t.peers[pc] = sess
		t.mu.Unlock()
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateFailed,
			webrtc.PeerConnectionStateClosed,
			webrtc.PeerConnectionStateDisconnected:
			t.close(pc)
		}
	})

	if err := pc.SetRemoteDescription(offer); err != nil {
		t.close(pc)
		return nil, err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		t.close(pc)
		return nil, err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		t.close(pc)
		return nil, err
	}
	// Non-trickle, but capped: return as soon as gathering completes, or once the
	// cap elapses with whatever was gathered — so a slow/unreachable STUN server
	// can't stall every connect for seconds. Host candidates are already in; allow
	// longer when STUN/TURN is configured so reflexive/relay candidates can arrive.
	wait := gatherCap
	if len(cfg.ICEServers) > 0 {
		wait = 4 * time.Second
	}
	select {
	case <-gathered:
	case <-time.After(wait):
	}
	return pc.LocalDescription(), nil
}

// dispatch replays one framed request through the handler and sends the response
// back over the channel. Reusing the real handler means auth, middleware, and
// routing all behave exactly as they do over HTTP.
func (t *Tunnel) dispatch(sess *session, data []byte) {
	var f inboundFrame
	if err := json.Unmarshal(data, &f); err != nil {
		return
	}
	// A client→server gateway frame (presence change, voice signaling): route it
	// to the hub as this session's authenticated user. Ignored before subscribe.
	if f.Up != nil {
		if t.gw != nil {
			if uid, ok := sess.gatewayUser(); ok {
				t.gw.HandleInbound(uid, f.Up.T, f.Up.D)
			}
		}
		return
	}
	// A "GET" of gatewayPath opens a realtime subscription rather than a one-shot
	// response — it streams push frames until the channel closes, so it can't go
	// through the request/response recorder.
	if t.gw != nil && f.Method == http.MethodGet && f.Path == gatewayPath {
		t.subscribe(sess, f.Headers)
		return
	}
	httpReq, err := http.NewRequest(f.Method, f.Path, bytes.NewReader(f.Body))
	if err != nil {
		t.reply(sess, wireResponse{ID: f.ID, Status: http.StatusBadRequest})
		return
	}
	httpReq.RemoteAddr = "rtc:0" // satisfies RealIP middleware; the peer is not IP-addressable here
	for k, v := range f.Headers {
		httpReq.Header.Set(k, v)
	}

	rec := &recorder{header: http.Header{}, status: http.StatusOK}
	t.handler.ServeHTTP(rec, httpReq)

	resp := wireResponse{ID: f.ID, Status: rec.status, Body: rec.body.Bytes()}
	if ct := rec.header.Get("Content-Type"); ct != "" {
		resp.Headers = map[string]string{"Content-Type": ct}
	}
	t.reply(sess, resp)
}

func (t *Tunnel) reply(sess *session, resp wireResponse) {
	if out, err := json.Marshal(resp); err == nil {
		_ = sess.send(out)
	}
}

// subscribe turns this session into a gateway subscriber. The Gateway pushes each
// event through push, which marshals it as a gw frame and writes it to the
// channel; a failed write returns false so the Gateway drops the subscription.
// The stop func is held on the session and called on channel/peer close.
func (t *Tunnel) subscribe(sess *session, headers map[string]string) {
	token := strings.TrimPrefix(headers["Authorization"], "Bearer ")
	push := func(typ string, d any) bool {
		out, err := json.Marshal(wirePush{Gw: &GatewayEvent{T: typ, D: d}})
		if err != nil {
			return true // skip this one event; keep the subscription alive
		}
		return sess.send(out) == nil
	}
	userID, stop, ok := t.gw.Subscribe(token, push)
	if !ok {
		return // bad token — no subscription, no push (the client times out its open)
	}
	sess.setGateway(userID, stop)
}

// VoicePC returns the peer connection of the given user's subscribed session, or
// nil if they aren't connected over the transport. Lets the voice SFU borrow the
// same connection for shared-connection voice (A6b).
func (t *Tunnel) VoicePC(userID int64) *webrtc.PeerConnection {
	t.mu.Lock()
	defer t.mu.Unlock()
	for pc, sess := range t.peers {
		if sess == nil {
			continue
		}
		if uid, ok := sess.gatewayUser(); ok && uid == userID {
			return pc
		}
	}
	return nil
}

func (t *Tunnel) close(pc *webrtc.PeerConnection) {
	t.mu.Lock()
	sess := t.peers[pc]
	delete(t.peers, pc)
	t.mu.Unlock()
	if sess != nil {
		sess.stopGateway() // drop any gateway subscription so the user goes offline
	}
	_ = pc.Close()
}

// session adds message chunking + reassembly on top of a data channel, so
// payloads larger than the SCTP max message size split and rejoin transparently.
// Frame layout: [msgID uint32][index uint16][total uint16][payload].
type session struct {
	dc        *webrtc.DataChannel
	mu        sync.Mutex
	nextMsg   uint32
	incoming  map[uint32]*assembly
	onMessage func([]byte)

	gwMu   sync.Mutex
	gwUser int64  // the subscribed user (attributes upstream frames)
	gwOn   bool   // true while subscribed
	gwStop func() // tears down this session's gateway subscription, if any
}

// setGateway records the active subscription's user + unsubscribe, replacing
// (and stopping) any previous one — a session subscribes at most once at a time.
func (s *session) setGateway(userID int64, stop func()) {
	s.gwMu.Lock()
	old := s.gwStop
	s.gwUser = userID
	s.gwOn = true
	s.gwStop = stop
	s.gwMu.Unlock()
	if old != nil {
		old()
	}
}

// gatewayUser returns the subscribed user id, or ok=false if not subscribed.
func (s *session) gatewayUser() (int64, bool) {
	s.gwMu.Lock()
	defer s.gwMu.Unlock()
	return s.gwUser, s.gwOn
}

// stopGateway tears down the session's gateway subscription if it has one.
// Idempotent — safe to call on every channel/peer close.
func (s *session) stopGateway() {
	s.gwMu.Lock()
	s.gwOn = false
	stop := s.gwStop
	s.gwStop = nil
	s.gwMu.Unlock()
	if stop != nil {
		stop()
	}
}

type assembly struct {
	total uint16
	got   uint16
	parts [][]byte
}

func newSession(dc *webrtc.DataChannel) *session {
	return &session{dc: dc, incoming: map[uint32]*assembly{}}
}

// send splits payload into framed chunks and writes each as one binary message.
// Concurrent sends are safe — chunks carry their msgID, so interleaving on the
// wire reassembles correctly on the far side.
func (s *session) send(payload []byte) error {
	total := (len(payload) + maxChunk - 1) / maxChunk
	if total == 0 {
		total = 1 // always at least one frame, even for an empty payload
	}
	if total > 0xffff {
		return errors.New("rtc: payload too large to chunk")
	}
	s.mu.Lock()
	id := s.nextMsg
	s.nextMsg++
	s.mu.Unlock()

	for i := 0; i < total; i++ {
		start := i * maxChunk
		end := start + maxChunk
		if end > len(payload) {
			end = len(payload)
		}
		frame := make([]byte, 8+(end-start))
		binary.BigEndian.PutUint32(frame[0:], id)
		binary.BigEndian.PutUint16(frame[4:], uint16(i))
		binary.BigEndian.PutUint16(frame[6:], uint16(total))
		copy(frame[8:], payload[start:end])
		if err := s.dc.Send(frame); err != nil {
			return err
		}
	}
	return nil
}

// receive ingests one chunk; once a message is complete it fires onMessage.
func (s *session) receive(frame []byte) {
	if len(frame) < 8 {
		return
	}
	id := binary.BigEndian.Uint32(frame[0:])
	idx := binary.BigEndian.Uint16(frame[4:])
	total := binary.BigEndian.Uint16(frame[6:])
	if total == 0 {
		return
	}

	s.mu.Lock()
	a := s.incoming[id]
	if a == nil {
		a = &assembly{total: total, parts: make([][]byte, total)}
		s.incoming[id] = a
	}
	if int(idx) < len(a.parts) && a.parts[idx] == nil {
		a.parts[idx] = append([]byte(nil), frame[8:]...) // copy; pion reuses the buffer
		a.got++
	}
	done := a.got == a.total
	if done {
		delete(s.incoming, id)
	}
	s.mu.Unlock()

	if done && s.onMessage != nil {
		s.onMessage(bytes.Join(a.parts, nil))
	}
}

// recorder is a minimal in-memory http.ResponseWriter — like httptest's, but
// without pulling the test package into the server build.
type recorder struct {
	header http.Header
	body   bytes.Buffer
	status int
	wrote  bool
}

func (r *recorder) Header() http.Header { return r.header }
func (r *recorder) WriteHeader(code int) {
	if !r.wrote {
		r.status = code
		r.wrote = true
	}
}
func (r *recorder) Write(b []byte) (int, error) {
	r.wrote = true
	return r.body.Write(b)
}
