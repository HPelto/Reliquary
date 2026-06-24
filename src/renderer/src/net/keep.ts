/**
 * KeepConnection — one live connection to one self-hosted Keep.
 *
 * Pure protocol client: fetch + WebSocket + the identity handshake, no UI
 * imports. The store layer subscribes via the events object, which also
 * makes this class testable headlessly in Node.
 */

// relative imports so this module also runs under plain Node for headless tests
import { signNonce } from '../lib/identity'
import { mediaRefToBytes, type PendingAttachment, type Profile } from '../lib/profile'
import { RtcTransport, type GatewayEvent, type RtcResponse, type RtcBytesResponse } from './rtc'

/** Which wire a connection rides: classic HTTP+WebSocket, or the encrypted P2P
 *  WebRTC data channel (signaling still over HTTP). */
export type KeepTransport = 'http' | 'rtc'

export interface KeepChannel {
  id: number
  name: string
  kind: 'text' | 'voice'
  position: number
}

export interface KeepUser {
  id: number
  pubkey: string
  fingerprint: string
  username: string
  accent: string
  role: string
  about: string
  status: string
  avatar: string // media hash, or "" for the generated default
  background: string // media hash for the profile banner
  name_font: string
  name_effect: string
  name_color: string
}

/** What a user can set for themselves. */
export type KeepPresence = 'online' | 'idle' | 'dnd' | 'invisible'
/** What other members see (invisible is never exposed — it reads as offline). */
export type MemberState = 'online' | 'idle' | 'dnd' | 'offline'

export interface KeepMember extends KeepUser {
  online: boolean
  state?: MemberState
}

export interface Attachment {
  hash: string
  name: string
  content_type: string
  width: number
  height: number
  size: number
}

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file'

export function attachmentKind(a: Attachment): AttachmentKind {
  const t = a.content_type || ''
  if (t.startsWith('image/')) return 'image'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  return 'file'
}

export interface ReplyPreview {
  id: number
  author_id: number
  author_username: string
  content: string
  has_attachments: boolean
}

export interface KeepMessage {
  id: number
  channel_id: number
  author: KeepUser
  content: string
  attachments?: Attachment[]
  reply_to?: number // referenced message id, 0/undefined = not a reply
  reply_preview?: ReplyPreview // null/undefined if the original was deleted
  pinned?: boolean
  created_at: number
  edited_at?: number // unix ms, 0/undefined = never edited
}

export interface KeepEvent {
  id: number
  title: string
  description: string
  location_kind: 'voice' | 'other'
  channel_id: number
  location_text: string
  cover: string // media hash or ""
  starts_at: number // unix ms
  ends_at: number // unix ms, 0 = open-ended
  frequency: string
  created_by: number
  created_at: number
}

export interface VoiceChannelState {
  channel_id: number
  participants: { user_id: number; muted: boolean; deafened: boolean }[]
}

export interface KeepWorld {
  name: string
  version: string
  channels: KeepChannel[]
  members: KeepMember[]
  events?: KeepEvent[]
  lock_name_style?: boolean
  require_invite?: boolean
  max_upload_mb?: number
  /** current voice occupancy, so occupants show before you join */
  voice_states?: VoiceChannelState[]
}

export interface KeepDiscovery {
  name: string
  protocol: string
  version: string
}

export type KeepStatus = 'idle' | 'discovering' | 'handshaking' | 'syncing' | 'online' | 'offline'

export interface KeepEvents {
  onStatus?: (status: KeepStatus) => void
  onWorld?: (world: KeepWorld) => void
  onMessage?: (msg: KeepMessage) => void
  onMessageUpdate?: (msg: KeepMessage) => void
  onMessageDelete?: (channelId: number, id: number) => void
  onPresence?: (userId: number, online: boolean, state: MemberState) => void
  onMemberJoin?: (user: KeepUser) => void
  onMemberUpdate?: (user: KeepUser) => void
  /** Raw VOICE_* signaling frames, handled by the voice session. */
  onVoice?: (t: string, d: unknown) => void
}

export interface HandshakeIdentity {
  pub: string
  name: string
  accent: string
}

/** The full set of client-supplied profile fields sent in a handshake/patch. */
export interface ProfilePayload {
  username: string
  accent: string
  about: string
  status: string
  avatar: string // media hash or ""
  background: string // media hash or ""
  name_font: string
  name_effect: string
  name_color: string
}

/** Build the wire payload from an identity + local Profile, without media bytes. */
export function profilePayload(identity: HandshakeIdentity, profile?: Profile): ProfilePayload {
  return {
    username: identity.name,
    accent: identity.accent,
    about: profile?.about ?? '',
    status: profile?.status ?? '',
    avatar: profile?.avatar?.hash ?? '',
    background: profile?.background?.hash ?? '',
    name_font: profile?.nameFont ?? '',
    name_effect: profile?.nameEffect ?? '',
    name_color: profile?.nameColor ?? ''
  }
}

export interface KeepInvite {
  token: string
  expires_at: number
  max_uses: number
  uses: number
}

export class KeepError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message)
  }
}

const RECONNECT_BASE_MS = 3_000
const RECONNECT_MAX_MS = 30_000

export class KeepConnection {
  readonly host: string
  readonly port: number
  readonly baseUrl: string
  readonly wsUrl: string

  token: string | null = null
  self: KeepUser | null = null
  world: KeepWorld | null = null
  ping = 0
  /** the Keep's identity pubkey (base64): the pin we were given (invite/saved),
   *  refreshed from discovery. Used to mint invites that pin future joiners. */
  keepKey: string | null = null
  /** the local user's chosen presence; re-asserted to the Keep on each connect */
  presence: KeepPresence = 'online'

  /** The transport this connection rides. 'rtc' tunnels the whole API + gateway
   *  over an encrypted WebRTC data channel; only signaling touches HTTP. */
  readonly transport: KeepTransport

  private events: KeepEvents
  private ws: WebSocket | null = null
  private rtc: RtcTransport | null = null
  // rtc mode: hash → blob: URL, so media fetched over the channel renders in
  // <img>/<video>/<audio> and is fetched at most once. Revoked on close().
  private mediaBlobs = new Map<string, string>()
  private closed = false
  private reconnectMs = RECONNECT_BASE_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    target: {
      host: string
      port: number
      secure?: boolean
      transport?: KeepTransport
      keepKey?: string
    },
    events: KeepEvents = {}
  ) {
    this.host = target.host
    this.port = target.port
    this.keepKey = target.keepKey ?? null
    // Explicit https/wss scheme wins; otherwise fall back to the legacy
    // port-443 inference so existing saved Keeps keep working unchanged.
    const secure = target.secure ?? target.port === 443
    const portPart = secure || target.port === 80 ? '' : `:${target.port}`
    this.baseUrl = `${secure ? 'https' : 'http'}://${target.host}${portPart}`
    this.wsUrl = `${secure ? 'wss' : 'ws'}://${target.host}${portPart}`
    this.events = events
    this.transport = target.transport ?? 'http'
    if (this.transport === 'rtc') {
      // signaling rides HTTP (POST /v1/rtc/connect); the API + gateway flow P2P.
      // Pass the known Keep pubkey so the transport can pin against a MITM.
      this.rtc = new RtcTransport(`${this.baseUrl}/v1/rtc/connect`, this.keepKey ?? undefined)
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (this.rtc) return this.requestRtc<T>(path, init)
    let res: Response
    try {
      res = await fetch(this.baseUrl + path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(init?.headers ?? {})
        }
      })
    } catch {
      throw new KeepError(`No Keep answered at ${this.host} — is it running and reachable?`)
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      throw new KeepError(
        String(body.error ?? `server returned ${res.status}`),
        res.status,
        typeof body.code === 'string' ? body.code : undefined
      )
    }
    return body as T
  }

  // The RTC twin of request(): the same path/method/body/headers, but tunneled
  // over the data channel instead of fetch. It mirrors request()'s JSON + error
  // contract exactly, so every caller is transport-agnostic.
  private async requestRtc<T>(path: string, init?: RequestInit): Promise<T> {
    const method = String(init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...((init?.headers as Record<string, string>) ?? {})
    }
    let resp: RtcResponse
    try {
      resp = await this.rtc!.request(method, path, {
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined
      })
    } catch {
      throw new KeepError(`No Keep answered at ${this.host} — is it running and reachable?`)
    }
    let body: Record<string, unknown> = {}
    try {
      if (resp.text) body = JSON.parse(resp.text) as Record<string, unknown>
    } catch {
      /* non-JSON body — treat as empty, status drives the outcome */
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new KeepError(
        String(body.error ?? `server returned ${resp.status}`),
        resp.status,
        typeof body.code === 'string' ? body.code : undefined
      )
    }
    return body as T
  }

  /** Step 1 — resolve the instance and measure ping. */
  async discover(): Promise<KeepDiscovery> {
    this.events.onStatus?.('discovering')
    // Establish the peer link first so the measured ping is the data-channel
    // round trip, not the one-time ICE/handshake setup.
    if (this.rtc) await this.rtc.connect()
    const started = performance.now()
    const d = await this.request<{
      instance: { name: string }
      protocol: string
      version: string
      keep_key?: string
    }>('/.well-known/reliquary')
    this.ping = Math.max(1, Math.round(performance.now() - started))
    if (d.protocol !== 'relic.v1') {
      throw new KeepError(`This server speaks "${d.protocol}", not relic.v1 — update one side.`)
    }
    // learn the Keep's identity pubkey so invites we mint can pin future joiners
    if (d.keep_key) this.keepKey = d.keep_key
    return { name: d.instance.name, protocol: d.protocol, version: d.version }
  }

  /** Step 2 — prove key ownership; the Keep generates/refreshes our profile.
   *  keepPassword is the optional server-wide gate the host can enable. */
  async handshake(
    identity: HandshakeIdentity,
    privKey: string,
    opts: { invite?: string; keepPassword?: string; profile?: Profile } = {}
  ): Promise<KeepUser> {
    this.events.onStatus?.('handshaking')
    const { nonce } = await this.request<{ nonce: string }>('/v1/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ pubkey: identity.pub })
    })
    const signature = await signNonce(privKey, nonce)
    const res = await this.request<{ token: string; user: KeepUser }>('/v1/auth/handshake', {
      method: 'POST',
      body: JSON.stringify({
        pubkey: identity.pub,
        nonce,
        signature,
        profile: profilePayload(identity, opts.profile),
        invite: opts.invite ?? '',
        keep_password: opts.keepPassword ?? ''
      })
    })
    this.token = res.token
    this.self = res.user
    return res.user
  }

  // ── profile & media ────────────────────────────────────────────────

  /** Absolute URL for an <img>/<video>/<audio> — public, immutable, content-addressed.
   *  HTTP transport only; in rtc mode the HTTP port may be unreachable — use
   *  mediaSrc() instead, which fetches the bytes over the channel. */
  mediaUrl(hash: string): string {
    return hash ? `${this.baseUrl}/v1/media/${hash}` : ''
  }

  /** Same bytes, but forces a download with the original filename. */
  mediaDownloadUrl(hash: string, name: string): string {
    return hash ? `${this.baseUrl}/v1/media/${hash}?download=${encodeURIComponent(name)}` : ''
  }

  /**
   * A displayable URL for a media hash, transport-aware:
   *  - HTTP: the direct content-addressed URL (the browser fetches it itself).
   *  - RTC : fetch the bytes over the channel once, wrap them in a Blob, and
   *    return a cached `blob:` URL. The blob is fully in memory, so <video>
   *    seeking works without server Range support. Revoked on close().
   * NOTE: media GET is a public route, so no auth header is needed.
   */
  async mediaSrc(hash: string): Promise<string> {
    if (!hash) return ''
    if (!this.rtc) return this.mediaUrl(hash)
    const cached = this.mediaBlobs.get(hash)
    if (cached) return cached
    let resp: RtcBytesResponse
    try {
      resp = await this.rtc.requestBytes('GET', `/v1/media/${hash}`)
    } catch {
      throw new KeepError(`couldn't fetch media ${hash} over the channel`)
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new KeepError(`media ${hash} unavailable (${resp.status})`, resp.status)
    }
    const type = resp.headers['Content-Type'] || 'application/octet-stream'
    // copy into a fresh ArrayBuffer-backed view so Blob accepts it (TS's strict
    // Uint8Array<ArrayBufferLike> isn't a BlobPart; the copy is cheap + safe)
    const url = URL.createObjectURL(new Blob([new Uint8Array(resp.bytes)], { type }))
    // a concurrent fetch may have populated the cache while we awaited — reuse
    // the winner and revoke our duplicate so there's one blob per hash.
    const won = this.mediaBlobs.get(hash)
    if (won) {
      URL.revokeObjectURL(url)
      return won
    }
    this.mediaBlobs.set(hash, url)
    return url
  }

  async mediaExists(hash: string): Promise<boolean> {
    if (!hash) return true
    const res = await this.request<{ exists: boolean }>(`/v1/media/${hash}/exists`)
    return res.exists
  }

  /** Upload media bytes (raw, not JSON). Idempotent — content-addressed. */
  async uploadMedia(ref: { hash: string; type: string; dataUrl: string }): Promise<void> {
    if (this.rtc) {
      await this.putMediaBytes(ref.hash, ref.type, mediaRefToBytes(ref))
      return
    }
    const res = await fetch(`${this.baseUrl}/v1/media/${ref.hash}`, {
      method: 'PUT',
      headers: {
        'Content-Type': ref.type,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: mediaRefToBytes(ref) as BodyInit
    })
    if (!res.ok && res.status !== 409) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new KeepError(body.error ?? `media upload failed (${res.status})`, res.status)
    }
  }

  /** Ensure this Keep has the bytes for each media ref the profile references. */
  async ensureMedia(profile?: Profile): Promise<void> {
    for (const ref of [profile?.avatar, profile?.background]) {
      if (ref && !(await this.mediaExists(ref.hash))) await this.uploadMedia(ref)
    }
  }

  /** Push a profile edit live to this Keep (no reconnect). */
  async patchProfile(payload: ProfilePayload): Promise<KeepUser> {
    const res = await this.request<{ user: KeepUser }>('/v1/profile', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    })
    if (this.self) this.self = res.user
    return res.user
  }

  // ── community management (owner/admin bearer) ──────────────────────

  async setName(name: string): Promise<void> {
    await this.request('/v1/admin/settings', { method: 'PATCH', body: JSON.stringify({ name }) })
  }

  async createChannel(name: string, kind: 'text' | 'voice'): Promise<KeepChannel> {
    return this.request('/v1/admin/channels', { method: 'POST', body: JSON.stringify({ name, kind }) })
  }

  async renameChannel(id: number, name: string): Promise<void> {
    await this.request(`/v1/admin/channels/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
  }

  async deleteChannel(id: number): Promise<void> {
    await this.request(`/v1/admin/channels/${id}`, { method: 'DELETE' })
  }

  async listInvites(): Promise<KeepInvite[]> {
    const res = await this.request<{ invites: KeepInvite[] }>('/v1/admin/invites')
    return res.invites
  }

  async revokeInvite(token: string): Promise<void> {
    await this.request(`/v1/admin/invites/${token}`, { method: 'DELETE' })
  }

  /** Owner/admin: lock username styling so names render in role colors. */
  async setNameLock(locked: boolean): Promise<void> {
    await this.request('/v1/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({ lock_name_style: locked })
    })
  }

  /** Owner/admin: require a valid invite to join (vs. keep-password-only). */
  async setRequireInvite(required: boolean): Promise<void> {
    await this.request('/v1/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({ require_invite: required })
    })
  }

  /** Owner/admin: the Keep's reachable LAN IPv4 addresses + listen port, so
   *  minted invites can carry an address other machines can actually dial. */
  async netAddresses(): Promise<{ candidates: string[]; port: number }> {
    return this.request('/v1/admin/net-addresses')
  }

  // ── events ─────────────────────────────────────────────────────────

  async listEvents(): Promise<KeepEvent[]> {
    const res = await this.request<{ events: KeepEvent[] }>('/v1/events')
    return res.events
  }

  async createEvent(e: {
    title: string
    description: string
    location_kind: 'voice' | 'other'
    channel_id: number
    location_text: string
    cover: string
    starts_at: number
    ends_at: number
    frequency: string
  }): Promise<KeepEvent> {
    return this.request('/v1/events', { method: 'POST', body: JSON.stringify(e) })
  }

  async deleteEvent(id: number): Promise<void> {
    await this.request(`/v1/events/${id}`, { method: 'DELETE' })
  }

  /** Step 3 — pull the world snapshot. Deliberately does NOT touch the
   *  status: it doubles as a background resync while happily online. */
  async fetchWorld(): Promise<KeepWorld> {
    const world = await this.request<KeepWorld>('/v1/world')
    this.world = world
    this.events.onWorld?.(world)
    return world
  }

  async loadMessages(channelId: number, before?: number): Promise<KeepMessage[]> {
    const q = before ? `?limit=50&before=${before}` : '?limit=50'
    const res = await this.request<{ messages: KeepMessage[] }>(
      `/v1/channels/${channelId}/messages${q}`
    )
    return res.messages
  }

  /** The sent message comes back via the gateway broadcast — don't double-append. */
  async sendMessage(
    channelId: number,
    content: string,
    attachments?: Attachment[],
    replyTo?: number
  ): Promise<KeepMessage> {
    return this.request<KeepMessage>(`/v1/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, attachments: attachments ?? [], reply_to: replyTo ?? 0 })
    })
  }

  /** Pin/unpin a message (owner/admin). Echoes via the MESSAGE_UPDATE broadcast. */
  async pinMessage(channelId: number, id: number, pinned: boolean): Promise<void> {
    await this.request(`/v1/channels/${channelId}/messages/${id}/pin`, {
      method: pinned ? 'POST' : 'DELETE'
    })
  }

  /** Fetch a channel's pinned messages (newest first). */
  async loadPins(channelId: number): Promise<KeepMessage[]> {
    const res = await this.request<{ messages: KeepMessage[] }>(`/v1/channels/${channelId}/pins`)
    return res.messages
  }

  /** Edit own message. Update echoes back via the MESSAGE_UPDATE broadcast. */
  async editMessage(channelId: number, id: number, content: string): Promise<KeepMessage> {
    return this.request<KeepMessage>(`/v1/channels/${channelId}/messages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content })
    })
  }

  /** Delete a message (own, or any if owner/admin). Echoes via MESSAGE_DELETE. */
  async deleteMessage(channelId: number, id: number): Promise<void> {
    await this.request(`/v1/channels/${channelId}/messages/${id}`, { method: 'DELETE' })
  }

  /** Ensure a picked file's bytes are on this Keep (streamed, any type), then
   *  return its wire metadata. `onProgress` reports bytes uploaded for this file
   *  so the UI can show a progress bar on large files. */
  async uploadAttachment(
    p: PendingAttachment,
    onProgress?: (loaded: number) => void
  ): Promise<Attachment> {
    if (await this.mediaExists(p.hash)) {
      onProgress?.(p.size) // already on the Keep — nothing to upload
    } else {
      await this.putMediaWithProgress(p.hash, p.contentType, p.file, onProgress)
    }
    return {
      hash: p.hash,
      name: p.name,
      content_type: p.contentType,
      width: p.width,
      height: p.height,
      size: p.size
    }
  }

  /** PUT raw bytes with upload-progress events (fetch can't report these). Over
   *  rtc there are no native upload-progress events, so progress is reported once
   *  the channel transfer completes (coarse but correct). */
  private async putMediaWithProgress(
    hash: string,
    contentType: string,
    file: Blob,
    onProgress?: (loaded: number) => void
  ): Promise<void> {
    if (this.rtc) {
      await this.putMediaBytes(hash, contentType, new Uint8Array(await file.arrayBuffer()))
      onProgress?.(file.size)
      return
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `${this.baseUrl}/v1/media/${hash}`)
      xhr.setRequestHeader('Content-Type', contentType)
      if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`)
      xhr.upload.onprogress = (e): void => {
        if (e.lengthComputable) onProgress?.(e.loaded)
      }
      xhr.onload = (): void => {
        if (xhr.status < 300 || xhr.status === 409) {
          onProgress?.(file.size)
          resolve()
        } else {
          let msg = `upload failed (${xhr.status})`
          try {
            msg = (JSON.parse(xhr.responseText) as { error?: string }).error ?? msg
          } catch {
            /* non-JSON error body */
          }
          reject(new KeepError(msg, xhr.status))
        }
      }
      xhr.onerror = (): void => reject(new KeepError('upload failed — network error'))
      xhr.send(file)
    })
  }

  /** PUT media bytes over the rtc channel (binary-safe). 409 = already present
   *  (content-addressed), which is success. Shared by uploadMedia +
   *  putMediaWithProgress when in rtc mode. */
  private async putMediaBytes(hash: string, contentType: string, bytes: Uint8Array): Promise<void> {
    const resp = await this.rtc!.requestBytes('PUT', `/v1/media/${hash}`, {
      headers: {
        'Content-Type': contentType,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: bytes
    })
    if (resp.status >= 300 && resp.status !== 409) {
      let msg = `media upload failed (${resp.status})`
      try {
        msg = (JSON.parse(new TextDecoder().decode(resp.bytes)) as { error?: string }).error ?? msg
      } catch {
        /* non-JSON error body */
      }
      throw new KeepError(msg, resp.status)
    }
  }

  /** Owner only. ttlSeconds: 0 = server default (7d), -1 = never expires. */
  async createInvite(
    ttlSeconds = 0,
    maxUses = 0
  ): Promise<{ token: string; expires_at: number; max_uses: number }> {
    return this.request(`/v1/invites`, {
      method: 'POST',
      body: JSON.stringify({ ttl_seconds: ttlSeconds, max_uses: maxUses })
    })
  }

  /** Step 4 — live events, with automatic reconnect + resync. */
  openGateway(): void {
    if (this.closed || !this.token) return
    if (this.rtc) {
      this.openGatewayRtc()
      return
    }
    const ws = new WebSocket(`${this.wsUrl}/v1/gateway?token=${this.token}`)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectMs = RECONNECT_BASE_MS
      this.events.onStatus?.('online')
      // re-assert our chosen presence (server defaults a fresh connection to online)
      if (this.presence !== 'online') this.sendGateway('PRESENCE_SET', { state: this.presence })
      // catch up on anything missed while disconnected (status stays online)
      void this.fetchWorld().catch(() => {})
    }

    ws.onmessage = (e) => {
      let ev: { t: string; d: unknown }
      try {
        ev = JSON.parse(String(e.data))
      } catch {
        return
      }
      this.dispatch(ev)
    }

    ws.onclose = () => {
      if (this.closed) return
      this.events.onStatus?.('offline')
      this.reconnectTimer = setTimeout(() => this.openGateway(), this.reconnectMs)
      this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS)
    }
  }

  // Gateway over the RTC data channel: subscribe, then route each push through
  // the same dispatch the WebSocket path uses. The opening HELLO stands in for
  // ws.onopen; a dropped peer connection (or a failed initial connect) schedules
  // a reconnect, matching the WebSocket backoff.
  private openGatewayRtc(): void {
    const token = this.token
    if (!token || !this.rtc) return
    this.rtc.onClose = () => {
      if (this.closed) return
      this.events.onStatus?.('offline')
      this.scheduleReconnect()
    }
    void this.rtc
      .subscribeGateway(token, (ev: GatewayEvent) => {
        if (ev.t === 'HELLO') {
          this.reconnectMs = RECONNECT_BASE_MS
          this.events.onStatus?.('online')
          // re-assert our chosen presence (server defaults a fresh sub to online)
          if (this.presence !== 'online') this.sendGateway('PRESENCE_SET', { state: this.presence })
          // catch up on anything missed while disconnected (status stays online)
          void this.fetchWorld().catch(() => {})
          return
        }
        this.dispatch({ t: ev.t, d: ev.d })
      })
      .catch(() => {
        if (this.closed) return
        this.events.onStatus?.('offline')
        this.scheduleReconnect()
      })
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.openGateway(), this.reconnectMs)
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS)
  }

  private dispatch(ev: { t: string; d: unknown }): void {
    switch (ev.t) {
      case 'MESSAGE_CREATE':
        this.events.onMessage?.(ev.d as KeepMessage)
        break
      case 'MESSAGE_UPDATE':
        this.events.onMessageUpdate?.(ev.d as KeepMessage)
        break
      case 'MESSAGE_DELETE': {
        const d = ev.d as { id: number; channel_id: number }
        this.events.onMessageDelete?.(d.channel_id, d.id)
        break
      }
      case 'PRESENCE_UPDATE': {
        const d = ev.d as { user_id: number; online: boolean; state?: MemberState }
        const state = d.state ?? (d.online ? 'online' : 'offline')
        if (this.world) {
          const m = this.world.members.find((x) => x.id === d.user_id)
          if (m) {
            m.online = d.online
            m.state = state
          }
        }
        this.events.onPresence?.(d.user_id, d.online, state)
        break
      }
      case 'MEMBER_JOIN': {
        const user = (ev.d as { user: KeepUser }).user
        this.mergeMember(user, false)
        this.events.onMemberJoin?.(user)
        break
      }
      case 'MEMBER_UPDATE': {
        const user = (ev.d as { user: KeepUser }).user
        this.mergeMember(user)
        this.events.onMemberUpdate?.(user)
        break
      }
      case 'SERVER_UPDATE':
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'CHANNEL_DELETE':
      case 'EVENT_CREATE':
      case 'EVENT_DELETE':
        // structural changes: simplest correct behavior is a world resync
        void this.fetchWorld().catch(() => {})
        break
      default:
        if (ev.t.startsWith('VOICE_')) this.events.onVoice?.(ev.t, ev.d)
    }
  }

  /** Send a raw envelope up the gateway (voice signaling, presence). Best-effort —
   *  no-op if the connection isn't open. Over RTC it rides the data channel as an
   *  upstream frame (presence sync + voice signaling now work P2P); over the WS
   *  path it's a socket send. */
  sendGateway(t: string, d: unknown): boolean {
    if (this.rtc) return this.rtc.sendUpstream(t, d)
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({ t, d }))
    return true
  }

  /** The P2P transport's peer connection when connected over rtc, else null.
   *  Lets voice ride the same connection (A6b). */
  rtcPeerConnection(): RTCPeerConnection | null {
    return this.rtc?.peerConnection() ?? null
  }

  /** Set the local user's presence on this Keep (broadcast to its members). */
  setPresence(state: KeepPresence): void {
    this.presence = state
    this.sendGateway('PRESENCE_SET', { state })
  }

  /** Keep the connection's own world snapshot authoritative for member edits. */
  private mergeMember(user: KeepUser, keepOnline = true): void {
    if (!this.world) return
    const existing = this.world.members.find((m) => m.id === user.id)
    if (existing) {
      Object.assign(existing, user, { online: keepOnline ? existing.online : true })
    } else {
      this.world.members.push({ ...user, online: true })
    }
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
    this.rtc?.close()
    this.rtc = null
    for (const url of this.mediaBlobs.values()) URL.revokeObjectURL(url)
    this.mediaBlobs.clear()
  }
}
