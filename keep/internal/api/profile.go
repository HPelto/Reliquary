package api

// Profile editing and media (avatars, backgrounds). Media is content-
// addressed: the client computes the SHA-256, uploads the bytes once, and
// every Keep serves them by hash. Profile media is global to an identity —
// the client pushes the same hashes to every Keep it joins.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"reliquary.gg/keep/internal/store"
)

const maxMediaBytes = 8 << 20 // 8 MiB

var allowedMediaTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
}

// handlePatchProfile lets a signed-in client update its own profile live,
// without reconnecting. The body mirrors the handshake profile object.
func (s *Server) handlePatchProfile(w http.ResponseWriter, r *http.Request) {
	me := userFrom(r.Context())
	var req handshakeProfile
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	profile, verr := req.toStoreProfile()
	if verr != "" {
		writeError(w, http.StatusBadRequest, verr)
		return
	}
	user, err := s.st.UpdateProfile(me.ID, profile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	s.hub.Broadcast("MEMBER_UPDATE", map[string]any{"user": user})
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

// handleMediaExists is the cheap pre-upload check — the client only sends
// big GIF bytes to Keeps that don't already have them.
func (s *Server) handleMediaExists(w http.ResponseWriter, r *http.Request) {
	exists, err := s.st.MediaExists(chi.URLParam(r, "hash"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"exists": exists})
}

// handleUploadMedia stores content-addressed bytes. The client declares the
// hash in the path; the server recomputes it and rejects a mismatch, so a
// hash always names exactly the bytes it returns.
func (s *Server) handleUploadMedia(w http.ResponseWriter, r *http.Request) {
	claimed := chi.URLParam(r, "hash")
	contentType := r.Header.Get("Content-Type")
	if !allowedMediaTypes[contentType] {
		writeError(w, http.StatusUnsupportedMediaType, "media must be png, jpeg, gif, or webp")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxMediaBytes))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "media exceeds 8 MB")
		return
	}
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, claimed) {
		writeError(w, http.StatusBadRequest, "content hash does not match the declared hash")
		return
	}
	if err := s.st.PutMedia(got, contentType, data); err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"hash": got})
}

// handleGetMedia serves media bytes. Public and immutable (content-
// addressed) so <img src> loads it without auth and caches forever.
func (s *Server) handleGetMedia(w http.ResponseWriter, r *http.Request) {
	contentType, data, err := s.st.GetMedia(chi.URLParam(r, "hash"))
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "no such media", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = w.Write(data)
}
