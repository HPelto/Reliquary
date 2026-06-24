// Package voice is the Keep's SFU (selective forwarding unit). Each client
// publishes one Opus mic track up over WebRTC; the Keep forwards a copy of it
// to every other participant in the same voice channel. Media never flows
// peer-to-peer, so participants never learn each other's IP addresses — the
// Keep stays the single public endpoint, in keeping with Reliquary's
// hide-the-IP privacy stance. Media is DTLS-SRTP encrypted in transit.
//
// Signaling rides the existing gateway WebSocket: the gateway routes VOICE_*
// frames here via the Inbound interface, and we reply through a Signaler
// (satisfied by the gateway Hub). Glare is avoided by a simple rule — the
// client offers only for its initial JOIN (its one mic track never changes);
// the server is the sole offerer for every later renegotiation.
package voice

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

// Signaler delivers gateway events. Satisfied by *gateway.Hub.
type Signaler interface {
	SendToUser(userID int64, t string, d any)
	Broadcast(t string, d any)
}

// PCProvider hands the SFU an already-connected peer connection for a user — the
// P2P data-channel transport's PC — so voice can ride that same connection
// instead of the SFU's own UDP port. Returns nil when the user isn't on the
// transport (then the SFU dials its own port, the legacy path). Satisfied by the
// api.Server (which owns the rtc.Tunnel); wired in by main.
type PCProvider interface {
	VoicePC(userID int64) *webrtc.PeerConnection
}

// Config tunes the SFU's network surface.
type Config struct {
	UDPPort  int    // single UDP port the SFU listens on (operator forwards this one port)
	PublicIP string // advertised host IP; empty = gather from interfaces (fine for localhost/public-bound)
}

// Manager owns every voice room on this Keep.
type Manager struct {
	api  *webrtc.API
	sig  Signaler
	pcOf PCProvider // optional: borrow the transport's PC for shared-connection voice

	mu    sync.Mutex
	rooms map[int64]*room // channelID -> room
	where map[int64]int64 // userID    -> channelID they're currently in
}

// SetPCProvider enables shared-connection voice: when a client joins with
// on_transport set and the provider has a PC for them, the SFU forwards over
// that existing peer connection instead of dialing its own UDP port.
func (m *Manager) SetPCProvider(p PCProvider) { m.pcOf = p }

type room struct {
	channelID int64
	parts     map[int64]*participant // userID -> participant
}

type participant struct {
	userID   int64
	pc       *webrtc.PeerConnection
	borrowed bool                        // pc is the transport's (shared) — never Close() it
	track    *webrtc.TrackLocalStaticRTP // forwarded copy of their mic; nil until OnTrack fires
	muted    bool
	deafened bool

	// negotiation bookkeeping (server is the only offerer post-join)
	pendingOffer bool                      // a server offer is awaiting the client's answer
	needResync   bool                      // track set changed while an offer was outstanding
	remoteReady  bool                      // remote description is set; safe to add ICE
	iceQueue     []webrtc.ICECandidateInit // candidates that arrived before remoteReady
}

// NewManager builds the SFU. It binds one UDP socket that all peer connections
// multiplex over, so the operator only has to forward a single extra port.
func NewManager(cfg Config, sig Signaler) (*Manager, error) {
	// Port 0 lets the OS assign a free port (used by tests so they don't clash
	// with a running Keep). The real server always passes 7011 via the -voice-port
	// flag, so the default lives there, not here.
	udp, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4zero, Port: cfg.UDPPort})
	if err != nil {
		return nil, fmt.Errorf("voice: bind udp :%d: %w", cfg.UDPPort, err)
	}

	se := webrtc.SettingEngine{}
	se.SetICEUDPMux(webrtc.NewICEUDPMux(logging.NewDefaultLoggerFactory().NewLogger("sfu"), udp))
	se.SetIncludeLoopbackCandidate(true) // so a localhost client can reach a localhost Keep in dev
	if cfg.PublicIP != "" {
		// Srflx (not Host): ADD a reflexive candidate for the public IP while KEEPING
		// the LAN/host candidates — so internet peers use the public address and LAN
		// peers keep using the local one. Host mode would replace the LAN address and
		// break voice for anyone on the same network (no router hairpinning needed).
		se.SetNAT1To1IPs([]string{cfg.PublicIP}, webrtc.ICECandidateTypeSrflx)
	}

	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		return nil, fmt.Errorf("voice: codecs: %w", err)
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(me, ir); err != nil {
		return nil, fmt.Errorf("voice: interceptors: %w", err)
	}

	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(me),
		webrtc.WithInterceptorRegistry(ir),
		webrtc.WithSettingEngine(se),
	)

	return &Manager{
		api:   api,
		sig:   sig,
		rooms: make(map[int64]*room),
		where: make(map[int64]int64),
	}, nil
}

// ── inbound gateway frames ───────────────────────────────────────────────────

// HandleVoice dispatches a VOICE_* frame from userID. d is the raw JSON payload.
func (m *Manager) HandleVoice(userID int64, t string, d []byte) {
	switch t {
	case "VOICE_JOIN":
		var p struct {
			ChannelID   int64                     `json:"channel_id"`
			SDP         webrtc.SessionDescription `json:"sdp"`
			OnTransport bool                      `json:"on_transport"`
		}
		if jsonUnmarshal(d, &p) == nil {
			m.join(userID, p.ChannelID, p.SDP, p.OnTransport)
		}
	case "VOICE_ANSWER":
		var p struct {
			SDP webrtc.SessionDescription `json:"sdp"`
		}
		if jsonUnmarshal(d, &p) == nil {
			m.answer(userID, p.SDP)
		}
	case "VOICE_ICE":
		var p struct {
			Candidate webrtc.ICECandidateInit `json:"candidate"`
		}
		if jsonUnmarshal(d, &p) == nil {
			m.addICE(userID, p.Candidate)
		}
	case "VOICE_STATE":
		var p struct {
			Muted    bool `json:"muted"`
			Deafened bool `json:"deafened"`
		}
		if jsonUnmarshal(d, &p) == nil {
			m.setState(userID, p.Muted, p.Deafened)
		}
	case "VOICE_LEAVE":
		m.remove(userID)
	}
}

// Disconnect is called by the gateway when a user's last socket drops.
func (m *Manager) Disconnect(userID int64) { m.remove(userID) }

// ── join / renegotiation ─────────────────────────────────────────────────────

func (m *Manager) join(userID, channelID int64, offer webrtc.SessionDescription, onTransport bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// leaving any prior channel first makes JOIN double as "switch channel".
	if prev, ok := m.where[userID]; ok {
		m.removeLocked(userID, prev)
	}

	// Shared-connection voice: borrow the transport's already-connected PC so the
	// mic rides the same hole-punched link (no separate SFU port). Adding the
	// audio is a renegotiation that reuses the existing ICE/DTLS — no new ICE.
	var pc *webrtc.PeerConnection
	borrowed := false
	if onTransport && m.pcOf != nil {
		if bp := m.pcOf.VoicePC(userID); bp != nil {
			pc, borrowed = bp, true
		}
	}
	if pc == nil {
		var err error
		if pc, err = m.api.NewPeerConnection(webrtc.Configuration{}); err != nil {
			return
		}
	}

	p := &participant{userID: userID, pc: pc, borrowed: borrowed}
	r := m.rooms[channelID]
	if r == nil {
		r = &room{channelID: channelID, parts: make(map[int64]*participant)}
		m.rooms[channelID] = r
	}
	r.parts[userID] = p
	m.where[userID] = channelID
	log.Printf("voice: user %d joining channel %d (transport=%v)", userID, channelID, borrowed)

	// A borrowed PC is owned by the transport: its ICE is already up (no new
	// candidates to trickle) and its connection-state/teardown is the transport's
	// job — setting those handlers here would CLOBBER the transport's own ones.
	// So a borrowed PC gets only OnTrack.
	if !borrowed {
		pc.OnICECandidate(func(c *webrtc.ICECandidate) {
			if c == nil {
				return
			}
			m.sig.SendToUser(userID, "VOICE_ICE", map[string]any{"candidate": c.ToJSON()})
		})
		pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
			log.Printf("voice: user %d connection state: %s", userID, s)
			if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
				m.remove(userID)
			}
		})
	}
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		m.onTrack(channelID, userID, remote)
	})

	if err := pc.SetRemoteDescription(offer); err != nil {
		m.removeLocked(userID, channelID)
		return
	}
	p.remoteReady = true
	p.flushICELocked()

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		m.removeLocked(userID, channelID)
		return
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		m.removeLocked(userID, channelID)
		return
	}
	m.sig.SendToUser(userID, "VOICE_ANSWER", map[string]any{"sdp": pc.LocalDescription()})

	// push any already-talking participants' tracks down to the newcomer, and
	// tell everyone who's now in the room.
	m.signalLocked(r)
	m.broadcastStateLocked(channelID, r)
}

// onTrack fires when a participant's mic RTP starts arriving. We wrap it in a
// local track and fan it out to everyone else, copying RTP packets verbatim.
func (m *Manager) onTrack(channelID, userID int64, remote *webrtc.TrackRemote) {
	local, err := webrtc.NewTrackLocalStaticRTP(
		remote.Codec().RTPCodecCapability,
		fmt.Sprintf("mic-%d", userID),
		fmt.Sprintf("user-%d", userID),
	)
	if err != nil {
		return
	}

	m.mu.Lock()
	r := m.rooms[channelID]
	p := participantIn(r, userID)
	if p == nil {
		m.mu.Unlock()
		return
	}
	p.track = local
	m.signalLocked(r) // existing peers now subscribe to this newcomer
	m.mu.Unlock()

	buf := make([]byte, 1500)
	for {
		n, _, err := remote.Read(buf)
		if err != nil {
			return // remote closed (participant left) — stop forwarding
		}
		if _, err := local.Write(buf[:n]); err != nil && err != io.ErrClosedPipe {
			return
		}
	}
}

// signalLocked reconciles every participant's outbound senders with who is
// currently talking in the room, renegotiating any peer whose track set changed.
func (m *Manager) signalLocked(r *room) {
	if r == nil {
		return
	}
	for _, p := range r.parts {
		if p.pc == nil {
			continue
		}
		have := map[webrtc.TrackLocal]*webrtc.RTPSender{}
		for _, s := range p.pc.GetSenders() {
			if s.Track() != nil {
				have[s.Track()] = s
			}
		}
		changed := false
		// subscribe to every other participant's mic
		for _, other := range r.parts {
			if other.userID == p.userID || other.track == nil {
				continue
			}
			if _, ok := have[other.track]; !ok {
				if _, err := p.pc.AddTrack(other.track); err == nil {
					changed = true
				}
			}
		}
		// drop senders for tracks that left
		for tr, s := range have {
			wanted := false
			for _, other := range r.parts {
				if other.userID != p.userID && webrtc.TrackLocal(other.track) == tr {
					wanted = true
					break
				}
			}
			if !wanted {
				if err := p.pc.RemoveTrack(s); err == nil {
					changed = true
				}
			}
		}
		if changed {
			m.negotiateLocked(p)
		}
	}
}

// negotiateLocked makes the server send a fresh offer to one peer. If an offer
// is already outstanding, it defers until the pending one is answered.
func (m *Manager) negotiateLocked(p *participant) {
	if p.pendingOffer {
		p.needResync = true
		return
	}
	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		return
	}
	if err := p.pc.SetLocalDescription(offer); err != nil {
		return
	}
	p.pendingOffer = true
	m.sig.SendToUser(p.userID, "VOICE_OFFER", map[string]any{"sdp": p.pc.LocalDescription()})
}

func (m *Manager) answer(userID int64, sdp webrtc.SessionDescription) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.roomOf(userID)
	p := participantIn(r, userID)
	if p == nil {
		return
	}
	if err := p.pc.SetRemoteDescription(sdp); err != nil {
		return
	}
	p.pendingOffer = false
	if p.needResync {
		p.needResync = false
		m.signalLocked(r)
	}
}

func (m *Manager) addICE(userID int64, c webrtc.ICECandidateInit) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := participantIn(m.roomOf(userID), userID)
	if p == nil {
		return
	}
	if !p.remoteReady {
		p.iceQueue = append(p.iceQueue, c) // can't add before a remote description exists
		return
	}
	_ = p.pc.AddICECandidate(c)
}

func (p *participant) flushICELocked() {
	for _, c := range p.iceQueue {
		_ = p.pc.AddICECandidate(c)
	}
	p.iceQueue = nil
}

func (m *Manager) setState(userID int64, muted, deafened bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cid, ok := m.where[userID]
	if !ok {
		return
	}
	r := m.rooms[cid]
	p := participantIn(r, userID)
	if p == nil {
		return
	}
	p.muted, p.deafened = muted, deafened
	m.broadcastStateLocked(cid, r)
}

// ── leaving ──────────────────────────────────────────────────────────────────

func (m *Manager) remove(userID int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cid, ok := m.where[userID]
	if !ok {
		return
	}
	m.removeLocked(userID, cid)
}

func (m *Manager) removeLocked(userID, channelID int64) {
	r := m.rooms[channelID]
	if r == nil {
		delete(m.where, userID)
		return
	}
	if p := r.parts[userID]; p != nil && p.pc != nil {
		if p.borrowed {
			// Shared transport PC: NEVER Close() it — that would kill the data
			// channel too. Leftover senders are harmless and get reconciled by
			// signalLocked on the user's next join; the client tears down its own
			// audio. We deliberately don't renegotiate here (it would glare with the
			// client's own teardown).
		} else {
			_ = p.pc.Close() // closing tears down senders; remote.Read in onTrack unblocks
		}
	}
	delete(r.parts, userID)
	delete(m.where, userID)

	m.signalLocked(r) // others drop the departed track and renegotiate
	if len(r.parts) == 0 {
		delete(m.rooms, channelID)
	}
	m.broadcastStateLocked(channelID, r)
}

// ── state broadcast ──────────────────────────────────────────────────────────

// Participant / ChannelState mirror the VOICE_STATE_UPDATE payload shape, so a
// Snapshot can seed a freshly-connected client with current occupancy.
type Participant struct {
	UserID   int64 `json:"user_id"`
	Muted    bool  `json:"muted"`
	Deafened bool  `json:"deafened"`
}
type ChannelState struct {
	ChannelID    int64         `json:"channel_id"`
	Participants []Participant `json:"participants"`
}

// Snapshot returns current voice occupancy for every non-empty channel. The
// world endpoint includes it so users see who is in a voice channel BEFORE
// joining — live VOICE_STATE_UPDATE broadcasts only fire on join/leave, which a
// just-connected client would otherwise miss.
func (m *Manager) Snapshot() []ChannelState {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []ChannelState{}
	for cid, r := range m.rooms {
		if r == nil || len(r.parts) == 0 {
			continue
		}
		cs := ChannelState{ChannelID: cid, Participants: []Participant{}}
		for _, p := range r.parts {
			cs.Participants = append(cs.Participants, Participant{UserID: p.userID, Muted: p.muted, Deafened: p.deafened})
		}
		out = append(out, cs)
	}
	return out
}

// broadcastStateLocked tells EVERY gateway client who is in this voice channel,
// so the channel list can show occupants even to users who haven't joined.
func (m *Manager) broadcastStateLocked(channelID int64, r *room) {
	type pview struct {
		UserID   int64 `json:"user_id"`
		Muted    bool  `json:"muted"`
		Deafened bool  `json:"deafened"`
	}
	parts := []pview{}
	if r != nil {
		for _, p := range r.parts {
			parts = append(parts, pview{UserID: p.userID, Muted: p.muted, Deafened: p.deafened})
		}
	}
	m.sig.Broadcast("VOICE_STATE_UPDATE", map[string]any{
		"channel_id":   channelID,
		"participants": parts,
	})
}

// ── helpers ──────────────────────────────────────────────────────────────────

func (m *Manager) roomOf(userID int64) *room {
	cid, ok := m.where[userID]
	if !ok {
		return nil
	}
	return m.rooms[cid]
}

func participantIn(r *room, userID int64) *participant {
	if r == nil {
		return nil
	}
	return r.parts[userID]
}

func jsonUnmarshal(d []byte, v any) error { return json.Unmarshal(d, v) }
