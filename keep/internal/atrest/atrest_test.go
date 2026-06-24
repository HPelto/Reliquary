package atrest

import (
	"bytes"
	"path/filepath"
	"testing"
)

func TestTextRoundTripAndPassthrough(t *testing.T) {
	c, err := Open(filepath.Join(t.TempDir(), "k"), RawWrapper{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	enc := c.EncryptText("hello, world")
	if !IsEncryptedText(enc) {
		t.Fatal("encrypted text not marked as such")
	}
	if enc == "hello, world" {
		t.Fatal("text was not actually encrypted")
	}
	if got := c.DecryptText(enc); got != "hello, world" {
		t.Fatalf("round trip = %q", got)
	}
	// self-describing: plaintext (no prefix) passes through unchanged
	if got := c.DecryptText("legacy plaintext"); got != "legacy plaintext" {
		t.Fatalf("plaintext passthrough = %q", got)
	}
}

func TestFileRoundTripAndPassthrough(t *testing.T) {
	c, err := Open(filepath.Join(t.TempDir(), "k"), RawWrapper{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	plain := bytes.Repeat([]byte{0x89, 'P', 'N', 'G'}, 5000)

	enc := c.EncryptFile(plain)
	if !IsEncryptedFile(enc) {
		t.Fatal("encrypted file not marked")
	}
	if bytes.Equal(enc, plain) {
		t.Fatal("file was not encrypted")
	}
	got, err := c.DecryptFile(enc)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("file round trip: err=%v equal=%v", err, bytes.Equal(got, plain))
	}
	// legacy plaintext file (no magic) passes through
	if got, _ := c.DecryptFile(plain); !bytes.Equal(got, plain) {
		t.Fatal("plaintext file passthrough failed")
	}
}

func TestPassphraseWrapPersistsAndRejectsWrong(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "k")

	// first open creates + wraps the data key under the passphrase
	c1, err := Open(keyPath, PassphraseWrapper{Passphrase: "correct horse"})
	if err != nil {
		t.Fatalf("open1: %v", err)
	}
	blob := c1.EncryptText("secret")

	// reopening with the SAME passphrase yields the SAME key (can decrypt)
	c2, err := Open(keyPath, PassphraseWrapper{Passphrase: "correct horse"})
	if err != nil {
		t.Fatalf("open2: %v", err)
	}
	if got := c2.DecryptText(blob); got != "secret" {
		t.Fatalf("reopen decrypt = %q", got)
	}

	// a WRONG passphrase must fail to unwrap (GCM auth) — not silently succeed
	if _, err := Open(keyPath, PassphraseWrapper{Passphrase: "wrong"}); err == nil {
		t.Fatal("wrong passphrase unwrapped the key")
	}
}
