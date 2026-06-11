package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"reliquary.gg/keep/internal/store"
)

// SettingKeepPasswordHash gates entry to the whole Keep — an extra layer the
// host can enable. Every handshake must present it, invite or not.
const SettingKeepPasswordHash = "keep_password_hash"

// The identity handshake. Accounts are client-owned Ed25519 keypairs created
// locally in the client — no email, no password, nothing central. Joining a
// Keep transfers a signed profile, and the Keep generates its own local
// record for that identity:
//
//	1. POST /v1/auth/challenge {pubkey}            → {nonce}
//	2. client signs the nonce with its private key
//	3. POST /v1/auth/handshake {pubkey, nonce, signature, profile, invite?}
//	   → Keep verifies the signature, creates/updates the profile row keyed
//	     by pubkey, and issues a session token.
//
// New identities need an invite (except the first, which claims the Keep).
// Returning identities never need one — the key IS the account.

const challengeTTL = 2 * time.Minute

type challenges struct {
	mu sync.Mutex
	m  map[string]challengeEntry // nonce → entry
}

type challengeEntry struct {
	pubkey  string
	expires time.Time
}

func newChallenges() *challenges {
	return &challenges{m: make(map[string]challengeEntry)}
}

func (c *challenges) issue(pubkey string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	nonce := base64.StdEncoding.EncodeToString(raw)
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, e := range c.m { // lazy sweep
		if now.After(e.expires) {
			delete(c.m, k)
		}
	}
	c.m[nonce] = challengeEntry{pubkey: pubkey, expires: now.Add(challengeTTL)}
	return nonce, nil
}

// consume validates and burns a nonce — single use, bound to the pubkey.
func (c *challenges) consume(nonce, pubkey string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[nonce]
	if !ok || time.Now().After(e.expires) || e.pubkey != pubkey {
		return false
	}
	delete(c.m, nonce)
	return true
}

func decodePubkey(b64 string) (ed25519.PublicKey, bool) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, false
	}
	return ed25519.PublicKey(raw), true
}

// ── handlers ────────────────────────────────────────────────────────

type challengeReq struct {
	Pubkey string `json:"pubkey"`
}

func (s *Server) handleChallenge(w http.ResponseWriter, r *http.Request) {
	var req challengeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	if _, ok := decodePubkey(req.Pubkey); !ok {
		writeError(w, http.StatusBadRequest, "pubkey must be a base64 Ed25519 public key")
		return
	}
	nonce, err := s.challenges.issue(req.Pubkey)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "entropy error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"nonce": nonce})
}

type handshakeProfile struct {
	Username   string `json:"username"`
	Accent     string `json:"accent"`
	About      string `json:"about"`
	Status     string `json:"status"`
	Avatar     string `json:"avatar"`
	Background string `json:"background"`
	NameFont   string `json:"name_font"`
	NameEffect string `json:"name_effect"`
	NameColor  string `json:"name_color"`
}

// toStoreProfile validates and clamps the client-supplied profile fields.
func (p handshakeProfile) toStoreProfile() (store.Profile, string) {
	username := strings.TrimSpace(p.Username)
	if len(username) < 2 || len(username) > 32 {
		return store.Profile{}, "profile.username must be 2-32 characters"
	}
	accent := p.Accent
	if accent == "" {
		accent = "#aab1c0"
	}
	if !accentRe.MatchString(accent) {
		return store.Profile{}, "profile.accent must be a #rrggbb color"
	}
	if len(p.About) > 600 {
		return store.Profile{}, "profile.about must be 600 characters or fewer"
	}
	if len(p.Status) > 80 {
		return store.Profile{}, "profile.status must be 80 characters or fewer"
	}
	if len(p.Avatar) > 80 || len(p.Background) > 80 {
		return store.Profile{}, "media reference too long"
	}
	if len(p.NameFont) > 24 || len(p.NameEffect) > 24 {
		return store.Profile{}, "name style key too long"
	}
	if p.NameColor != "" && !accentRe.MatchString(p.NameColor) {
		return store.Profile{}, "profile.name_color must be empty or a #rrggbb color"
	}
	return store.Profile{
		Username:   username,
		Accent:     accent,
		About:      strings.TrimSpace(p.About),
		Status:     strings.TrimSpace(p.Status),
		Avatar:     p.Avatar,
		Background: p.Background,
		NameFont:   p.NameFont,
		NameEffect: p.NameEffect,
		NameColor:  p.NameColor,
	}, ""
}

type handshakeReq struct {
	Pubkey       string           `json:"pubkey"`
	Nonce        string           `json:"nonce"`
	Signature    string           `json:"signature"`
	Profile      handshakeProfile `json:"profile"`
	Invite       string           `json:"invite"`
	KeepPassword string           `json:"keep_password"`
}

var accentRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (s *Server) handleHandshake(w http.ResponseWriter, r *http.Request) {
	var req handshakeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}

	pub, ok := decodePubkey(req.Pubkey)
	if !ok {
		writeError(w, http.StatusBadRequest, "pubkey must be a base64 Ed25519 public key")
		return
	}
	sig, err := base64.StdEncoding.DecodeString(req.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		writeError(w, http.StatusBadRequest, "bad signature encoding")
		return
	}

	// the nonce must be one we issued, unexpired, bound to this key, unused
	if !s.challenges.consume(req.Nonce, req.Pubkey) {
		writeError(w, http.StatusUnauthorized, "unknown or expired challenge — request a new one")
		return
	}
	// proof of key ownership: the signature is over the raw nonce string
	if !ed25519.Verify(pub, []byte(req.Nonce), sig) {
		writeError(w, http.StatusUnauthorized, "signature does not verify")
		return
	}

	// keep password gate — applies to everyone, invite or not
	if hash, err := s.st.GetSetting(SettingKeepPasswordHash); err == nil && hash != "" {
		if req.KeepPassword == "" {
			writeJSON(w, http.StatusForbidden, map[string]string{
				"error": "this keep requires a keep password",
				"code":  "keep_password_required",
			})
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.KeepPassword)) != nil {
			writeJSON(w, http.StatusForbidden, map[string]string{
				"error": "wrong keep password",
				"code":  "keep_password_required",
			})
			return
		}
	}

	profile, verr := req.Profile.toStoreProfile()
	if verr != "" {
		writeError(w, http.StatusBadRequest, verr)
		return
	}

	user, err := s.st.ProfileByPubkey(req.Pubkey)
	switch {
	case err == nil:
		// returning identity — refresh the client-supplied fields
		updated, uErr := s.st.UpdateProfile(user.ID, profile)
		if uErr != nil {
			writeError(w, http.StatusInternalServerError, "storage error")
			return
		}
		if updated != user {
			user = updated
			s.hub.Broadcast("MEMBER_UPDATE", map[string]any{"user": user})
		}

	case errors.Is(err, store.ErrNotFound):
		// new identity — the Keep generates a profile for it
		count, cErr := s.st.CountProfiles()
		if cErr != nil {
			writeError(w, http.StatusInternalServerError, "storage error")
			return
		}
		role := "member"
		if count == 0 {
			role = "owner" // first identity claims the Keep
		} else {
			invite := strings.ToUpper(strings.TrimSpace(req.Invite))
			if invite == "" {
				// open Keep (toggle off): the keep password above is the only gate
				if s.inviteRequired() {
					writeError(w, http.StatusForbidden, "an invite is required to join this keep")
					return
				}
			} else if rErr := s.st.RedeemInvite(invite); rErr != nil {
				// only consume an invite when one was actually supplied
				if errors.Is(rErr, store.ErrBadInvite) {
					writeError(w, http.StatusForbidden, "invite is invalid, expired, or used up")
					return
				}
				writeError(w, http.StatusInternalServerError, "storage error")
				return
			}
		}
		user, err = s.st.CreateProfile(req.Pubkey, pub, role, profile)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "storage error")
			return
		}
		s.hub.Broadcast("MEMBER_JOIN", map[string]any{"user": user})

	default:
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}

	token, err := s.st.CreateSession(user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": user})
}
