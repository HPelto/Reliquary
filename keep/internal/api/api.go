// Package api is the Keep's REST surface (relic.v1).
package api

import (
	_ "embed"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"reliquary.gg/keep/internal/gateway"
	"reliquary.gg/keep/internal/store"
)

//go:embed admin.html
var adminHTML []byte

// cors lets the Electron client (file:// or localhost dev origin) and the
// admin GUI talk to any self-hosted Keep. Auth is token/key-based, so a
// permissive origin policy is fine.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Admin-Key")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

const ProtocolVersion = "relic.v1"
const ServerVersion = "0.1.0"

type Config struct {
	Name string
}

type Server struct {
	st         *store.Store
	hub        *gateway.Hub
	cfg        Config
	mux        *chi.Mux
	challenges *challenges
	restartFn  func() // set by main only when supervised; nil otherwise
	updateFn   func() // pull-latest-then-rebuild restart; supervised only
}

// SetRestart wires the graceful-restart trigger from main. When unset, the
// host GUI's restart button is hidden.
func (s *Server) SetRestart(fn func()) { s.restartFn = fn }

// SetUpdateRestart wires the "pull latest source, then rebuild & restart"
// trigger. When unset, the host GUI's Update & Restart button is hidden.
func (s *Server) SetUpdateRestart(fn func()) { s.updateFn = fn }

func New(st *store.Store, hub *gateway.Hub, cfg Config) *Server {
	s := &Server{st: st, hub: hub, cfg: cfg, challenges: newChallenges()}

	r := chi.NewRouter()
	r.Use(middleware.RealIP, middleware.Recoverer, cors)

	r.Group(func(r chi.Router) {
		r.Use(middleware.Timeout(30 * time.Second))
		r.Get("/.well-known/reliquary", s.handleDiscovery)
		// embedded admin GUI
		r.Get("/admin", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(adminHTML)
		})
	})

	r.Route("/v1", func(r chi.Router) {
		// the gateway is a long-lived hijacked connection — it must NOT sit
		// behind the request timeout, or it gets severed every 30 seconds
		r.Get("/gateway", s.hub.ServeHTTP)

		// media bytes are public + immutable (content-addressed) so <img> loads them
		r.Get("/media/{hash}", s.handleGetMedia)

		r.Group(func(r chi.Router) {
			r.Use(middleware.Timeout(30 * time.Second))

			r.Post("/auth/challenge", s.handleChallenge)
			r.Post("/auth/handshake", s.handleHandshake)
			r.Get("/invites/{token}", s.handleInvitePreview)

			r.Group(func(r chi.Router) {
				r.Use(s.requireAuth)
				r.Get("/world", s.handleWorld)
				r.Get("/channels/{id}/messages", s.handleListMessages)
				r.Post("/channels/{id}/messages", s.handleCreateMessage)
				r.Patch("/channels/{id}/messages/{mid}", s.handleEditMessage)
				r.Delete("/channels/{id}/messages/{mid}", s.handleDeleteMessage)
				r.Post("/invites", s.handleCreateInvite)
				r.Patch("/profile", s.handlePatchProfile)
				r.Get("/media/{hash}/exists", s.handleMediaExists)
				r.Put("/media/{hash}", s.handleUploadMedia)
				r.Get("/events", s.handleListEvents)
				r.Post("/events", s.handleCreateEvent)
				r.Delete("/events/{id}", s.handleDeleteEvent)
			})

			// community management — the client's owner/admin UI lives on these
			r.Route("/admin", func(r chi.Router) {
				r.Use(s.requireManage)
				r.Get("/state", s.handleAdminState)
				r.Patch("/settings", s.handleAdminSettings)
				r.Post("/channels", s.handleAdminCreateChannel)
				r.Patch("/channels/{id}", s.handleAdminRenameChannel)
				r.Delete("/channels/{id}", s.handleAdminDeleteChannel)
				r.Get("/invites", s.handleAdminListInvites)
				r.Post("/invites", s.handleAdminCreateInvite)
				r.Delete("/invites/{token}", s.handleAdminRevokeInvite)
				r.Get("/net-addresses", s.handleNetAddresses)
			})

			// server-side config — host key only, never a client token
			r.Route("/host", func(r chi.Router) {
				r.Use(s.requireHost)
				r.Get("/state", s.handleHostState)
				r.Post("/keep-password", s.handleHostKeepPassword)
				r.Patch("/users/{id}", s.handleHostSetRole)
				r.Delete("/users/{id}", s.handleHostDeleteUser)
				r.Post("/addr", s.handleHostAddr)
				r.Post("/tls", s.handleHostTLS)
				r.Post("/rescue-invite", s.handleHostRescueInvite)
				r.Post("/restart", s.handleHostRestart)
				r.Post("/update-restart", s.handleHostUpdateRestart)
				r.Get("/check-updates", s.handleHostCheckUpdates)
			})
		})
	})

	s.mux = r
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// ── helpers ─────────────────────────────────────────────────────────

type ctxKey int

const userKey ctxKey = 0

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		user, err := s.st.UserByToken(token)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		next.ServeHTTP(w, r.WithContext(withUser(r.Context(), user)))
	})
}

// ── discovery ───────────────────────────────────────────────────────

func (s *Server) handleDiscovery(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"instance": map[string]any{"name": s.instanceName()},
		"protocol": ProtocolVersion,
		"version":  ServerVersion,
		"api":      "/v1",
		"gateway":  "/v1/gateway",
	})
}

// ── world ───────────────────────────────────────────────────────────

func (s *Server) handleWorld(w http.ResponseWriter, r *http.Request) {
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
	presence := s.hub.PresenceSnapshot()

	type member struct {
		store.User
		Online bool   `json:"online"`
		State  string `json:"state"`
	}
	out := make([]member, 0, len(members))
	for _, m := range members {
		st := presence[m.ID]
		if st == "" {
			st = "offline"
		}
		out = append(out, member{User: m, Online: st != "offline", State: st})
	}

	events, err := s.st.Events()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"name":            s.instanceName(),
		"version":         ServerVersion,
		"protocol":        ProtocolVersion,
		"channels":        channels,
		"members":         out,
		"events":          events,
		"lock_name_style": s.nameStyleLocked(),
		"require_invite":  s.inviteRequired(),
	})
}

// ── messages ────────────────────────────────────────────────────────

func (s *Server) channelFromPath(w http.ResponseWriter, r *http.Request) (store.Channel, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad channel id")
		return store.Channel{}, false
	}
	ch, err := s.st.ChannelByID(id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no such channel")
		return store.Channel{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return store.Channel{}, false
	}
	return ch, true
}

func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	ch, ok := s.channelFromPath(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	msgs, err := s.st.Messages(ch.ID, limit, before)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	if msgs == nil {
		msgs = []store.Message{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
}

const maxAttachments = 10

type createMessageReq struct {
	Content     string             `json:"content"`
	Attachments []store.Attachment `json:"attachments"`
}

// validateAttachments caps the count and confirms each referenced blob was
// actually uploaded to this Keep's media store (clients upload bytes first, then
// reference them by hash). Returns a client-safe message on rejection.
func (s *Server) validateAttachments(in []store.Attachment) ([]store.Attachment, string) {
	if len(in) > maxAttachments {
		return nil, "too many attachments (max 10)"
	}
	out := make([]store.Attachment, 0, len(in))
	for _, a := range in {
		if a.Hash == "" {
			return nil, "attachment is missing its hash"
		}
		exists, err := s.st.MediaExists(a.Hash)
		if err != nil {
			return nil, "storage error"
		}
		if !exists {
			return nil, "attachment must be uploaded before it can be sent"
		}
		name := strings.TrimSpace(a.Name)
		if len(name) > 200 {
			name = name[:200]
		}
		out = append(out, store.Attachment{
			Hash: a.Hash, Name: name, ContentType: a.ContentType,
			Width: a.Width, Height: a.Height, Size: a.Size,
		})
	}
	return out, ""
}

func (s *Server) handleCreateMessage(w http.ResponseWriter, r *http.Request) {
	ch, ok := s.channelFromPath(w, r)
	if !ok {
		return
	}
	if ch.Kind != "text" {
		writeError(w, http.StatusBadRequest, "cannot post messages to a voice channel")
		return
	}
	var req createMessageReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	req.Content = strings.TrimSpace(req.Content)
	if len(req.Content) > 4000 {
		writeError(w, http.StatusBadRequest, "content must be at most 4000 characters")
		return
	}
	attachments, aerr := s.validateAttachments(req.Attachments)
	if aerr != "" {
		writeError(w, http.StatusBadRequest, aerr)
		return
	}
	// a message must carry something — text or at least one attachment
	if req.Content == "" && len(attachments) == 0 {
		writeError(w, http.StatusBadRequest, "a message needs text or an attachment")
		return
	}
	user := userFrom(r.Context())
	msg, err := s.st.CreateMessage(ch.ID, user.ID, req.Content, attachments)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	s.hub.Broadcast("MESSAGE_CREATE", msg)
	writeJSON(w, http.StatusCreated, msg)
}

func (s *Server) messageFromPath(w http.ResponseWriter, r *http.Request) (store.Message, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "mid"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad message id")
		return store.Message{}, false
	}
	msg, err := s.st.MessageByID(id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no such message")
		return store.Message{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return store.Message{}, false
	}
	return msg, true
}

type editMessageReq struct {
	Content string `json:"content"`
}

// handleEditMessage edits a message's text. Author-only — not even admins can
// rewrite someone else's words (they can delete, below).
func (s *Server) handleEditMessage(w http.ResponseWriter, r *http.Request) {
	msg, ok := s.messageFromPath(w, r)
	if !ok {
		return
	}
	user := userFrom(r.Context())
	if msg.Author.ID != user.ID {
		writeError(w, http.StatusForbidden, "only the author can edit a message")
		return
	}
	var req editMessageReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	req.Content = strings.TrimSpace(req.Content)
	if len(req.Content) > 4000 {
		writeError(w, http.StatusBadRequest, "content must be at most 4000 characters")
		return
	}
	if req.Content == "" && len(msg.Attachments) == 0 {
		writeError(w, http.StatusBadRequest, "a message needs text or an attachment")
		return
	}
	updated, err := s.st.UpdateMessage(msg.ID, user.ID, req.Content)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	s.hub.Broadcast("MESSAGE_UPDATE", updated)
	writeJSON(w, http.StatusOK, updated)
}

// handleDeleteMessage removes a message. The author can delete their own; owners
// and admins can delete anyone's (moderation).
func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	msg, ok := s.messageFromPath(w, r)
	if !ok {
		return
	}
	user := userFrom(r.Context())
	if msg.Author.ID != user.ID && !s.isManager(r) {
		writeError(w, http.StatusForbidden, "you can only delete your own messages")
		return
	}
	if err := s.st.DeleteMessage(msg.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	s.hub.Broadcast("MESSAGE_DELETE", map[string]any{"id": msg.ID, "channel_id": msg.ChannelID})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": msg.ID})
}

// ── invites ─────────────────────────────────────────────────────────

type createInviteReq struct {
	TTLSeconds int `json:"ttl_seconds"` // 0 = use default (7 days), -1 = never expires
	MaxUses    int `json:"max_uses"`    // 0 = unlimited
}

func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	if user.Role != "owner" && user.Role != "admin" {
		writeError(w, http.StatusForbidden, "only owners and admins can create invites")
		return
	}
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
		ttl = 0 // never expires
	}
	inv, err := s.st.CreateInvite(user.ID, ttl, req.MaxUses)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusCreated, inv)
}

// handleInvitePreview lets a client show the join card before registering.
func (s *Server) handleInvitePreview(w http.ResponseWriter, r *http.Request) {
	inv, err := s.st.InviteByToken(strings.ToUpper(chi.URLParam(r, "token")))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no such invite")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	count, _ := s.st.CountProfiles()
	writeJSON(w, http.StatusOK, map[string]any{
		"valid":   inv.Valid(),
		"name":    s.instanceName(),
		"members": count,
		"online":  len(s.hub.OnlineUserIDs()),
	})
}
