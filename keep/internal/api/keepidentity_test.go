package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"path/filepath"
	"testing"

	"reliquary.gg/keep/internal/gateway"
	"reliquary.gg/keep/internal/store"
)

// TestKeepIdentitySignAndPersist verifies the Keep generates an identity, signs
// a DTLS fingerprint such that the signature checks out against the published
// pubkey, rejects a tampered fingerprint, and reloads the SAME identity from the
// store on the next boot.
func TestKeepIdentitySignAndPersist(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "k.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	s := New(st, gateway.NewHub(st), Config{Name: "K"})

	pubB64 := s.KeepPubB64()
	if pubB64 == "" {
		t.Fatal("no keep pubkey generated on first boot")
	}
	pub, err := base64.StdEncoding.DecodeString(pubB64)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		t.Fatalf("published pubkey is not a valid Ed25519 key: %v", err)
	}

	fp := "sha-256 AA:BB:CC:DD:EE:FF"
	sigB64 := s.signFingerprint(fp)
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		t.Fatalf("signature is not a valid Ed25519 signature: %v", err)
	}
	if !ed25519.Verify(pub, []byte(fp), sig) {
		t.Fatal("signature did not verify against the published pubkey")
	}
	// a MITM presenting a different DTLS cert (fingerprint) can't reuse the sig
	if ed25519.Verify(pub, []byte("sha-256 00:00:00:00"), sig) {
		t.Fatal("signature verified a tampered fingerprint — attestation is broken")
	}
	st.Close()

	// reboot from the same store → identity persists unchanged
	st2, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer st2.Close()
	s2 := New(st2, gateway.NewHub(st2), Config{Name: "K"})
	if s2.KeepPubB64() != pubB64 {
		t.Fatalf("identity not persisted across reboot: %q != %q", s2.KeepPubB64(), pubB64)
	}
}

func TestDTLSFingerprintExtract(t *testing.T) {
	sdp := "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\na=fingerprint:sha-256 AB:CD:EF\r\na=setup:active\r\n"
	if got := dtlsFingerprint(sdp); got != "sha-256 AB:CD:EF" {
		t.Fatalf("dtlsFingerprint = %q, want %q", got, "sha-256 AB:CD:EF")
	}
	if got := dtlsFingerprint("v=0\r\nno fingerprint here\r\n"); got != "" {
		t.Fatalf("expected empty for an SDP without a fingerprint, got %q", got)
	}
}
