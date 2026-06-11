package voice

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// testHarness routes signaling between the real Manager and a set of in-process
// pion "clients". The Manager's Signaler calls are delivered to each client
// ASYNCHRONOUSLY (on the client's own goroutine) — exactly like the real
// gateway, and necessary to avoid re-entering the Manager's mutex.
type testHarness struct {
	mgr     *Manager
	mu      sync.Mutex
	clients map[int64]*testClient
	states  chan map[int64]bool // each VOICE_STATE_UPDATE -> set of user ids present
}

func newHarness(t *testing.T) *testHarness {
	t.Helper()
	h := &testHarness{
		clients: map[int64]*testClient{},
		states:  make(chan map[int64]bool, 64),
	}
	mgr, err := NewManager(Config{UDPPort: 0}, h) // port 0 = OS-assigned, avoids clashes
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	h.mgr = mgr
	return h
}

func (h *testHarness) SendToUser(userID int64, t string, d any) {
	raw, _ := json.Marshal(d)
	h.mu.Lock()
	c := h.clients[userID]
	h.mu.Unlock()
	if c != nil {
		c.inbox <- inMsg{t: t, d: raw} // async: client goroutine handles it
	}
}

func (h *testHarness) Broadcast(t string, d any) {
	if t != "VOICE_STATE_UPDATE" {
		return
	}
	raw, _ := json.Marshal(d)
	var p struct {
		Participants []struct {
			UserID int64 `json:"user_id"`
		} `json:"participants"`
	}
	_ = json.Unmarshal(raw, &p)
	set := map[int64]bool{}
	for _, pp := range p.Participants {
		set[pp.UserID] = true
	}
	select {
	case h.states <- set:
	default:
	}
}

type inMsg struct {
	t string
	d []byte
}

type testClient struct {
	userID    int64
	pc        *webrtc.PeerConnection
	inbox     chan inMsg
	gotTrack  chan struct{}
	trackOnce sync.Once

	mu          sync.Mutex
	remoteReady bool
	iceQueue    []webrtc.ICECandidateInit
}

// clientAPI mirrors the server's media engine and also advertises a loopback
// candidate so two pion peers on one machine can pair.
func clientAPI(t *testing.T) *webrtc.API {
	t.Helper()
	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		t.Fatalf("client codecs: %v", err)
	}
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	return webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithSettingEngine(se))
}

// addClient creates a pion client, publishes a silent Opus track, joins the
// channel, and starts processing server signaling.
func (h *testHarness) addClient(t *testing.T, api *webrtc.API, userID, channelID int64) *testClient {
	t.Helper()
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("client pc: %v", err)
	}
	c := &testClient{userID: userID, pc: pc, inbox: make(chan inMsg, 64), gotTrack: make(chan struct{})}

	h.mu.Lock()
	h.clients[userID] = c
	h.mu.Unlock()

	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "mic")
	if err != nil {
		t.Fatalf("client track: %v", err)
	}
	if _, err := pc.AddTrack(track); err != nil {
		t.Fatalf("client addtrack: %v", err)
	}

	pc.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if cand == nil {
			return
		}
		h.toServer(userID, "VOICE_ICE", map[string]any{"candidate": cand.ToJSON()})
	})
	pc.OnTrack(func(_ *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		c.trackOnce.Do(func() { close(c.gotTrack) })
	})

	// process server -> client signaling on the client's own goroutine
	go func() {
		for m := range c.inbox {
			c.handle(h, m)
		}
	}()

	// continuously emit Opus frames so RTP flows once ICE connects
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		frame := make([]byte, 60) // arbitrary payload; content is irrelevant to forwarding
		for range ticker.C {
			if pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
				return
			}
			_ = track.WriteSample(media.Sample{Data: frame, Duration: 20 * time.Millisecond})
		}
	}()

	// initial offer (client is offerer only for JOIN)
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("client offer: %v", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("client setlocal: %v", err)
	}
	h.toServer(userID, "VOICE_JOIN", map[string]any{"channel_id": channelID, "sdp": pc.LocalDescription()})
	return c
}

func (h *testHarness) toServer(userID int64, t string, d any) {
	raw, _ := json.Marshal(d)
	h.mgr.HandleVoice(userID, t, raw)
}

func (c *testClient) handle(h *testHarness, m inMsg) {
	switch m.t {
	case "VOICE_ANSWER":
		var p struct {
			SDP webrtc.SessionDescription `json:"sdp"`
		}
		_ = json.Unmarshal(m.d, &p)
		_ = c.pc.SetRemoteDescription(p.SDP)
		c.markRemoteReady()
	case "VOICE_OFFER":
		var p struct {
			SDP webrtc.SessionDescription `json:"sdp"`
		}
		_ = json.Unmarshal(m.d, &p)
		if c.pc.SetRemoteDescription(p.SDP) != nil {
			return
		}
		c.markRemoteReady()
		ans, err := c.pc.CreateAnswer(nil)
		if err != nil {
			return
		}
		if c.pc.SetLocalDescription(ans) != nil {
			return
		}
		h.toServer(c.userID, "VOICE_ANSWER", map[string]any{"sdp": c.pc.LocalDescription()})
	case "VOICE_ICE":
		var p struct {
			Candidate webrtc.ICECandidateInit `json:"candidate"`
		}
		_ = json.Unmarshal(m.d, &p)
		c.mu.Lock()
		if !c.remoteReady {
			c.iceQueue = append(c.iceQueue, p.Candidate)
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()
		_ = c.pc.AddICECandidate(p.Candidate)
	}
}

func (c *testClient) markRemoteReady() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.remoteReady {
		return
	}
	c.remoteReady = true
	for _, cand := range c.iceQueue {
		_ = c.pc.AddICECandidate(cand)
	}
	c.iceQueue = nil
}

// TestSFUForwardsAudioBetweenParticipants is the headless proof for the SFU:
// two pion clients join one room; the second must receive the first's
// forwarded track, and the room state must list both.
func TestSFUForwardsAudioBetweenParticipants(t *testing.T) {
	h := newHarness(t)
	api := clientAPI(t)
	const channelID = 42

	a := h.addClient(t, api, 1, channelID)

	// wait until A's mic is actually flowing through the SFU before B joins,
	// so B's join-time renegotiation already includes A's track.
	if !waitTrack(h.mgr, channelID, 1, 5*time.Second) {
		t.Fatal("server never received participant A's track")
	}

	b := h.addClient(t, api, 2, channelID)

	select {
	case <-b.gotTrack:
		// B received A's forwarded audio — success
	case <-time.After(8 * time.Second):
		t.Fatal("participant B never received a forwarded track")
	}

	// room state should eventually report both participants
	if !waitState(h.states, map[int64]bool{1: true, 2: true}, 3*time.Second) {
		t.Fatal("VOICE_STATE_UPDATE never listed both participants")
	}

	_ = a.pc.Close()
	_ = b.pc.Close()
}

// waitTrack polls the manager until the given user has a forwardable track.
func waitTrack(m *Manager, channelID, userID int64, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		r := m.rooms[channelID]
		ok := r != nil && r.parts[userID] != nil && r.parts[userID].track != nil
		m.mu.Unlock()
		if ok {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func waitState(states chan map[int64]bool, want map[int64]bool, timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		select {
		case s := <-states:
			if len(s) == len(want) {
				match := true
				for k := range want {
					if !s[k] {
						match = false
						break
					}
				}
				if match {
					return true
				}
			}
		case <-deadline:
			return false
		}
	}
}
