/**
 * Voice preferences — local & personal, never synced to a Keep. Persisted in
 * the durable file store (same pattern as notifications; NEVER localStorage for
 * anything that matters). The Settings → Account voice panel reads/writes these;
 * the live VoiceSession reads them when joining and when they change.
 */

import { kvGet, kvSet } from './storage'

export type MicMode = 'voice' | 'ptt'

export interface VoicePrefs {
  micDeviceId: string // '' = system default
  speakerDeviceId: string // '' = system default
  mode: MicMode
  pttKey: string // KeyboardEvent.code, e.g. 'KeyV' — only used in ptt mode
  /** voice-activity threshold, 0..1 of normalized RMS. Higher = less sensitive. */
  sensitivity: number
}

const KEY = 'reliquary.voice.v1'

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  micDeviceId: '',
  speakerDeviceId: '',
  mode: 'voice',
  pttKey: 'KeyV',
  sensitivity: 0.06
}

export function getVoicePrefs(): VoicePrefs {
  try {
    const raw = kvGet(KEY)
    if (raw) return { ...DEFAULT_VOICE_PREFS, ...(JSON.parse(raw) as Partial<VoicePrefs>) }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_VOICE_PREFS }
}

export function setVoicePrefs(prefs: VoicePrefs): void {
  kvSet(KEY, JSON.stringify(prefs))
}
