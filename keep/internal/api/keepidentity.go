package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"log"
)

// SettingKeepIdentitySeed stores the base64 32-byte Ed25519 seed of the Keep's
// identity keypair. The seed (not the expanded private key) is persisted so the
// same identity is rebuilt deterministically on every boot.
const SettingKeepIdentitySeed = "keep_identity_seed"

// ensureKeepIdentity loads the Keep's identity keypair from settings, generating
// and persisting a fresh one on first boot. Best-effort: if the store is
// unavailable the keypair stays nil and the signed-fingerprint path simply
// doesn't activate (the transport still works, just without MITM attestation).
func (s *Server) ensureKeepIdentity() {
	if seedB64, err := s.st.GetSetting(SettingKeepIdentitySeed); err == nil && seedB64 != "" {
		if seed, derr := base64.StdEncoding.DecodeString(seedB64); derr == nil && len(seed) == ed25519.SeedSize {
			s.keepPriv = ed25519.NewKeyFromSeed(seed)
			s.keepPub = s.keepPriv.Public().(ed25519.PublicKey)
			return
		}
		log.Printf("keep identity: stored seed is malformed — regenerating")
	}

	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		log.Printf("keep identity: could not generate keypair: %v", err)
		return
	}
	s.keepPriv = ed25519.NewKeyFromSeed(seed)
	s.keepPub = s.keepPriv.Public().(ed25519.PublicKey)
	if err := s.st.SetSetting(SettingKeepIdentitySeed, base64.StdEncoding.EncodeToString(seed)); err != nil {
		log.Printf("keep identity: generated keypair but failed to persist it: %v", err)
	}
}

// KeepPubB64 returns the Keep's identity public key as base64, or "" if no
// keypair is available. Published in discovery + embedded in invites.
func (s *Server) KeepPubB64() string {
	if s.keepPub == nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(s.keepPub)
}

// signFingerprint signs a DTLS fingerprint string with the Keep's identity key,
// returning the base64 signature. Empty if no keypair is available.
func (s *Server) signFingerprint(fingerprint string) string {
	if s.keepPriv == nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(ed25519.Sign(s.keepPriv, []byte(fingerprint)))
}
