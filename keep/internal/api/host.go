package api

// Host-only endpoints: server-side configuration that must never be
// reachable with a (possibly stolen) client token — keep password, role
// assignment, user removal, listen address. See admin.go for the tiers.

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"

	"reliquary.gg/keep/internal/store"
	"reliquary.gg/keep/internal/update"
)

func (s *Server) handleHostState(w http.ResponseWriter, r *http.Request) {
	members, err := s.st.Members()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	online := s.hub.OnlineUserIDs()
	type member struct {
		store.User
		Online bool `json:"online"`
	}
	mout := make([]member, 0, len(members))
	for _, m := range members {
		mout = append(mout, member{User: m, Online: online[m.ID]})
	}

	pwHash, _ := s.st.GetSetting(SettingKeepPasswordHash)
	addr, _ := s.st.GetSetting(SettingAddr)
	channels, _ := s.st.Channels()
	invites, _ := s.st.Invites()
	tlsEnabled, _ := s.st.GetSetting(SettingTLSEnabled)
	tlsCert, _ := s.st.GetSetting(SettingTLSCertPath)
	tlsKey, _ := s.st.GetSetting(SettingTLSKeyPath)
	maxUploadMB := int(s.maxUploadBytes() >> 20)
	voicePort := defaultVoicePort
	if v, _ := s.st.GetSetting(SettingVoicePort); v != "" {
		if p, err := strconv.Atoi(v); err == nil && p > 0 {
			voicePort = p
		}
	}

	latest, behind, checked, updErr := s.updateStatus()
	writeJSON(w, http.StatusOK, map[string]any{
		"name":              s.instanceName(),
		"version":           ServerVersion,
		"protocol":          ProtocolVersion,
		"users":             mout,
		"keep_password_set": pwHash != "",
		"addr":              addr,
		"voice_port":        voicePort,
		"channel_count":     len(channels),
		"invite_count":      len(invites),
		"online_count":      len(online),
		"restart_available": s.restartFn != nil,
		"update_available":  s.applyUpdate() != nil,
		"self_update":       s.selfUpdate != nil,
		"latest_version":    latest,
		"update_behind":     behind,
		"update_checked":    checked,
		"update_error":      updErr,
		"tls_enabled":       tlsEnabled == "1",
		"tls_cert_path":     tlsCert,
		"tls_key_path":      tlsKey,
		"max_upload_mb":     maxUploadMB,
	})
}

type voicePortReq struct {
	Port int `json:"port"`
}

// handleHostVoicePort stores the SFU's UDP voice port; applies on restart. The
// client learns the new port automatically from the server's ICE candidates, so
// changing it doesn't break connected clients — but the owner must forward the
// new UDP port for internet voice.
func (s *Server) handleHostVoicePort(w http.ResponseWriter, r *http.Request) {
	var req voicePortReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	if req.Port < 1 || req.Port > 65535 {
		writeError(w, http.StatusBadRequest, "voice port must be between 1 and 65535")
		return
	}
	if err := s.st.SetSetting(SettingVoicePort, strconv.Itoa(req.Port)); err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"voice_port": req.Port,
		"note":       "forward this UDP port; takes effect on restart",
	})
}

type uploadLimitReq struct {
	MB int `json:"mb"`
}

// handleHostUploadLimit sets the per-file upload cap (MB). Applies immediately —
// it's read on every upload, no restart needed.
func (s *Server) handleHostUploadLimit(w http.ResponseWriter, r *http.Request) {
	var req uploadLimitReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	if req.MB < 1 || req.MB > maxUploadCeilingMB {
		writeError(w, http.StatusBadRequest, "limit must be between 1 and 1024 MB")
		return
	}
	if err := s.st.SetSetting(SettingMaxUploadMB, strconv.Itoa(req.MB)); err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"max_upload_mb": req.MB})
}

type tlsReq struct {
	Enabled  bool   `json:"enabled"`
	CertPath string `json:"cert_path"`
	KeyPath  string `json:"key_path"`
}

// handleHostTLS stores the TLS config; it applies on the next restart. Enabling
// validates that the cert+key actually load, so a typo can't be saved as
// "enabled" — and even if one slips through, boot falls back to plain http
// rather than crashing (see cmd/keep/main.go), so the owner is never locked out.
func (s *Server) handleHostTLS(w http.ResponseWriter, r *http.Request) {
	var req tlsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	req.CertPath = strings.TrimSpace(req.CertPath)
	req.KeyPath = strings.TrimSpace(req.KeyPath)
	if req.Enabled {
		if req.CertPath == "" || req.KeyPath == "" {
			writeError(w, http.StatusBadRequest, "certificate and key file paths are both required to enable TLS")
			return
		}
		if _, err := tls.LoadX509KeyPair(req.CertPath, req.KeyPath); err != nil {
			writeError(w, http.StatusBadRequest, "couldn't load that certificate/key: "+err.Error())
			return
		}
	}
	enabled := ""
	if req.Enabled {
		enabled = "1"
	}
	for k, v := range map[string]string{
		SettingTLSCertPath: req.CertPath,
		SettingTLSKeyPath:  req.KeyPath,
		SettingTLSEnabled:  enabled,
	} {
		if err := s.st.SetSetting(k, v); err != nil {
			writeError(w, http.StatusInternalServerError, "storage error")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tls_enabled":   req.Enabled,
		"tls_cert_path": req.CertPath,
		"tls_key_path":  req.KeyPath,
		"note":          "takes effect on restart",
	})
}

type keepPasswordReq struct {
	Password string `json:"password"` // empty = remove the gate
}

func (s *Server) handleHostKeepPassword(w http.ResponseWriter, r *http.Request) {
	var req keepPasswordReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	if req.Password == "" {
		if err := s.st.SetSetting(SettingKeepPasswordHash, ""); err != nil {
			writeError(w, http.StatusInternalServerError, "storage error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"keep_password_set": false})
		return
	}
	if len(req.Password) < 4 {
		writeError(w, http.StatusBadRequest, "keep password must be at least 4 characters")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "hash error")
		return
	}
	if err := s.st.SetSetting(SettingKeepPasswordHash, string(hash)); err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"keep_password_set": true})
}

type roleReq struct {
	Role string `json:"role"`
}

func (s *Server) handleHostSetRole(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad user id")
		return
	}
	var req roleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	req.Role = strings.ToLower(strings.TrimSpace(req.Role))
	if req.Role != "member" && req.Role != "admin" && req.Role != "owner" {
		writeError(w, http.StatusBadRequest, `role must be "member", "admin", or "owner"`)
		return
	}
	user, err := s.st.SetRole(id, req.Role)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no such user")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	s.hub.Broadcast("MEMBER_UPDATE", map[string]any{"user": user})
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) handleHostDeleteUser(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad user id")
		return
	}
	if err := s.st.DeleteProfile(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "no such user")
			return
		}
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	s.hub.Broadcast("MEMBER_LEAVE", map[string]any{"user_id": id})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

type addrReq struct {
	Addr string `json:"addr"`
}

// handleHostAddr stores the listen address; it applies on next restart.
func (s *Server) handleHostAddr(w http.ResponseWriter, r *http.Request) {
	var req addrReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	req.Addr = strings.TrimSpace(req.Addr)
	if req.Addr != "" {
		port := strings.TrimPrefix(req.Addr, ":")
		if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
			writeError(w, http.StatusBadRequest, `addr must look like ":7777"`)
			return
		}
		req.Addr = ":" + strings.TrimPrefix(req.Addr, ":")
	}
	if err := s.st.SetSetting(SettingAddr, req.Addr); err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"addr": req.Addr, "note": "takes effect on restart"})
}

// handleHostRestart gracefully restarts the Keep so code/config updates take
// effect. Responds first, then triggers the supervised exit after a beat so
// the GUI receives the reply before the connection drops.
func (s *Server) handleHostRestart(w http.ResponseWriter, r *http.Request) {
	if s.restartFn == nil {
		writeError(w, http.StatusNotImplemented,
			"restart is unavailable — launch the Keep via start-keep.cmd to enable it")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"restarting": true})
	go func() {
		time.Sleep(400 * time.Millisecond)
		s.restartFn()
	}()
}

// handleHostUpdateRestart installs the latest version and restarts. Portable
// Keeps download + swap the release binary from GitHub (self-update); source
// builds pull the latest source then rebuild (the supervisor does `git pull` on
// exit code 43). The download can take a moment, so we reply first and run it in
// the background — the console polls /host/state for the outcome.
func (s *Server) handleHostUpdateRestart(w http.ResponseWriter, r *http.Request) {
	apply := s.applyUpdate()
	if apply == nil {
		writeError(w, http.StatusNotImplemented,
			"update is unavailable — launch the Keep via start-keep.cmd to enable it")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updating": true})
	go func() {
		time.Sleep(400 * time.Millisecond)
		apply()
	}()
}

// handleHostCheckUpdates searches for a newer version. Portable Keeps compare
// against the GitHub release manifest; source builds report how many commits the
// local checkout is behind its upstream. Any failure returns available:false.
func (s *Server) handleHostCheckUpdates(w http.ResponseWriter, r *http.Request) {
	if s.selfUpdate != nil {
		st := update.Check(update.Repo, ServerVersion)
		s.SetUpdateStatus(st.Latest, st.Behind, st.Err)
		writeJSON(w, http.StatusOK, map[string]any{
			"available": st.Behind,
			"latest":    st.Latest,
			"current":   st.Current,
			"error":     st.Err,
		})
		return
	}
	if out, err := exec.Command("git", "fetch", "--quiet").CombinedOutput(); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"available": false,
			"error":     strings.TrimSpace(string(out)),
		})
		return
	}
	out, err := exec.Command("git", "rev-list", "--count", "HEAD..@{u}").Output()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "error": "no upstream branch"})
		return
	}
	behind, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	writeJSON(w, http.StatusOK, map[string]any{"available": behind > 0, "behind": behind})
}

// handleHostRescueInvite mints an invite from the host GUI — the "add a
// user" path for when someone lost their client identity.
func (s *Server) handleHostRescueInvite(w http.ResponseWriter, r *http.Request) {
	members, err := s.st.Members()
	if err != nil || len(members) == 0 {
		writeError(w, http.StatusBadRequest, "this keep is unclaimed — the first identity joins without an invite")
		return
	}
	creatorID := members[0].ID
	for _, m := range members {
		if m.Role == "owner" {
			creatorID = m.ID
			break
		}
	}
	inv, err := s.st.CreateInvite(creatorID, time.Hour, 1) // tight by design: 1 hour, 1 use
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusCreated, inv)
}
