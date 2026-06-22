package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"reliquary.gg/keep/internal/store"
)

// Two tiers of authority:
//
//   - MANAGE (community management: name, channels, invites) — a Bearer
//     session whose profile is owner or admin, i.e. done from the client.
//     The host key also passes, since the host outranks everyone.
//   - HOST (server-side config: keep password, roles, user removal) — the
//     X-Admin-Key printed at first boot, ONLY. A stolen owner token must
//     not be able to reach these.
//
// The host key is stored hashed, like any credential.

const SettingAdminKeyHash = "admin_key_hash"
const SettingName = "name"
const SettingAddr = "addr"
const SettingLockNameStyle = "lock_name_style"
const SettingRequireInvite = "require_invite"
const SettingTLSEnabled = "tls_enabled"
const SettingTLSCertPath = "tls_cert_path"
const SettingTLSKeyPath = "tls_key_path"
const SettingMaxUploadMB = "max_upload_mb"

func HashAdminKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

func (s *Server) isHost(r *http.Request) bool {
	key := r.Header.Get("X-Admin-Key")
	if key == "" {
		return false
	}
	stored, err := s.st.GetSetting(SettingAdminKeyHash)
	return err == nil && stored != "" &&
		subtle.ConstantTimeCompare([]byte(HashAdminKey(key)), []byte(stored)) == 1
}

func (s *Server) isManager(r *http.Request) bool {
	if s.isHost(r) {
		return true
	}
	if token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "); token != "" {
		if user, err := s.st.UserByToken(token); err == nil &&
			(user.Role == "owner" || user.Role == "admin") {
			return true
		}
	}
	return false
}

func (s *Server) requireManage(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.isManager(r) {
			writeError(w, http.StatusForbidden, "owner/admin token or host key required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.isHost(r) {
			writeError(w, http.StatusForbidden, "host key required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// instanceName reads the configured name, falling back to the boot flag.
func (s *Server) instanceName() string {
	if name, err := s.st.GetSetting(SettingName); err == nil && name != "" {
		return name
	}
	return s.cfg.Name
}

// ── handlers ────────────────────────────────────────────────────────

// handleAdminState returns everything the admin GUI renders in one call.
func (s *Server) handleAdminState(w http.ResponseWriter, r *http.Request) {
	channels, err := s.st.Channels()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	members, err := s.st.Members()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	invites, err := s.st.Invites()
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
	if invites == nil {
		invites = []store.Invite{}
	}
	if channels == nil {
		channels = []store.Channel{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"name":            s.instanceName(),
		"version":         ServerVersion,
		"protocol":        ProtocolVersion,
		"channels":        channels,
		"members":         mout,
		"invites":         invites,
		"lock_name_style": s.nameStyleLocked(),
		"require_invite":  s.inviteRequired(),
	})
}

// settingsReq supports partial updates — pointer fields are only applied when
// present, so the client can patch just the name or just the lock toggle.
type settingsReq struct {
	Name          *string `json:"name"`
	LockNameStyle *bool   `json:"lock_name_style"`
	RequireInvite *bool   `json:"require_invite"`
}

func (s *Server) handleAdminSettings(w http.ResponseWriter, r *http.Request) {
	var req settingsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}

	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if len(name) < 2 || len(name) > 48 {
			writeError(w, http.StatusBadRequest, "name must be 2-48 characters")
			return
		}
		if err := s.st.SetSetting(SettingName, name); err != nil {
			writeError(w, http.StatusInternalServerError, "storage error")
			return
		}
	}
	if req.LockNameStyle != nil {
		v := "0"
		if *req.LockNameStyle {
			v = "1"
		}
		if err := s.st.SetSetting(SettingLockNameStyle, v); err != nil {
			writeError(w, http.StatusInternalServerError, "storage error")
			return
		}
	}
	if req.RequireInvite != nil {
		v := "0"
		if *req.RequireInvite {
			v = "1"
		}
		if err := s.st.SetSetting(SettingRequireInvite, v); err != nil {
			writeError(w, http.StatusInternalServerError, "storage error")
			return
		}
	}

	s.hub.Broadcast("SERVER_UPDATE", map[string]any{
		"name":            s.instanceName(),
		"lock_name_style": s.nameStyleLocked(),
		"require_invite":  s.inviteRequired(),
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"name":            s.instanceName(),
		"lock_name_style": s.nameStyleLocked(),
		"require_invite":  s.inviteRequired(),
	})
}

// nameStyleLocked reports whether this Keep enforces role colors / disables
// username styling.
func (s *Server) nameStyleLocked() bool {
	v, _ := s.st.GetSetting(SettingLockNameStyle)
	return v == "1"
}

// inviteRequired reports whether new identities must present a valid invite.
// Unset defaults to true — the privacy-first behavior the Keep shipped with.
func (s *Server) inviteRequired() bool {
	v, _ := s.st.GetSetting(SettingRequireInvite)
	return v != "0"
}

type channelReq struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

var channelNameRe = strings.NewReplacer(" ", "-", "#", "")

func cleanChannelName(name string) string {
	return strings.ToLower(strings.TrimSpace(channelNameRe.Replace(name)))
}

func (s *Server) handleAdminCreateChannel(w http.ResponseWriter, r *http.Request) {
	var req channelReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	req.Name = cleanChannelName(req.Name)
	if len(req.Name) < 1 || len(req.Name) > 48 {
		writeError(w, http.StatusBadRequest, "channel name must be 1-48 characters")
		return
	}
	if req.Kind != "text" && req.Kind != "voice" {
		writeError(w, http.StatusBadRequest, `kind must be "text" or "voice"`)
		return
	}
	ch, err := s.st.CreateChannel(req.Name, req.Kind)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	s.hub.Broadcast("CHANNEL_CREATE", ch)
	writeJSON(w, http.StatusCreated, ch)
}

func (s *Server) handleAdminRenameChannel(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad channel id")
		return
	}
	var req channelReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	req.Name = cleanChannelName(req.Name)
	if len(req.Name) < 1 || len(req.Name) > 48 {
		writeError(w, http.StatusBadRequest, "channel name must be 1-48 characters")
		return
	}
	if err := s.st.RenameChannel(id, req.Name); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "no such channel")
			return
		}
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	ch, _ := s.st.ChannelByID(id)
	s.hub.Broadcast("CHANNEL_UPDATE", ch)
	writeJSON(w, http.StatusOK, ch)
}

func (s *Server) handleAdminDeleteChannel(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad channel id")
		return
	}
	channels, err := s.st.Channels()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	if len(channels) <= 1 {
		writeError(w, http.StatusBadRequest, "a keep needs at least one channel")
		return
	}
	if err := s.st.DeleteChannel(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "no such channel")
			return
		}
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	s.hub.Broadcast("CHANNEL_DELETE", map[string]any{"id": id})
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

func (s *Server) handleAdminListInvites(w http.ResponseWriter, r *http.Request) {
	invites, err := s.st.Invites()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	if invites == nil {
		invites = []store.Invite{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": invites})
}

// handleAdminCreateInvite mirrors the owner invite endpoint for admin-key callers.
func (s *Server) handleAdminCreateInvite(w http.ResponseWriter, r *http.Request) {
	var req createInviteReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	ttl := 7 * 24 * time.Hour
	switch {
	case req.TTLSeconds > 0:
		ttl = time.Duration(req.TTLSeconds) * time.Second
	case req.TTLSeconds < 0:
		ttl = 0
	}
	// attribute admin-key invites to the owner profile
	members, err := s.st.Members()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	if len(members) == 0 {
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
	inv, err := s.st.CreateInvite(creatorID, ttl, req.MaxUses)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusCreated, inv)
}

func (s *Server) handleAdminRevokeInvite(w http.ResponseWriter, r *http.Request) {
	token := strings.ToUpper(chi.URLParam(r, "token"))
	if err := s.st.DeleteInvite(token); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "no such invite")
			return
		}
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"revoked": token})
}
