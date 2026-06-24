package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"reliquary.gg/keep/internal/atrest"
)

// TestAtRestEncryption verifies that with a cipher set, message content + media
// are ciphertext on disk but read back as plaintext through the store API, while
// structural metadata stays queryable.
func TestAtRestEncryption(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "k.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	cipher, err := atrest.Open(filepath.Join(dir, "atrest.key"), atrest.RawWrapper{})
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	st.SetCipher(cipher)

	owner, err := st.CreateProfile("pk", make([]byte, 32), "owner", Profile{Username: "A"})
	if err != nil {
		t.Fatalf("profile: %v", err)
	}
	ch, err := st.CreateChannel("general", "text")
	if err != nil {
		t.Fatalf("channel: %v", err)
	}

	const secret = "the eagle lands at midnight"
	msg, err := st.CreateMessage(ch.ID, owner.ID, secret, nil, 0)
	if err != nil {
		t.Fatalf("create message: %v", err)
	}

	// read back through the store → decrypted plaintext
	got, err := st.MessageByID(msg.ID)
	if err != nil || got.Content != secret {
		t.Fatalf("read back: content=%q err=%v", got.Content, err)
	}

	// on disk (raw column) → ciphertext, not the plaintext
	var raw string
	if err := st.db.QueryRow(`SELECT content FROM messages WHERE id = ?`, msg.ID).Scan(&raw); err != nil {
		t.Fatalf("raw read: %v", err)
	}
	if raw == secret || !atrest.IsEncryptedText(raw) {
		t.Fatalf("content not encrypted at rest: %q", raw)
	}

	// metadata stays plaintext + queryable (channel filter works)
	msgs, err := st.Messages(ch.ID, 50, 0)
	if err != nil || len(msgs) != 1 {
		t.Fatalf("Messages by channel: n=%d err=%v", len(msgs), err)
	}

	// media: bytes on disk are ciphertext, served back as plaintext
	const mediaHash = "abc123"
	plain := []byte("PNGDATA-pretend-image-bytes")
	if err := st.PutMedia(mediaHash, "image/png", plain); err != nil {
		t.Fatalf("put media: %v", err)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "media", mediaHash))
	if err != nil {
		t.Fatalf("read media file: %v", err)
	}
	if !atrest.IsEncryptedFile(onDisk) || strings.Contains(string(onDisk), "PNGDATA") {
		t.Fatal("media not encrypted at rest")
	}
	reader, _, closeFn, err := st.OpenMediaContent(mediaHash)
	if err != nil {
		t.Fatalf("open media: %v", err)
	}
	defer closeFn()
	buf := make([]byte, len(plain))
	if _, err := reader.Read(buf); err != nil || string(buf) != string(plain) {
		t.Fatalf("served media not decrypted: %q err=%v", buf, err)
	}
}
