// Package atrest is the Keep's encryption-at-rest layer: AES-256-GCM over a
// single 32-byte data key, applied to message content + media so a stolen disk
// or leaked backup yields ciphertext. It does NOT protect against the owner (who
// runs the server and can read everything — intended) or against an attacker
// with live access to the running process (the key is in memory while serving).
//
// The data key itself is generated once and stored WRAPPED on disk; the wrapping
// mechanism is pluggable (KeyWrapper) so the protection can be DPAPI (Windows,
// no special hardware), a passphrase, or a TPM — without touching the crypto.
//
// Stored blobs are SELF-DESCRIBING (a version prefix / magic header), so plaintext
// and ciphertext coexist: turning encryption on/off and a partial migration are
// always safe, because every read decides per-value whether to decrypt.
package atrest

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const keyLen = 32 // AES-256

// textPrefix marks an encrypted TEXT field (e.g. a message body). The payload
// after it is base64(nonce||ciphertext). Plaintext is stored verbatim (no prefix).
const textPrefix = "enc:v1:"

// fileMagic marks an encrypted file (media). Followed by nonce||ciphertext. A
// file without it is legacy plaintext and served as-is.
var fileMagic = []byte("RLQ1")

// Cipher encrypts/decrypts with the unwrapped data key.
type Cipher struct{ aead cipher.AEAD }

func newCipher(key []byte) (*Cipher, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{aead: aead}, nil
}

// seal returns nonce||ciphertext for plain.
func (c *Cipher) seal(plain []byte) []byte {
	nonce := make([]byte, c.aead.NonceSize())
	_, _ = rand.Read(nonce)
	return c.aead.Seal(nonce, nonce, plain, nil)
}

// open reverses seal.
func (c *Cipher) open(blob []byte) ([]byte, error) {
	n := c.aead.NonceSize()
	if len(blob) < n {
		return nil, errors.New("atrest: ciphertext too short")
	}
	return c.aead.Open(nil, blob[:n], blob[n:], nil)
}

// EncryptText returns a self-describing encrypted form of s (prefix + base64).
func (c *Cipher) EncryptText(s string) string {
	return textPrefix + base64.StdEncoding.EncodeToString(c.seal([]byte(s)))
}

// DecryptText reverses EncryptText, passing through anything not marked encrypted
// (so plaintext rows written before encryption was enabled still read correctly).
func (c *Cipher) DecryptText(s string) string {
	if !strings.HasPrefix(s, textPrefix) {
		return s
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(s, textPrefix))
	if err != nil {
		return s
	}
	plain, err := c.open(raw)
	if err != nil {
		return s // can't decrypt (wrong key?) — return as-is rather than crashing
	}
	return string(plain)
}

// IsEncryptedText reports whether s is in the encrypted text form.
func IsEncryptedText(s string) bool { return strings.HasPrefix(s, textPrefix) }

// EncryptFile returns magic||nonce||ciphertext for media bytes.
func (c *Cipher) EncryptFile(plain []byte) []byte {
	return append(append([]byte{}, fileMagic...), c.seal(plain)...)
}

// DecryptFile reverses EncryptFile; bytes without the magic are legacy plaintext.
func (c *Cipher) DecryptFile(blob []byte) ([]byte, error) {
	if !IsEncryptedFile(blob) {
		return blob, nil
	}
	return c.open(blob[len(fileMagic):])
}

// IsEncryptedFile reports whether blob carries the encrypted-file magic.
func IsEncryptedFile(blob []byte) bool {
	return len(blob) >= len(fileMagic) && string(blob[:len(fileMagic)]) == string(fileMagic)
}

// ── key management ───────────────────────────────────────────────────────────

// KeyWrapper protects the data key at rest. Implementations: passphrase
// (cross-platform), DPAPI (Windows, no hardware), TPM (where present). Wrap +
// Unwrap must round-trip; Name labels the active method for the host console.
type KeyWrapper interface {
	Wrap(key []byte) ([]byte, error)
	Unwrap(wrapped []byte) ([]byte, error)
	Name() string
}

// Open loads the wrapped data key from keyPath (creating + persisting a fresh one
// on first use), unwraps it with w, and returns a ready Cipher.
func Open(keyPath string, w KeyWrapper) (*Cipher, error) {
	key, err := loadOrCreateKey(keyPath, w)
	if err != nil {
		return nil, err
	}
	return newCipher(key)
}

func loadOrCreateKey(keyPath string, w KeyWrapper) ([]byte, error) {
	if wrapped, err := os.ReadFile(keyPath); err == nil {
		key, uerr := w.Unwrap(wrapped)
		if uerr != nil {
			return nil, fmt.Errorf("atrest: unwrap data key (%s): %w", w.Name(), uerr)
		}
		if len(key) != keyLen {
			return nil, errors.New("atrest: stored data key has wrong length")
		}
		return key, nil
	}
	// first use: generate, wrap, persist
	key := make([]byte, keyLen)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	wrapped, err := w.Wrap(key)
	if err != nil {
		return nil, fmt.Errorf("atrest: wrap data key (%s): %w", w.Name(), err)
	}
	if err := os.MkdirAll(filepath.Dir(keyPath), 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, wrapped, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}
