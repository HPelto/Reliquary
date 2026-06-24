package atrest

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"

	"golang.org/x/crypto/argon2"
)

// PassphraseWrapper protects the data key with a passphrase the operator enters
// at boot (the strongest option: nothing on disk decrypts without it, so a
// stolen disk is fully useless — at the cost of needing the passphrase on every
// start). Format: salt(16) || nonce(12) || ciphertext. The key-encryption key is
// derived with Argon2id.
type PassphraseWrapper struct{ Passphrase string }

const (
	saltLen     = 16
	argonTime   = 3
	argonMemory = 64 * 1024 // 64 MiB
	argonLanes  = 4
)

func (p PassphraseWrapper) Name() string { return "passphrase" }

func (p PassphraseWrapper) Wrap(key []byte) ([]byte, error) {
	if p.Passphrase == "" {
		return nil, errors.New("atrest: empty passphrase")
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	aead, err := p.aead(salt)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := append([]byte{}, salt...)
	out = append(out, nonce...)
	return aead.Seal(out, nonce, key, nil), nil
}

func (p PassphraseWrapper) Unwrap(wrapped []byte) ([]byte, error) {
	if len(wrapped) < saltLen {
		return nil, errors.New("atrest: wrapped key too short")
	}
	salt := wrapped[:saltLen]
	rest := wrapped[saltLen:]
	aead, err := p.aead(salt)
	if err != nil {
		return nil, err
	}
	n := aead.NonceSize()
	if len(rest) < n {
		return nil, errors.New("atrest: wrapped key too short")
	}
	return aead.Open(nil, rest[:n], rest[n:], nil)
}

func (p PassphraseWrapper) aead(salt []byte) (cipher.AEAD, error) {
	kek := argon2.IDKey([]byte(p.Passphrase), salt, argonTime, argonMemory, argonLanes, keyLen)
	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// RawWrapper stores the data key UNPROTECTED. Only for tests / explicit dev use —
// it offers no protection against disk theft (the key sits beside the data).
type RawWrapper struct{}

func (RawWrapper) Name() string                    { return "none" }
func (RawWrapper) Wrap(key []byte) ([]byte, error) { return append([]byte{}, key...), nil }
func (RawWrapper) Unwrap(b []byte) ([]byte, error) { return append([]byte{}, b...), nil }
