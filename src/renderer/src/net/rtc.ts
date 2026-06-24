// WebRTC data-channel transport for the Keep API.
//
// It establishes a hole-punched peer connection to the Keep and tunnels relic.v1
// requests/responses over a DTLS-encrypted data channel. Only the *signaling*
// (the SDP offer/answer) goes over plain HTTP — which in production rides a
// Cloudflare tunnel or a small forwarded "handshake" port; the API traffic
// itself flows peer-to-peer, so media/files never touch the tunnel.
//
// `request()` mirrors the shape KeepConnection uses, so this can stand in for
// fetch() once the gateway + media streaming layers land on top.
//
// Identity attestation: the Keep signs the answer's DTLS fingerprint with its
// Ed25519 identity key. If we know that key out-of-band (from the invite code),
// we verify the signature and pubkey before accepting the answer — so a MITM
// that swaps in its own DTLS cert is rejected. No CA, no certificate authority.

import * as ed from '@noble/ed25519'

// ICE servers are owner-configured per Keep and fetched at connect time (see
// fetchIceConfig). None configured = host candidates only, which gather in
// milliseconds — near-instant connects on LAN/loopback. Cross-NAT hosting points
// at the owner's own STUN/TURN (never a hardcoded third party); force-relay pins
// everything through TURN so members never see the Keep's IP.
const LABEL = 'relic'
// Payload bytes per data-channel message — must match the Keep's maxChunk.
// Larger logical messages (big /world responses, media) split into framed chunks
// [msgID u32][index u16][total u16][payload] and reassemble on the far side.
const MAX_CHUNK = 16 * 1024

interface WireResponse {
  id: number
  status: number
  headers?: Record<string, string>
  body?: string // base64 — Go encodes []byte as base64 in JSON
}

/** A realtime gateway push (the relic.v1 {t,d} envelope) the Keep streams to a
 *  subscribed peer over the same data channel. */
export interface GatewayEvent {
  t: string
  d: unknown
}

// A server→client frame carrying a gateway push instead of a response. The
// presence of `gw` is how we tell a push apart from a WireResponse on the wire.
interface WirePush {
  gw?: GatewayEvent
}

export interface RtcResponse {
  status: number
  headers: Record<string, string>
  text: string
}

export interface RtcBytesResponse {
  status: number
  headers: Record<string, string>
  bytes: Uint8Array
}

export class RtcTransport {
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private nextId = 1
  private outMsgId = 0
  private pending = new Map<
    number,
    { resolve: (r: WireResponse) => void; reject: (e: Error) => void }
  >()
  private incoming = new Map<number, { total: number; got: number; parts: Uint8Array[] }>()
  private ready: Promise<void> | null = null
  private onGateway: ((ev: GatewayEvent) => void) | null = null
  private userClosed = false

  /** The Keep identity pubkey (base64) we actually verified this connection
   *  against — null until a successful attested connect. The owner can persist
   *  it to pin future connects (trust-on-first-use). */
  verifiedKeepKey: string | null = null

  /** Fired once when the peer connection drops (failed/closed) without an
   *  explicit close() — lets the owner schedule a reconnect. Not called for a
   *  user-initiated close(). */
  onClose: (() => void) | null = null

  /**
   * @param signalUrl the Keep's POST /v1/rtc/connect endpoint (over HTTP/tunnel).
   * @param expectedKeepKey the Keep's identity pubkey (base64) learned out-of-band
   *   (from the invite code / a prior connect). When set, the connection is
   *   refused unless the Keep proves it holds the matching private key — MITM
   *   protection. When unset, the signature is still verified if present (TOFU).
   */
  constructor(
    private readonly signalUrl: string,
    private readonly expectedKeepKey?: string
  ) {}

  /** Establish the peer connection + data channel. Idempotent. */
  connect(): Promise<void> {
    if (!this.ready) this.ready = this.doConnect()
    return this.ready
  }

  // Fetch the Keep's owner-configured ICE servers (GET /v1/rtc/ice) before
  // building the PC. Best-effort: on failure we proceed with none (host
  // candidates — fine on LAN/loopback).
  private async fetchIceConfig(): Promise<{ servers: RTCIceServer[]; forceRelay: boolean }> {
    try {
      const res = await fetch(this.signalUrl.replace(/\/connect$/, '/ice'))
      if (res.ok) {
        const cfg = (await res.json()) as { ice_servers?: RTCIceServer[]; force_relay?: boolean }
        return { servers: cfg.ice_servers ?? [], forceRelay: !!cfg.force_relay }
      }
    } catch {
      /* no ICE config reachable — host candidates only */
    }
    return { servers: [], forceRelay: false }
  }

  private async doConnect(): Promise<void> {
    // Fetch the owner-configured ICE servers over HTTP first — they're needed to
    // build the PC, so they can't ride the channel. None configured = host
    // candidates only (LAN/loopback). force_relay pins traffic through TURN.
    const ice = await this.fetchIceConfig()
    const pc = new RTCPeerConnection({
      iceServers: ice.servers,
      ...(ice.forceRelay ? { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } : {})
    })
    this.pc = pc
    const dc = pc.createDataChannel(LABEL, { ordered: true })
    dc.binaryType = 'arraybuffer'
    this.dc = dc

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.handleDrop(pc)
      }
    })

    dc.addEventListener('message', (e) => this.onChunk(e.data as ArrayBuffer))

    const open = new Promise<void>((resolve, reject) => {
      dc.addEventListener('open', () => resolve())
      dc.addEventListener('error', () => reject(new Error('data channel error')))
    })

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    // non-trickle: one round-trip signaling. Allow longer when STUN/TURN is
    // configured so reflexive/relay candidates have time to arrive.
    await iceGatheringComplete(pc, ice.servers.length ? 4000 : 1200)

    const res = await fetch(this.signalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pc.localDescription)
    })
    if (!res.ok) throw new Error(`signaling failed: ${res.status}`)
    const data = (await res.json()) as {
      answer?: RTCSessionDescriptionInit
      keep_key?: string
      fingerprint_sig?: string
    } & RTCSessionDescriptionInit
    // tolerate either {answer,…} or a bare answer (older signaling)
    const answer: RTCSessionDescriptionInit = data.answer ?? data
    await this.verifyKeepIdentity(answer.sdp ?? '', data.keep_key, data.fingerprint_sig)
    await pc.setRemoteDescription(answer)

    await withTimeout(open, 15000, 'data channel never opened (ICE failed?)')
  }

  // Verify the Keep's identity attestation BEFORE accepting its answer.
  //  - If we have a pinned key, the presented key MUST match it, and (since a
  //    pin means we expect attestation) the signature MUST be present + valid —
  //    otherwise it's a MITM or a downgrade.
  //  - With no pin, we still verify any signature offered: it binds this DTLS
  //    session to the presented key, which the caller can persist to pin later.
  private async verifyKeepIdentity(sdp: string, keepKey?: string, sig?: string): Promise<void> {
    if (this.expectedKeepKey) {
      if (!keepKey || keepKey !== this.expectedKeepKey) {
        throw new Error('keep identity mismatch — refusing to connect (possible MITM)')
      }
      if (!sig) throw new Error('keep did not attest its identity — refusing to connect')
    }
    if (keepKey && sig) {
      const fp = dtlsFingerprint(sdp)
      if (!fp) throw new Error('no DTLS fingerprint in the keep answer')
      const ok = await ed.verifyAsync(
        b64ToBytes(sig),
        new TextEncoder().encode(fp),
        b64ToBytes(keepKey)
      )
      if (!ok) throw new Error('invalid keep identity signature — refusing to connect')
      this.verifiedKeepKey = keepKey
    }
  }

  /** Tunnel one API request over the channel and await its response (text body —
   *  the JSON API). */
  async request(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: string }
  ): Promise<RtcResponse> {
    const resp = await this.roundtrip(
      method,
      path,
      opts?.headers,
      opts?.body ? b64encodeBytes(new TextEncoder().encode(opts.body)) : undefined
    )
    return {
      status: resp.status,
      headers: resp.headers ?? {},
      text: resp.body ? b64decode(resp.body) : ''
    }
  }

  /** Tunnel one request whose body + response are raw bytes (media). Binary-safe:
   *  bytes never round-trip through a UTF-8 string, unlike request(). Media can be
   *  large, so the timeout is generous. */
  async requestBytes(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: Uint8Array; timeoutMs?: number }
  ): Promise<RtcBytesResponse> {
    const resp = await this.roundtrip(
      method,
      path,
      opts?.headers,
      opts?.body ? b64encodeBytes(opts.body) : undefined,
      opts?.timeoutMs ?? 120000
    )
    return {
      status: resp.status,
      headers: resp.headers ?? {},
      bytes: resp.body ? b64decodeBytes(resp.body) : new Uint8Array(0)
    }
  }

  // One framed request → its response over the channel. The body is already
  // base64 (matching Go's []byte JSON), so this is agnostic to text vs binary.
  private async roundtrip(
    method: string,
    path: string,
    headers?: Record<string, string>,
    bodyB64?: string,
    timeoutMs = 30000
  ): Promise<WireResponse> {
    await this.connect()
    if (!this.dc || this.dc.readyState !== 'open') throw new Error('rtc transport not connected')
    const id = this.nextId++
    const frame = { id, method, path, headers, body: bodyB64 }
    return new Promise<WireResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.sendChunked(new TextEncoder().encode(JSON.stringify(frame)))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('rtc request timed out'))
      }, timeoutMs)
    })
  }

  /**
   * Open a realtime gateway subscription over the channel. The Keep streams hub
   * events as push frames, each routed to `onEvent` — the same {t,d} envelopes a
   * WebSocket gateway delivers, so the caller can feed them straight into the
   * existing dispatch. The subscribe frame is fire-and-forget (the stream has no
   * single response); the first event back is a HELLO, mirroring the WS gateway.
   */
  async subscribeGateway(token: string, onEvent: (ev: GatewayEvent) => void): Promise<void> {
    await this.connect()
    if (!this.dc || this.dc.readyState !== 'open') throw new Error('rtc transport not connected')
    this.onGateway = onEvent
    // id 0 is reserved (real requests start at 1) — this frame gets no response.
    const frame = {
      id: 0,
      method: 'GET',
      path: '/v1/gateway',
      headers: { Authorization: `Bearer ${token}` }
    }
    this.sendChunked(new TextEncoder().encode(JSON.stringify(frame)))
  }

  /** Send a client→server gateway frame (presence change, voice signaling) up the
   *  channel as `{up:{t,d}}`. Best-effort — returns false if not open. Requires a
   *  prior subscribeGateway so the server can attribute it to this user. */
  sendUpstream(t: string, d: unknown): boolean {
    if (!this.dc || this.dc.readyState !== 'open') return false
    this.sendChunked(new TextEncoder().encode(JSON.stringify({ up: { t, d } })))
    return true
  }

  /** The live peer connection once the data channel is open, else null. Lets
   *  voice ride this same hole-punched connection (A6b) instead of a separate
   *  SFU port — adding an audio track is a renegotiation that reuses the
   *  established ICE/DTLS. */
  peerConnection(): RTCPeerConnection | null {
    return this.dc?.readyState === 'open' ? this.pc : null
  }

  close(): void {
    this.userClosed = true
    this.teardown()
    this.onGateway = null
  }

  // Tear down the peer connection + in-flight state, but leave callbacks intact
  // so a reconnect can rebuild. Shared by close() and handleDrop().
  private teardown(): void {
    this.dc?.close()
    this.pc?.close()
    this.pc = null
    this.dc = null
    this.ready = null
    // fail any in-flight requests now rather than letting them hang to timeout
    for (const { reject } of this.pending.values()) reject(new Error('rtc transport closed'))
    this.pending.clear()
    this.incoming.clear()
  }

  // The peer connection failed (not a user close). Reset so the next connect()
  // rebuilds a fresh pc, then notify the owner so it can reconnect. Guarded to
  // fire once per pc — a stale event from an already-replaced connection is
  // ignored (this.pc only matches the live one).
  private handleDrop(pc: RTCPeerConnection): void {
    if (this.userClosed || this.pc !== pc) return
    this.teardown()
    this.onClose?.()
  }

  // split a logical message into framed binary chunks (matches the Keep's
  // session.send). Concurrent messages interleave safely — each chunk is tagged.
  private sendChunked(payload: Uint8Array): void {
    const dc = this.dc!
    const total = Math.max(1, Math.ceil(payload.length / MAX_CHUNK))
    const id = this.outMsgId++ >>> 0
    for (let i = 0; i < total; i++) {
      const slice = payload.subarray(i * MAX_CHUNK, (i + 1) * MAX_CHUNK)
      const frame = new Uint8Array(8 + slice.length)
      const dv = new DataView(frame.buffer)
      dv.setUint32(0, id)
      dv.setUint16(4, i)
      dv.setUint16(6, total)
      frame.set(slice, 8)
      dc.send(frame)
    }
  }

  // reassemble framed chunks; on a complete message, resolve its pending request.
  private onChunk(buf: ArrayBuffer): void {
    if (buf.byteLength < 8) return
    const dv = new DataView(buf)
    const id = dv.getUint32(0)
    const idx = dv.getUint16(4)
    const total = dv.getUint16(6)
    if (total === 0) return

    let a = this.incoming.get(id)
    if (!a) {
      a = { total, got: 0, parts: new Array(total) }
      this.incoming.set(id, a)
    }
    if (idx < a.parts.length && !a.parts[idx]) {
      a.parts[idx] = new Uint8Array(buf.slice(8))
      a.got++
    }
    if (a.got !== a.total) return

    this.incoming.delete(id)
    let msg: WireResponse & WirePush
    try {
      msg = JSON.parse(new TextDecoder().decode(concatBytes(a.parts)))
    } catch {
      return
    }
    // A push frame carries a gateway event; a response resolves a pending request.
    if (msg.gw) {
      this.onGateway?.(msg.gw)
      return
    }
    const fn = this.pending.get(msg.id)
    if (fn) {
      this.pending.delete(msg.id)
      fn.resolve(msg)
    }
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// Wait for ICE gathering to finish so the single-shot (non-trickle) offer carries
// all candidates — but cap the wait. A slow or unreachable STUN server (e.g. no
// internet, or DNS that can't resolve stun.l.google.com) would otherwise stall
// gathering until its multi-second timeout on EVERY connect. Host candidates —
// all that's needed on LAN/loopback — are ready in milliseconds, so once the cap
// elapses we proceed with whatever was gathered. On a real cross-NAT link this
// still normally captures the reflexive candidate within the window.
function iceGatheringComplete(pc: RTCPeerConnection, maxWaitMs = 1200): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      pc.removeEventListener('icegatheringstatechange', check)
      clearTimeout(timer)
      resolve()
    }
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    pc.addEventListener('icegatheringstatechange', check)
    const timer = setTimeout(finish, maxWaitMs)
  })
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
  ])
}

// base64 <-> bytes, the matching codec for Go's []byte JSON encoding. The
// byte-level pair is binary-safe; the string pair layers UTF-8 on top for the
// JSON API. Media uses the byte pair so it never passes through a string.
function b64encodeBytes(bytes: Uint8Array): string {
  let bin = ''
  // chunk to stay clear of the arg-count limit on String.fromCharCode(...spread)
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  }
  return btoa(bin)
}
function b64decodeBytes(s: string): Uint8Array {
  const bin = atob(s)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
// base64 → bytes for keys/signatures (alias of the chunk codec, named for intent)
const b64ToBytes = b64decodeBytes

// Pull the first DTLS fingerprint (`a=fingerprint:<hash> <hex:hex:…>`) out of an
// SDP. Mirrors the Keep's parser so both ends sign/verify the exact same string.
function dtlsFingerprint(sdp: string): string {
  for (const raw of sdp.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('a=fingerprint:')) {
      return line.slice('a=fingerprint:'.length).trim()
    }
  }
  return ''
}
function b64decode(s: string): string {
  return new TextDecoder().decode(b64decodeBytes(s))
}
