package api

// Host-only endpoints: server-side configuration that must never be
// reachable with a (possibly stolen) client token — keep password, role
// assignment, user removal, listen address. See admin.go for the tiers.

import (
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

	writeJSON(w, http.StatusOK, map[string]any{
		"name":              s.instanceName(),
		"version":           ServerVersion,
		"protocol":          ProtocolVersion,
		"users":             mout,
		"keep_password_set": pwHash != "",
		"addr":              addr,
		"channel_count":     len(channels),
		"invite_count":      len(invites),
		"online_count":      len(online),
		"restart_available": s.restartFn != nil,
		"update_available":  s.updateFn != nil,
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

// handleHostUpdateRestart pulls the latest source, then rebuilds & restarts —
// the supervisor (start-keep.cmd) does the `git pull` on exit code 43.
func (s *Server) handleHostUpdateRestart(w http.ResponseWriter, r *http.Request) {
	if s.updateFn == nil {
		writeError(w, http.StatusNotImplemented,
			"update is unavailable — launch the Keep via start-keep.cmd to enable it")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updating": true})
	go func() {
		time.Sleep(400 * time.Millisecond)
		s.updateFn()
	}()
}

// handleHostCheckUpdates reports how many commits the local source is behind the
// upstream branch — a best-effort "search for new versions". Requires git + a
// remote; any failure (no git, no remote, detached) returns available:false.
func (s *Server) handleHostCheckUpdates(w http.ResponseWriter, r *http.Request) {
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
