/**
 * Local presence preference — the status the user chose (online/idle/dnd/
 * invisible) plus an optional auto-expiry. Persisted durably (like updatePrefs)
 * so a chosen status + its remaining timer survive a restart; if the timer
 * already elapsed while the app was closed, we resolve back to Online.
 *
 * `presenceColor`/`presenceLabel` also drive the status dots rendered for other
 * members, so they accept the wire MemberState ('offline') too.
 */

import { kvGet, kvSet } from './storage'
import type { KeepPresence, MemberState } from '@/net/keep'

export interface PresencePref {
  state: KeepPresence
  /** ms epoch when the status auto-reverts to Online; 0 = forever */
  until: number
}

const KEY = 'reliquary.presence.v1'
const DEFAULT: PresencePref = { state: 'online', until: 0 }

export function getPresencePref(): PresencePref {
  try {
    const raw = kvGet(KEY)
    if (raw) return { ...DEFAULT, ...(JSON.parse(raw) as Partial<PresencePref>) }
  } catch {
    /* fall through */
  }
  return { ...DEFAULT }
}

export function setPresencePref(p: PresencePref): void {
  kvSet(KEY, JSON.stringify(p))
}

/** Duration choices in the status flyout. ms = 0 means "Forever". */
export const PRESENCE_DURATIONS: { label: string; ms: number }[] = [
  { label: 'For 15 Minutes', ms: 15 * 60_000 },
  { label: 'For 1 Hour', ms: 60 * 60_000 },
  { label: 'For 8 Hours', ms: 8 * 60 * 60_000 },
  { label: 'For 24 Hours', ms: 24 * 60 * 60_000 },
  { label: 'For 3 Days', ms: 3 * 24 * 60 * 60_000 },
  { label: 'Forever', ms: 0 }
]

export const PRESENCE_LABELS: Record<KeepPresence, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  invisible: 'Invisible'
}

/** The colored dot for any presence/member state. */
export function presenceColor(state: KeepPresence | MemberState): string {
  switch (state) {
    case 'online':
      return 'var(--color-pulse)'
    case 'idle':
      return 'var(--color-gold)'
    case 'dnd':
      return 'var(--color-ember)'
    default: // invisible / offline
      return 'var(--color-lo)'
  }
}

export function presenceLabel(state: KeepPresence | MemberState): string {
  if (state === 'offline') return 'Offline'
  return PRESENCE_LABELS[state]
}
