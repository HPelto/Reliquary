/**
 * VoiceSession — one live WebRTC call to a Keep's SFU.
 *
 * The client publishes ONE Opus mic track up; the Keep forwards every other
 * participant's mic back down. Per the glare-free rule, the client offers only
 * for the initial JOIN; the server drives every later renegotiation, which we
 * answer here. Speaking detection is entirely local: we analyse the audio we
 * RECEIVE (and our own mic), so every participant in the call sees who's
 * talking without any extra signaling.
 *
 * Like sockets in net/bind, the RTCPeerConnection and media objects live here —
 * never in the zustand store. The store holds only serializable mirrors.
 */

import { getKeep } from './bind'
import { useUi } from '@/store'
import { getVoicePrefs, setVoicePrefs, type VoicePrefs } from '@/lib/voicePrefs'
import { playVoiceJoin, playVoiceLeave } from '@/lib/sound'

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'failed'

export interface VoiceParticipant {
  userId: number
  muted: boolean
  deafened: boolean
}

let current: VoiceSession | null = null

function send(instanceId: string, t: string, d: unknown): void {
  getKeep(instanceId)?.sendGateway(t, d)
}

function setSinkId(el: HTMLAudioElement, deviceId: string): void {
  const sinkable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  if (deviceId && typeof sinkable.setSinkId === 'function') void sinkable.setSinkId(deviceId).catch(() => {})
}

interface Remote {
  el: HTMLAudioElement
  analyser: AnalyserNode | null
}

class VoiceSession {
  readonly instanceId: string
  readonly channelId: number

  private pc: RTCPeerConnection
  private localStream: MediaStream | null = null
  private micTrack: MediaStreamTrack | null = null
  private micSender: RTCRtpSender | null = null // the audio sender; trackless if no mic

  private remotes = new Map<number, Remote>() // userId → playback + analysis
  private audioCtx: AudioContext | null = null
  private localAnalyser: AnalyserNode | null = null
  private localSource: MediaStreamAudioSourceNode | null = null
  private selfId: number

  private iceQueue: RTCIceCandidateInit[] = []
  private speaking = new Set<number>()
  // last-known roster of THIS channel, for join/leave alert sounds
  private roster = new Set<number>()
  private rosterInit = false
  private aboveAt = new Map<number, number>() // userId → last time over threshold (ms), for hangover
  private rafId = 0
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private lastPing = 0
  private closed = false

  private prefs: VoicePrefs
  private pttHeld = false
  private muted = false
  private deafened = false
  private synthId = -1 // fallback ids for un-attributable tracks

  constructor(instanceId: string, channelId: number) {
    this.instanceId = instanceId
    this.channelId = channelId
    this.selfId = getKeep(instanceId)?.self?.id ?? 0
    this.prefs = getVoicePrefs()
    // STUN lets a NATed client discover its public address for hole-punching to
    // the SFU. Host/LAN/loopback candidates (the main process disables mDNS so
    // they're raw IPs the SFU can pair) cover same-machine + LAN.
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    })
  }

  async start(): Promise<void> {
    const ui = useUi.getState()
    ui.setVoiceStatus('connecting')

    // best-effort mic — null if none is available. We join either way.
    this.localStream = await this.acquireMic(this.prefs.micDeviceId)
    if (this.closed) return this.teardownMedia()

    this.micTrack = this.localStream?.getAudioTracks()[0] ?? null
    if (this.micTrack && this.localStream) {
      this.micSender = this.pc.addTrack(this.micTrack, this.localStream)
    } else {
      // no working mic — still join so we can HEAR everyone. The trackless
      // sendrecv sender lets a mic be added live later (replaceTrack, no reneg).
      this.micSender = this.pc.addTransceiver('audio', { direction: 'sendrecv' }).sender
      this.muted = true
    }
    this.applyMicEnabled()

    // committed to entering — cue the join sound.
    playVoiceJoin()

    this.pc.onicecandidate = (e) => {
      if (e.candidate) send(this.instanceId, 'VOICE_ICE', { candidate: e.candidate.toJSON() })
    }
    this.pc.ontrack = (e) => this.onRemoteTrack(e)
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return
      const st = this.pc.connectionState
      if (st === 'connected') useUi.getState().setVoiceStatus('connected', this.lastPing)
      else if (st === 'failed') useUi.getState().setVoiceStatus('failed')
    }

    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    if (this.closed) return this.teardownMedia()
    send(this.instanceId, 'VOICE_JOIN', { channel_id: this.channelId, sdp: this.pc.localDescription })

    this.startAnalysis()
    this.startStats()
    this.attachPttListeners()
  }

  /** Inbound VOICE_* signaling from the SFU (routed via net/bind onVoice). */
  handle(t: string, d: unknown): void {
    if (this.closed) return
    const data = d as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
    if (t === 'VOICE_ANSWER' && data.sdp) {
      void this.pc.setRemoteDescription(data.sdp).then(() => this.flushIce()).catch(() => {})
    } else if (t === 'VOICE_OFFER' && data.sdp) {
      void this.renegotiate(data.sdp)
    } else if (t === 'VOICE_ICE' && data.candidate) {
      if (!this.pc.remoteDescription) this.iceQueue.push(data.candidate)
      else void this.pc.addIceCandidate(data.candidate).catch(() => {})
    }
  }

  private async renegotiate(offer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(offer)
    this.flushIce()
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    if (this.closed) return
    send(this.instanceId, 'VOICE_ANSWER', { sdp: this.pc.localDescription })
  }

  private flushIce(): void {
    for (const c of this.iceQueue) void this.pc.addIceCandidate(c).catch(() => {})
    this.iceQueue = []
  }

  private onRemoteTrack(e: RTCTrackEvent): void {
    if (e.track.kind !== 'audio') return
    const stream = e.streams[0] ?? new MediaStream([e.track])
    const m = /user-(\d+)/.exec(e.streams[0]?.id ?? '')
    const userId = m ? Number(m[1]) : this.synthId--

    const el = new Audio()
    el.autoplay = true
    el.srcObject = stream
    el.muted = this.deafened
    setSinkId(el, this.prefs.speakerDeviceId)

    let analyser: AnalyserNode | null = null
    if (this.audioCtx) {
      try {
        const src = this.audioCtx.createMediaStreamSource(stream)
        analyser = this.audioCtx.createAnalyser()
        analyser.fftSize = 512
        src.connect(analyser)
      } catch {
        /* analysis is best-effort */
      }
    }
    this.remotes.set(userId, { el, analyser })

    const cleanup = (): void => {
      const r = this.remotes.get(userId)
      if (!r) return
      r.el.srcObject = null
      this.remotes.delete(userId)
      this.aboveAt.delete(userId)
    }
    e.track.addEventListener('ended', cleanup)
  }

  // ── speaking detection (local, from received audio + own mic) ──────────────

  private bindLocalAnalyser(): void {
    if (!this.audioCtx || !this.localStream) {
      this.localAnalyser = null
      return
    }
    try {
      this.localSource?.disconnect()
      this.localSource = this.audioCtx.createMediaStreamSource(this.localStream)
      this.localAnalyser = this.audioCtx.createAnalyser()
      this.localAnalyser.fftSize = 512
      this.localSource.connect(this.localAnalyser)
    } catch {
      this.localAnalyser = null // best-effort
    }
  }

  private startAnalysis(): void {
    try {
      this.audioCtx = new AudioContext()
      void this.audioCtx.resume().catch(() => {})
      this.bindLocalAnalyser()
    } catch {
      return // no analysis available; calls still work, just no speaking glow
    }
    const buf = new Uint8Array(512)
    const HANGOVER = 220 // ms a speaker stays lit after dropping below threshold
    const tick = (now: number): void => {
      if (this.closed) return
      const next = new Set<number>()
      const consider = (id: number, analyser: AnalyserNode | null): void => {
        if (!analyser) return
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / buf.length)
        if (rms > this.prefs.sensitivity) this.aboveAt.set(id, now)
        if (now - (this.aboveAt.get(id) ?? -Infinity) < HANGOVER) next.add(id)
      }
      // self only counts as speaking when the mic is actually live
      if (this.micTrack?.enabled) consider(this.selfId, this.localAnalyser)
      for (const [id, r] of this.remotes) consider(id, r.analyser)

      if (!sameSet(next, this.speaking)) {
        this.speaking = next
        useUi.getState().setVoiceSpeaking([...next])
      }
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private startStats(): void {
    this.statsTimer = setInterval(() => {
      void this.pc.getStats().then((stats) => {
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && (r as { nominated?: boolean }).nominated) {
            const rtt = (r as { currentRoundTripTime?: number }).currentRoundTripTime
            if (typeof rtt === 'number') {
              this.lastPing = Math.max(1, Math.round(rtt * 1000))
              if (this.pc.connectionState === 'connected') {
                useUi.getState().setVoiceStatus('connected', this.lastPing)
              }
            }
          }
        })
      })
    }, 3000)
  }

  // ── mic state ──────────────────────────────────────────────────────────────

  private applyMicEnabled(): void {
    if (!this.micTrack) return
    const live = this.prefs.mode === 'ptt' ? this.pttHeld && !this.muted : !this.muted
    this.micTrack.enabled = live && !this.deafened
  }

  /** Get a mic stream for deviceId, falling back to the system default (and
   *  forgetting a dead deviceId). Returns null when no microphone exists at all. */
  private async acquireMic(deviceId: string): Promise<MediaStream | null> {
    const get = async (id: string): Promise<MediaStream | null> => {
      const audio: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
      if (id) audio.deviceId = { exact: id }
      try {
        return await navigator.mediaDevices.getUserMedia({ audio })
      } catch {
        return null
      }
    }
    const exact = await get(deviceId)
    if (exact) return exact
    if (!deviceId) return null // already tried the default — no mic present
    // the chosen device is gone — forget it and use the system default
    this.prefs = { ...this.prefs, micDeviceId: '' }
    setVoicePrefs(this.prefs)
    return get('')
  }

  /** Switch the microphone live, without leaving the call (replaceTrack). */
  async setMic(deviceId: string): Promise<void> {
    if (this.closed || !this.micSender) return
    this.prefs = { ...this.prefs, micDeviceId: deviceId }
    setVoicePrefs(this.prefs)
    const stream = await this.acquireMic(deviceId)
    if (this.closed || !stream) return
    const track = stream.getAudioTracks()[0]
    if (!track) return
    await this.micSender.replaceTrack(track).catch(() => {})
    this.micTrack?.stop()
    this.localStream?.getTracks().forEach((t) => t.stop())
    this.localStream = stream
    this.micTrack = track
    this.muted = false
    this.bindLocalAnalyser()
    this.applyMicEnabled()
  }

  setState(muted: boolean, deafened: boolean): void {
    this.muted = muted
    this.deafened = deafened
    this.applyMicEnabled()
    for (const r of this.remotes.values()) r.el.muted = deafened
    send(this.instanceId, 'VOICE_STATE', { muted, deafened })
  }

  setSpeaker(deviceId: string): void {
    this.prefs.speakerDeviceId = deviceId
    for (const r of this.remotes.values()) setSinkId(r.el, deviceId)
  }

  /** Roster of our channel changed — alert us when OTHERS come or go. Our own
   *  join/leave sounds are played locally in start()/leave(). The first roster
   *  after joining is the snapshot and is intentionally silent. */
  handleRoster(userIds: number[]): void {
    const next = new Set(userIds)
    if (!this.rosterInit) {
      this.roster = next
      this.rosterInit = true
      return
    }
    let joined = false
    let left = false
    for (const id of next) if (id !== this.selfId && !this.roster.has(id)) joined = true
    for (const id of this.roster) if (id !== this.selfId && !next.has(id)) left = true
    this.roster = next
    if (joined) playVoiceJoin()
    if (left) playVoiceLeave()
  }

  // ── push-to-talk ─────────────────────────────────────────────────────────

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping()) return // don't capture the PTT key while typing a message
    if (e.code === this.prefs.pttKey && !this.pttHeld) {
      this.pttHeld = true
      this.applyMicEnabled()
    }
  }
  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === this.prefs.pttKey && this.pttHeld) {
      this.pttHeld = false
      this.applyMicEnabled()
    }
  }
  private attachPttListeners(): void {
    if (this.prefs.mode !== 'ptt') return
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  // ── teardown ───────────────────────────────────────────────────────────────

  private teardownMedia(): void {
    this.localStream?.getTracks().forEach((t) => t.stop())
    for (const r of this.remotes.values()) r.el.srcObject = null
    this.remotes.clear()
    void this.audioCtx?.close().catch(() => {})
  }

  leave(): void {
    if (this.closed) return
    this.closed = true
    playVoiceLeave() // we hear our own exit; those who remain hear it via the roster diff
    send(this.instanceId, 'VOICE_LEAVE', {})
    if (this.rafId) cancelAnimationFrame(this.rafId)
    if (this.statsTimer) clearInterval(this.statsTimer)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.teardownMedia()
    try {
      this.pc.close()
    } catch {
      /* already closed */
    }
    useUi.getState().setVoiceSpeaking([])
  }
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/** True when the user is typing into a field — so PTT keydown shouldn't grab it. */
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

// ── module API used by the store and net/bind ────────────────────────────────

export async function startVoice(instanceId: string, channelId: number): Promise<void> {
  stopVoice()
  const s = new VoiceSession(instanceId, channelId)
  current = s
  try {
    await s.start()
  } catch {
    if (current === s) current = null
  }
}

export function stopVoice(): void {
  current?.leave()
  current = null
}

export function voiceSetState(muted: boolean, deafened: boolean): void {
  current?.setState(muted, deafened)
}

export function voiceSetSpeaker(deviceId: string): void {
  current?.setSpeaker(deviceId)
}

/** Switch the active call's microphone live (also persisted for next join). */
export function voiceSetMic(deviceId: string): void {
  void current?.setMic(deviceId)
}

/** Route a VOICE_* gateway frame: state updates patch the store (so channel
 *  occupancy shows for everyone); signaling goes to the active session. */
export function routeVoiceFrame(instanceId: string, t: string, d: unknown): void {
  if (t === 'VOICE_STATE_UPDATE') {
    const dd = d as {
      channel_id: number
      participants: { user_id: number; muted: boolean; deafened: boolean }[]
    }
    const participants = dd.participants ?? []
    useUi.getState().applyVoiceState(
      instanceId,
      dd.channel_id,
      participants.map((p) => ({ userId: p.user_id, muted: p.muted, deafened: p.deafened }))
    )
    // join/leave alert sounds, but only for the channel we're actually sitting in
    if (current && current.instanceId === instanceId && current.channelId === dd.channel_id) {
      current.handleRoster(participants.map((p) => p.user_id))
    }
    return
  }
  if (current && current.instanceId === instanceId) current.handle(t, d)
}
