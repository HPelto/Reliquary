/**
 * relic:// addressing.
 *
 * A "relic code" (REL3-…) is a self-contained, *encrypted* invite. The
 * payload — host, port, optional display name, invite token, and TLS key
 * fingerprint — is packed into a compact binary form, sealed with
 * AES-128-GCM under a random one-time key, and the code carries
 * key ‖ ciphertext, base32-encoded (Crockford alphabet — no ambiguous
 * I/L/O/U).
 *
 * Size: the payload is binary, not JSON (an IPv4 host is 4 bytes, not a
 * 15-char string); the GCM nonce is a fixed constant — safe because every
 * code uses a fresh random key, so the (key, nonce) pair is never reused —
 * and the auth tag is truncated to 64 bits. A typical IP invite is ~60
 * characters instead of ~170.
 *
 * Threat model: the code is a bearer credential. Anyone holding the FULL
 * code can decrypt and connect (the key rides inside it) — share it like a
 * password. What the encryption buys: the host/IP is never legible in the
 * string itself, so screenshots, stream overlays, and chat logs don't
 * expose where the server lives, and GCM's auth tag rejects tampered or
 * corrupted codes. No registry or central service is involved — decoding
 * happens entirely in the client.
 */

export const DEFAULT_PORT = 7777

const CODE_TAG = 'REL3'
const KEY_LEN = 16
const TAG_BITS = 64
const TAG_BYTES = TAG_BITS / 8
const NONCE = new Uint8Array(12) // constant: safe under a unique per-code key
const PAYLOAD_VERSION = 3

export interface RelicTarget {
  host: string
  port: number
  name?: string
  token?: string
  fingerprint?: string
  source: 'code' | 'uri' | 'domain' | 'ip'
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function b32encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function b32decode(s: string): Uint8Array | null {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s.toUpperCase()) {
    const idx = ALPHABET.indexOf(ch)
    if (idx === -1) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

interface Payload {
  host: string
  port: number
  name?: string
  token?: string
  fingerprint?: string
}

const IP_RE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/
const IP_EXACT = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const DOMAIN_RE = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::(\d{1,5}))?$/i
const JOIN_LINK_RE = /^relic:\/\/j\/(REL3[0-9A-Z-]+)$/i

const FLAG_IPV4 = 1
const FLAG_NAME = 2
const FLAG_TOKEN = 4
const FLAG_FINGERPRINT = 8

function packPayload(p: Payload): Uint8Array {
  const enc = new TextEncoder()
  const bytes: number[] = [PAYLOAD_VERSION, 0] // [1] = flags, filled below
  let flags = 0

  const ip = p.host.match(IP_EXACT)
  const ipOctets = ip ? ip.slice(1).map(Number) : null
  if (ipOctets && ipOctets.every((o) => o <= 255)) {
    flags |= FLAG_IPV4
    bytes.push(...ipOctets)
  } else {
    const hb = enc.encode(p.host)
    bytes.push(hb.length, ...hb)
  }

  bytes.push((p.port >> 8) & 255, p.port & 255)

  const pushStr = (s: string, flag: number): void => {
    flags |= flag
    const b = enc.encode(s)
    bytes.push(b.length, ...b)
  }
  if (p.name) pushStr(p.name, FLAG_NAME)
  if (p.token) pushStr(p.token, FLAG_TOKEN)
  if (p.fingerprint) pushStr(p.fingerprint, FLAG_FINGERPRINT)

  bytes[1] = flags
  return new Uint8Array(bytes)
}

function unpackPayload(bytes: Uint8Array): Payload | null {
  let i = 0
  if (bytes[i++] !== PAYLOAD_VERSION) return null
  const flags = bytes[i++]

  let host: string
  if (flags & FLAG_IPV4) {
    if (i + 4 > bytes.length) return null
    host = `${bytes[i++]}.${bytes[i++]}.${bytes[i++]}.${bytes[i++]}`
  } else {
    const len = bytes[i++]
    if (i + len > bytes.length) return null
    host = new TextDecoder().decode(bytes.slice(i, i + len))
    i += len
  }

  if (i + 2 > bytes.length) return null
  const port = (bytes[i++] << 8) | bytes[i++]

  const readStr = (): string => {
    const len = bytes[i++]
    const s = new TextDecoder().decode(bytes.slice(i, i + len))
    i += len
    return s
  }
  const name = flags & FLAG_NAME ? readStr() : undefined
  const token = flags & FLAG_TOKEN ? readStr() : undefined
  const fingerprint = flags & FLAG_FINGERPRINT ? readStr() : undefined

  return { host, port, name, token, fingerprint }
}

export async function encodeRelicCode(target: {
  host: string
  port?: number
  name?: string
  token?: string
  fingerprint?: string
}): Promise<string> {
  const plaintext = packPayload({ ...target, port: target.port ?? DEFAULT_PORT })
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_LEN))
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, [
    'encrypt'
  ])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: NONCE as BufferSource, tagLength: TAG_BITS },
      key,
      plaintext as BufferSource
    )
  )

  const blob = new Uint8Array(KEY_LEN + ciphertext.length)
  blob.set(keyBytes, 0)
  blob.set(ciphertext, KEY_LEN)

  const raw = CODE_TAG + b32encode(blob)
  return formatCode(raw)
}

export async function decodeRelicCode(code: string): Promise<RelicTarget | null> {
  const cleaned = code.trim().toUpperCase().replace(/-/g, '')
  if (!cleaned.startsWith(CODE_TAG)) return null
  const blob = b32decode(cleaned.slice(CODE_TAG.length))
  if (!blob || blob.length <= KEY_LEN + TAG_BYTES) return null

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      blob.slice(0, KEY_LEN) as BufferSource,
      'AES-GCM',
      false,
      ['decrypt']
    )
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: NONCE as BufferSource, tagLength: TAG_BITS },
        key,
        blob.slice(KEY_LEN) as BufferSource
      )
    )
    const p = unpackPayload(plaintext)
    if (!p || !p.host || !p.port) return null
    return { ...p, source: 'code' }
  } catch {
    return null
  }
}

/** Group as REL3-XXXXX-XXXXX… for human-readable display. */
export function formatCode(raw: string): string {
  const body = raw.replace(/-/g, '').replace(new RegExp(`^${CODE_TAG}`, 'i'), '')
  return CODE_TAG + '-' + (body.match(/.{1,5}/g) ?? []).join('-')
}

/** Sync parser for direct host/IP forms only (no codes). Used by the invite generator. */
export function parseHostPort(input: string): RelicTarget | null {
  const raw = input.trim()
  if (!raw) return null

  const ip = raw.match(IP_RE)
  if (ip) {
    if (ip[1].split('.').some((o) => Number(o) > 255)) return null
    const port = ip[2] ? Number(ip[2]) : DEFAULT_PORT
    if (port < 1 || port > 65535) return null
    return { host: ip[1], port, source: 'ip' }
  }

  const domain = raw.match(DOMAIN_RE)
  if (domain) {
    const port = domain[2] ? Number(domain[2]) : DEFAULT_PORT
    if (port < 1 || port > 65535) return null
    return { host: domain[1].toLowerCase(), port, source: 'domain' }
  }

  return null
}

/** Accepts anything a user might paste: REL3 code, relic:// URI or join link, domain, IP:port. */
export async function parseAddress(input: string): Promise<RelicTarget | null> {
  const raw = input.trim()
  if (!raw) return null

  if (/^rel3/i.test(raw.replace(/-/g, ''))) return decodeRelicCode(raw)

  const joinLinkMatch = raw.match(JOIN_LINK_RE)
  if (joinLinkMatch) return decodeRelicCode(joinLinkMatch[1])

  if (/^relic:\/\//i.test(raw)) {
    try {
      const url = new URL(raw.replace(/^relic:\/\//i, 'https://'))
      const token = url.pathname.split('/').filter(Boolean).pop()
      return {
        host: url.hostname,
        port: url.port ? Number(url.port) : DEFAULT_PORT,
        token,
        source: IP_RE.test(url.hostname) ? 'ip' : 'uri'
      }
    } catch {
      return null
    }
  }

  return parseHostPort(raw)
}

export function toUri(t: RelicTarget): string {
  const portPart = t.port === DEFAULT_PORT ? '' : `:${t.port}`
  const tokenPart = t.token ? `/${t.token}` : ''
  return `relic://${t.host}${portPart}${tokenPart}`
}

/** Clickable deep-link form of an encrypted code — reveals nothing about the host. */
export function joinLink(code: string): string {
  return `relic://j/${code.replace(/-/g, '')}`
}

/** Deterministic accent + mock stats per host, so previews are stable. */
export function hostHash(host: string): number {
  let h = 5381
  for (let i = 0; i < host.length; i++) h = ((h << 5) + h + host.charCodeAt(i)) >>> 0
  return h
}

/** Non-identifying display tag for a keep — stable per host, reveals nothing.
 *  The real address is shown only in the server settings page. */
export function hostTag(host: string): string {
  return 'vault-' + hostHash(host).toString(16).padStart(8, '0').slice(0, 4)
}

// vivid pool — used ONLY to color self-hosted server tiles (accentFor)
export const ACCENT_POOL = ['#8b7cf6', '#5ea2ff', '#3ddcc4', '#e8c97a', '#ff6b81', '#7dd3fc']

// the default accent is a readable neutral — visible without glow
export const DEFAULT_ACCENT = '#aab1c0'

// presets offered in the color picker: neutral default first, then the vivids
export const ACCENT_PRESETS = [DEFAULT_ACCENT, ...ACCENT_POOL]

export function accentFor(host: string): string {
  return ACCENT_POOL[hostHash(host) % ACCENT_POOL.length]
}

export function displayName(t: RelicTarget): string {
  if (t.name) return t.name
  if (IP_EXACT.test(t.host)) return t.host
  const label = t.host.split('.')[0]
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function abbrOf(t: RelicTarget): string {
  if (t.name) {
    return t.name
      .split(/[\s-]+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase()
  }
  if (IP_EXACT.test(t.host)) return t.host.split('.').pop()!.slice(0, 3)
  return displayName(t).slice(0, 2).toUpperCase()
}
