/**
 * The canonical local profile. Name and accent live in the identity (they
 * flow through the handshake and predate this); the richer fields live here.
 * Media is kept as data URLs locally so the client can re-upload it to any
 * Keep it joins — content-addressed by SHA-256, matching the Keep's hashing.
 */

import { kvGet, kvSet } from './storage'

export interface Profile {
  about: string
  status: string
  avatar?: MediaRef
  background?: MediaRef
  nameFont?: string // username font key (see lib/nameStyle)
  nameEffect?: string // username effect key
  nameColor?: string // username text color (#rrggbb), or undefined for default
}

export interface MediaRef {
  hash: string // sha256 hex of the raw bytes — matches the Keep
  type: string // mime, e.g. "image/gif"
  dataUrl: string // the bytes, base64 data URL, for local render + re-upload
}

const KEY = 'reliquary.profile.v1'

export function loadProfile(): Profile {
  try {
    const raw = kvGet(KEY)
    if (raw) return JSON.parse(raw) as Profile
  } catch {
    /* fall through */
  }
  return { about: '', status: '' }
}

export function saveProfile(p: Profile): void {
  kvSet(KEY, JSON.stringify(p))
}

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const MAX_MEDIA_BYTES = 8 << 20

/** Read a picked File into a content-addressed MediaRef (validates type/size). */
export async function fileToMediaRef(file: File): Promise<MediaRef> {
  if (!ALLOWED.has(file.type)) {
    throw new Error('Use a PNG, JPEG, GIF, or WebP image.')
  }
  if (file.size > MAX_MEDIA_BYTES) {
    throw new Error('Image must be 8 MB or smaller.')
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  const hash = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')

  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  const dataUrl = `data:${file.type};base64,${btoa(binary)}`

  return { hash, type: file.type, dataUrl }
}

/** Convert a stored data URL back to raw bytes for upload to a Keep. */
export function mediaRefToBytes(ref: MediaRef): Uint8Array {
  const base64 = ref.dataUrl.slice(ref.dataUrl.indexOf(',') + 1)
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
