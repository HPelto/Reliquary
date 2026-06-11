/**
 * Update-banner preferences — which version the user has snoozed or dismissed.
 * Version-scoped so a NEWER version always surfaces a fresh banner even if an
 * older one was ignored. Persisted in the durable file store (never localStorage).
 */

import { kvGet, kvSet } from './storage'

export interface UpdatePrefs {
  /** banner is suppressed entirely while the available version equals this */
  ignoredVersion: string
  /** version that was snoozed via "Remind me tomorrow" */
  snoozedVersion: string
  /** ms epoch; the snoozed version's banner stays hidden until this time */
  snoozeUntil: number
}

const KEY = 'reliquary.update.v1'

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = {
  ignoredVersion: '',
  snoozedVersion: '',
  snoozeUntil: 0
}

export function getUpdatePrefs(): UpdatePrefs {
  try {
    const raw = kvGet(KEY)
    if (raw) return { ...DEFAULT_UPDATE_PREFS, ...(JSON.parse(raw) as Partial<UpdatePrefs>) }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_UPDATE_PREFS }
}

export function setUpdatePrefs(p: UpdatePrefs): void {
  kvSet(KEY, JSON.stringify(p))
}
