/**
 * Experimental feature flags — opt-in toggles for in-progress work that isn't
 * ready to be the default. Persisted in the durable file store (never
 * localStorage), so a choice survives restarts like every other pref.
 *
 * p2pTransport: route a Keep connection over the encrypted WebRTC data channel
 * (relic.v1 tunneled P2P) instead of plain HTTP + WebSocket. Only the signaling
 * still rides HTTP; the API + gateway flow peer-to-peer. Media still loads over
 * HTTP for now (streaming over the channel is a later track), so a Keep whose
 * HTTP port is unreachable will connect + chat but not show media yet.
 */

import { kvGet, kvSet } from './storage'

export interface Experiments {
  p2pTransport: boolean
  /** Carry voice audio on the same P2P peer connection as the data channel,
   *  instead of a separate SFU connection on the Keep's voice port. Only takes
   *  effect when p2pTransport is on. Off → voice uses the existing SFU path. */
  voiceOnTransport: boolean
}

const KEY = 'reliquary.experiments.v1'

export const DEFAULT_EXPERIMENTS: Experiments = {
  p2pTransport: false,
  voiceOnTransport: false
}

export function getExperiments(): Experiments {
  try {
    const raw = kvGet(KEY)
    if (raw) return { ...DEFAULT_EXPERIMENTS, ...(JSON.parse(raw) as Partial<Experiments>) }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_EXPERIMENTS }
}

export function setExperiments(patch: Partial<Experiments>): Experiments {
  const next = { ...getExperiments(), ...patch }
  kvSet(KEY, JSON.stringify(next))
  return next
}

/** Whether new Keep connections should use the P2P data-channel transport. */
export function isP2PEnabled(): boolean {
  return getExperiments().p2pTransport
}

/** Whether voice should ride the shared P2P peer connection (vs the SFU path).
 *  Only meaningful alongside p2pTransport. */
export function isVoiceOnTransport(): boolean {
  const e = getExperiments()
  return e.p2pTransport && e.voiceOnTransport
}
