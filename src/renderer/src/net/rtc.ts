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

const STUN: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
const LABEL = 'relic'

interface WireResponse {
  id: number
  status: number
  headers?: Record<string, string>
  body?: string // base64 — Go encodes []byte as base64 in JSON
}

export interface RtcResponse {
  status: number
  headers: Record<string, string>
  text: string
}

export class RtcTransport {
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private nextId = 1
  private pending = new Map<number, (r: WireResponse) => void>()
  private ready: Promise<void> | null = null

  /** signalUrl is the Keep's POST /v1/rtc/connect endpoint (over HTTP/tunnel). */
  constructor(private readonly signalUrl: string) {}

  /** Establish the peer connection + data channel. Idempotent. */
  connect(): Promise<void> {
    if (!this.ready) this.ready = this.doConnect()
    return this.ready
  }

  private async doConnect(): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: STUN })
    this.pc = pc
    const dc = pc.createDataChannel(LABEL, { ordered: true })
    this.dc = dc

    dc.addEventListener('message', (e) => {
      let resp: WireResponse
      try {
        resp = JSON.parse(e.data as string)
      } catch {
        return
      }
      const fn = this.pending.get(resp.id)
      if (fn) {
        this.pending.delete(resp.id)
        fn(resp)
      }
    })

    const open = new Promise<void>((resolve, reject) => {
      dc.addEventListener('open', () => resolve())
      dc.addEventListener('error', () => reject(new Error('data channel error')))
    })

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await iceGatheringComplete(pc) // non-trickle: one round-trip signaling

    const res = await fetch(this.signalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pc.localDescription)
    })
    if (!res.ok) throw new Error(`signaling failed: ${res.status}`)
    await pc.setRemoteDescription(await res.json())

    await withTimeout(open, 15000, 'data channel never opened (ICE failed?)')
  }

  /** Tunnel one API request over the channel and await its response. */
  async request(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: string }
  ): Promise<RtcResponse> {
    await this.connect()
    if (!this.dc || this.dc.readyState !== 'open') throw new Error('rtc transport not connected')
    const id = this.nextId++
    const frame = {
      id,
      method,
      path,
      headers: opts?.headers,
      body: opts?.body ? b64encode(opts.body) : undefined
    }
    const resp = await new Promise<WireResponse>((resolve, reject) => {
      this.pending.set(id, resolve)
      this.dc!.send(JSON.stringify(frame))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('rtc request timed out'))
      }, 30000)
    })
    return {
      status: resp.status,
      headers: resp.headers ?? {},
      text: resp.body ? b64decode(resp.body) : ''
    }
  }

  close(): void {
    this.dc?.close()
    this.pc?.close()
    this.pc = null
    this.dc = null
    this.ready = null
    this.pending.clear()
  }
}

function iceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', check)
  })
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
  ])
}

// base64 <-> UTF-8 string, the matching codec for Go's []byte JSON encoding.
function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
function b64decode(s: string): string {
  const bin = atob(s)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}
