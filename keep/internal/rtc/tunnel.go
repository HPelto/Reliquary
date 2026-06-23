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
	"encoding/json"
	"io"
	"net/http"
	"sync"

	"github.com/pion/webrtc/v4"
)

// label is the data channel the client opens to carry the API.
const label = "relic"

// wireRequest / wireResponse frame one API call over the channel. Body is []byte,
// which JSON encodes as base64, so binary payloads (media) survive intact. ID
// lets the client multiplex many in-flight requests over the one channel.
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

// Tunnel answers WebRTC offers and serves an http.Handler over each peer's data
// channel. One Tunnel handles many peers.
type Tunnel struct {
	handler http.Handler
	cfg     webrtc.Configuration
	mu      sync.Mutex
	peers   map[*webrtc.PeerConnection]struct{}
}

// New builds a Tunnel that serves handler over the data channel. iceServers are
// the STUN/TURN servers used for hole-punching (nil = host candidates only,
// enough for same-LAN / loopback).
func New(handler http.Handler, iceServers []webrtc.ICEServer) *Tunnel {
	return &Tunnel{
		handler: handler,
		cfg:     webrtc.Configuration{ICEServers: iceServers},
		peers:   map[*webrtc.PeerConnection]struct{}{},
	}
}

// Answer takes a client's SDP offer, stands up a peer connection whose data
// channel tunnels HTTP to the handler, and returns the SDP answer with all ICE
// candidates already gathered (non-trickle — one round trip, no candidate
// signaling channel needed).
func (t *Tunnel) Answer(offer webrtc.SessionDescription) (*webrtc.SessionDescription, error) {
	pc, err := webrtc.NewPeerConnection(t.cfg)
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	t.peers[pc] = struct{}{}
	t.mu.Unlock()

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != label {
			return
		}
		dc.OnMessage(func(msg webrtc.DataChannelMessage) { t.serve(dc, msg.Data) })
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
	<-gathered
	return pc.LocalDescription(), nil
}

// serve replays one framed request through the handler and writes the response
// back over the channel. Reusing the real handler means auth, middleware, and
// routing all behave exactly as they do over HTTP.
func (t *Tunnel) serve(dc *webrtc.DataChannel, data []byte) {
	var req wireRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return
	}
	httpReq, err := http.NewRequest(req.Method, req.Path, bytes.NewReader(req.Body))
	if err != nil {
		t.send(dc, wireResponse{ID: req.ID, Status: http.StatusBadRequest})
		return
	}
	httpReq.RemoteAddr = "rtc:0" // satisfies RealIP middleware; the peer is not IP-addressable here
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	rec := &recorder{header: http.Header{}, status: http.StatusOK}
	t.handler.ServeHTTP(rec, httpReq)

	resp := wireResponse{ID: req.ID, Status: rec.status, Body: rec.body.Bytes()}
	if ct := rec.header.Get("Content-Type"); ct != "" {
		resp.Headers = map[string]string{"Content-Type": ct}
	}
	t.send(dc, resp)
}

func (t *Tunnel) send(dc *webrtc.DataChannel, resp wireResponse) {
	if out, err := json.Marshal(resp); err == nil {
		_ = dc.Send(out)
	}
}

func (t *Tunnel) close(pc *webrtc.PeerConnection) {
	t.mu.Lock()
	delete(t.peers, pc)
	t.mu.Unlock()
	_ = pc.Close()
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

var _ io.Writer = (*recorder)(nil)
