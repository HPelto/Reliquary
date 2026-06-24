package store

import (
	"path/filepath"
	"testing"
)

// TestRevokeSessions verifies a revoked session's token stops resolving
// immediately, while leaving the account intact.
func TestRevokeSessions(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	u, err := st.CreateProfile("pk-a", make([]byte, 32), "owner", Profile{Username: "A"})
	if err != nil {
		t.Fatalf("create profile: %v", err)
	}

	tok, err := st.CreateSession(u.ID)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := st.UserByToken(tok); err != nil {
		t.Fatalf("token should resolve before revoke: %v", err)
	}

	n, err := st.RevokeSessions(u.ID)
	if err != nil || n != 1 {
		t.Fatalf("RevokeSessions: n=%d err=%v, want 1, nil", n, err)
	}
	if _, err := st.UserByToken(tok); err == nil {
		t.Fatal("token still resolves after revoke — revocation is not immediate")
	}
	// account survives: a fresh handshake can mint a new session
	if _, err := st.CreateSession(u.ID); err != nil {
		t.Fatalf("re-handshake after revoke should work: %v", err)
	}
}
