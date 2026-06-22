/**
 * Per-identity silence + block lists. Client-local and personal — never synced.
 * Keyed by the user's Ed25519 pubkey so they apply across every Keep.
 *
 * silence — never play the chat sound for this user (regardless of notification
 *           prefs).
 * block   — also hide their messages behind a "blocked user" veil and treat them
 *           as blocked everywhere.
 *
 * The reactive copy lives in the zustand store; this module is just load/save.
 */

import { kvGet, kvSet } from './storage'

export interface BlockedUser {
  pubkey: string
  username: string
  fingerprint: string
  at: number // unix ms
}

export interface Blocks {
  blocked: Record<string, BlockedUser> // pubkey → info
  silenced: Record<string, BlockedUser>
}

const KEY = 'reliquary.blocks.v1'

export function loadBlocks(): Blocks {
  try {
    const raw = kvGet(KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Blocks>
      return { blocked: p.blocked ?? {}, silenced: p.silenced ?? {} }
    }
  } catch {
    /* fall through */
  }
  return { blocked: {}, silenced: {} }
}

export function saveBlocks(b: Blocks): void {
  kvSet(KEY, JSON.stringify(b))
}
