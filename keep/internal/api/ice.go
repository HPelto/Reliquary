package api

import (
	"encoding/json"
	"net/http"

	"github.com/pion/webrtc/v4"
)

// ICE (STUN/TURN) configuration for the P2P transport. Off by default — on
// LAN/loopback host candidates suffice. An owner who hosts beyond their LAN sets
// their OWN servers here (never a hardcoded third party): STUN for hole-punch
// discovery, TURN to relay when a direct path fails. force_relay makes clients
// use TURN only, so members see the relay's IP and never the Keep's home IP.
const (
	SettingICEServers = "ice_servers" // JSON array of RTCIceServer-shaped objects
	SettingForceRelay = "force_relay" // "1" = clients must relay through TURN only
)

type iceServerCfg struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

func (s *Server) iceConfig() ([]iceServerCfg, bool) {
	servers := []iceServerCfg{}
	if raw, _ := s.st.GetSetting(SettingICEServers); raw != "" {
		_ = json.Unmarshal([]byte(raw), &servers)
	}
	force, _ := s.st.GetSetting(SettingForceRelay)
	return servers, force == "1"
}

// tunnelICEServers is the configured ICE set in pion's type, so the Keep's
// answerer PC gathers the same relay candidates the client does.
func (s *Server) tunnelICEServers() []webrtc.ICEServer {
	cfgs, _ := s.iceConfig()
	out := make([]webrtc.ICEServer, 0, len(cfgs))
	for _, c := range cfgs {
		ice := webrtc.ICEServer{URLs: c.URLs, Username: c.Username}
		if c.Credential != "" {
			ice.Credential = c.Credential
		}
		out = append(out, ice)
	}
	return out
}

// handleRTCICE (public) hands a client the ICE servers to build its transport
// peer connection with. It must be fetched over HTTP BEFORE the P2P connect (the
// servers are needed to gather candidates), so it can't ride the channel. Public
// because it's pre-auth; an owner who puts TURN credentials here accepts they're
// readable by anyone who can reach the Keep.
func (s *Server) handleRTCICE(w http.ResponseWriter, r *http.Request) {
	servers, force := s.iceConfig()
	writeJSON(w, http.StatusOK, map[string]any{"ice_servers": servers, "force_relay": force})
}

// handleHostICE (host only) sets the ICE servers + force-relay policy. Takes
// effect on the next connect (clients fetch it fresh each time).
func (s *Server) handleHostICE(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ICEServers []iceServerCfg `json:"ice_servers"`
		ForceRelay bool           `json:"force_relay"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad ice config")
		return
	}
	blob, _ := json.Marshal(req.ICEServers)
	_ = s.st.SetSetting(SettingICEServers, string(blob))
	relay := "0"
	if req.ForceRelay {
		relay = "1"
	}
	_ = s.st.SetSetting(SettingForceRelay, relay)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
