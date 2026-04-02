package config

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/pbkdf2"
)

const (
	fileMagicV1 = "SHBOXCFG1"
	saltLen     = 16
	nonceLen    = 12
	pbkdf2Iters = 120_000
	keyLen      = 32
)

func deriveKey(machineSecret string, salt []byte) []byte {
	return pbkdf2.Key([]byte(machineSecret), salt, pbkdf2Iters, keyLen, sha256.New)
}

func encrypt(machineSecret string, plaintext []byte) ([]byte, error) {
	salt := make([]byte, saltLen)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, fmt.Errorf("salt: %w", err)
	}

	key := deriveKey(machineSecret, salt)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm: %w", err)
	}

	nonce := make([]byte, nonceLen)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("nonce: %w", err)
	}

	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)
	out := make([]byte, 0, len(fileMagicV1)+saltLen+nonceLen+len(ciphertext))
	out = append(out, []byte(fileMagicV1)...)
	out = append(out, salt...)
	out = append(out, nonce...)
	out = append(out, ciphertext...)
	return out, nil
}

func decrypt(machineSecret string, blob []byte) ([]byte, error) {
	minLen := len(fileMagicV1) + saltLen + nonceLen + 1
	if len(blob) < minLen {
		return nil, errors.New("config blob too small")
	}
	if string(blob[:len(fileMagicV1)]) != fileMagicV1 {
		return nil, errors.New("config blob magic mismatch")
	}

	offset := len(fileMagicV1)
	salt := blob[offset : offset+saltLen]
	offset += saltLen
	nonce := blob[offset : offset+nonceLen]
	offset += nonceLen
	ciphertext := blob[offset:]

	key := deriveKey(machineSecret, salt)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm: %w", err)
	}

	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt: %w", err)
	}
	return plaintext, nil
}

