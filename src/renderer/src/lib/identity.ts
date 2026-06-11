/**
 * Client-owned identity ("relic key").
 *
 * v3 — seed-derived, wallet-style. The RECOVERY KEY is generated first and
 * the Ed25519 keypair is deterministically derived from it:
 *
 *   recovery key (160-bit, human-writable)
 *     └─ PBKDF2-SHA256(fixed protocol salt)  →  32-byte seed
 *          └─ Ed25519 keypair  →  pubkey  →  fingerprint
 *
 * Consequence: the recovery key alone can REBUILD the entire account from
 * nothing — wiped disk, lost laptop, new machine. Same key ⇒ same pubkey ⇒
 * every Keep recognizes the identity, roles and history intact. Losing the
 * local file no longer loses the account; only losing the recovery key AND
 * the unlocked local copy does.
 *
 * The password wraps the seed at rest (AES-256-GCM under PBKDF2) so daily
 * unlocks don't require the recovery key.
 *
 * PROTOCOL CONSTANTS: the seed derivation (salt + iterations) must never
 * change, or existing recovery keys would derive different identities.
 *
 * Storage: the main process's atomic file store (survives hard kills).
 * TODO before beta: wrap with Electron safeStorage for OS-level encryption.
 */

import * as ed from '@noble/ed25519'
import { kvGet, kvSet } from './storage'

export interface Identity {
  v: 3
  name: string
  accent: string
  pub: string // base64 raw Ed25519 public key (32 bytes)
  fingerprint: string // e.g. "9f2a-77c1-04bd-e3a8" — matches the Keep's rendering
  createdAt: number
  kdf: {
    saltPw: string // base64
    iterPw: number
  }
  blobPw: string // base64 iv‖ciphertext of the seed, password-wrapped
}

const STORAGE_KEY = 'reliquary.identity.v1'
const ITER_PW = 600_000 // OWASP-grade stretching for human passwords

// ── protocol constants: NEVER change (see header) ───────────────────
const SEED_SALT = 'reliquary.relic-seed.v1'
const SEED_ITER = 100_000

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function pbkdf2(
  secret: string,
  salt: Uint8Array,
  iterations: number,
  bits: number
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits']
  )
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
      base,
      bits
    )
  )
}

async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, usage)
}

async function wrap(secret: string, salt: Uint8Array, iterations: number, plaintext: Uint8Array): Promise<string> {
  const kek = await aesKey(await pbkdf2(secret, salt, iterations, 256), ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, kek, plaintext as BufferSource)
  )
  const blob = new Uint8Array(iv.length + ct.length)
  blob.set(iv, 0)
  blob.set(ct, iv.length)
  return toB64(blob)
}

async function unwrap(secret: string, salt: Uint8Array, iterations: number, blobB64: string): Promise<Uint8Array | null> {
  try {
    const kek = await aesKey(await pbkdf2(secret, salt, iterations, 256), ['decrypt'])
    const blob = fromB64(blobB64)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: blob.slice(0, 12) as BufferSource },
      kek,
      blob.slice(12) as BufferSource
    )
    return new Uint8Array(plaintext)
  } catch {
    return null
  }
}

async function fingerprintOf(pubRaw: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pubRaw as BufferSource))
  const hex = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
}

// ── recovery key ────────────────────────────────────────────────────

const RK_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford — no I/L/O/U

function b32chars(bytes: Uint8Array, count: number): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5 && out.length < count) {
      out += RK_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    if (out.length >= count) break
  }
  return out
}

/** 4-char checksum over the 32 data chars. A typo'd recovery key must fail
 *  loudly — a seed-derived key would otherwise silently rebuild a DIFFERENT
 *  identity. */
async function rkChecksum(data32: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data32) as BufferSource)
  )
  return b32chars(digest, 4)
}

/** 160 bits of entropy + checksum, shown as 9 groups of 4: "A3F9-…-CCCC". */
async function generateRecoveryKey(): Promise<string> {
  const data = b32chars(crypto.getRandomValues(new Uint8Array(20)), 32)
  const full = data + (await rkChecksum(data))
  return (full.match(/.{4}/g) ?? []).join('-')
}

/** Forgiving normalization: case, dashes, spaces, and 0/O 1/I lookalikes. */
export function normalizeRecoveryKey(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
}

/** Checksum verification — catches typos before they derive a wrong identity. */
export async function validateRecoveryKey(input: string): Promise<boolean> {
  const norm = normalizeRecoveryKey(input)
  if (norm.length !== 36) return false
  return (await rkChecksum(norm.slice(0, 32))) === norm.slice(32)
}

/** The protocol-constant derivation: recovery key (data chars) → seed. */
async function seedFromRecoveryKey(recoveryKey: string): Promise<Uint8Array> {
  const data = normalizeRecoveryKey(recoveryKey).slice(0, 32)
  return pbkdf2(data, new TextEncoder().encode(SEED_SALT), SEED_ITER, 256)
}

// ── lifecycle ───────────────────────────────────────────────────────

export interface ForgeResult {
  identity: Identity
  recoveryKey: string
  /** base64 Ed25519 seed — hold in memory only, never persist unwrapped. */
  privKey: string
}

async function buildIdentity(
  recoveryKey: string,
  name: string,
  accent: string,
  password: string
): Promise<ForgeResult> {
  const seed = await seedFromRecoveryKey(recoveryKey)
  const pub = await ed.getPublicKeyAsync(seed)
  const saltPw = crypto.getRandomValues(new Uint8Array(16))

  const identity: Identity = {
    v: 3,
    name,
    accent,
    pub: toB64(pub),
    fingerprint: await fingerprintOf(pub),
    createdAt: Date.now(),
    kdf: { saltPw: toB64(saltPw), iterPw: ITER_PW },
    blobPw: await wrap(password, saltPw, ITER_PW, seed)
  }
  return { identity, recoveryKey, privKey: toB64(seed) }
}

export async function forgeIdentity(
  name: string,
  accent: string,
  password: string
): Promise<ForgeResult> {
  return buildIdentity(await generateRecoveryKey(), name, accent, password)
}

/** Rebuild the SAME account from nothing but the recovery key — the answer
 *  to "my disk died". Same key ⇒ same pubkey ⇒ same identity everywhere.
 *  Throws on a checksum-invalid key rather than deriving a wrong identity. */
export async function restoreIdentity(
  recoveryKey: string,
  name: string,
  accent: string,
  password: string
): Promise<ForgeResult> {
  if (!(await validateRecoveryKey(recoveryKey))) {
    throw new Error("That recovery key isn't valid — check it for typos.")
  }
  return buildIdentity(recoveryKey, name, accent, password)
}

/** Returns the seed (base64) or null if the password is wrong. */
export async function unlockWithPassword(
  identity: Identity,
  password: string
): Promise<string | null> {
  const seed = await unwrap(password, fromB64(identity.kdf.saltPw), identity.kdf.iterPw, identity.blobPw)
  return seed ? toB64(seed) : null
}

/** Returns the seed (base64) or null if this recovery key derives a
 *  different identity than the stored one. */
export async function unlockWithRecoveryKey(
  identity: Identity,
  recoveryKey: string
): Promise<string | null> {
  const seed = await seedFromRecoveryKey(recoveryKey)
  const pub = await ed.getPublicKeyAsync(seed)
  return toB64(pub) === identity.pub ? toB64(seed) : null
}

/** Re-wrap the seed under a new password — the recovery key is unaffected
 *  (it derives the seed, it doesn't store it). */
export async function setNewPassword(
  identity: Identity,
  privKey: string,
  newPassword: string
): Promise<Identity> {
  const saltPw = crypto.getRandomValues(new Uint8Array(16))
  return {
    ...identity,
    kdf: { saltPw: toB64(saltPw), iterPw: ITER_PW },
    blobPw: await wrap(newPassword, saltPw, ITER_PW, fromB64(privKey))
  }
}

/** Sign a Keep's challenge nonce — the proof-of-ownership half of the handshake. */
export async function signNonce(privKey: string, nonce: string): Promise<string> {
  const sig = await ed.signAsync(new TextEncoder().encode(nonce), fromB64(privKey))
  return toB64(sig)
}

export function loadIdentity(): Identity | null {
  try {
    const raw = kvGet(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Identity
    // v1/v2 identities predate seed derivation — their recovery keys cannot
    // rebuild the keypair, so they are not carried forward.
    return parsed.v === 3 && parsed.pub && parsed.blobPw ? parsed : null
  } catch {
    return null
  }
}

export function saveIdentity(identity: Identity): void {
  kvSet(STORAGE_KEY, JSON.stringify(identity))
}
