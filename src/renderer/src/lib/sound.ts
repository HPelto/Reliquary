/**
 * App sound effects. Assets live in /audio (aliased as @audio) and are bundled
 * by Vite, so they load same-origin and satisfy the CSP. Playback is
 * best-effort — a blocked autoplay or missing device never throws.
 */

import joinSfx from '@audio/KeepVoiceJoin.wav'
import leaveSfx from '@audio/KeepVoiceLeave.wav'

function play(src: string, volume: number): void {
  try {
    const a = new Audio(src)
    a.volume = volume
    void a.play().catch(() => {})
  } catch {
    /* audio unavailable — ignore */
  }
}

/** Someone entered a voice channel you're in (or you just joined). */
export function playVoiceJoin(): void {
  play(joinSfx, 0.5)
}

/** Someone left a voice channel you're in (or you just left). */
export function playVoiceLeave(): void {
  play(leaveSfx, 0.5)
}
