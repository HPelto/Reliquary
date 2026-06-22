import { create } from 'zustand'
import type { Instance, Server } from '@/data/mock'
import { loadIdentity, saveIdentity, type Identity } from '@/lib/identity'
import { loadProfile, saveProfile, type Profile } from '@/lib/profile'
import type { KeepMessage, KeepStatus, KeepUser, KeepWorld } from '@/net/keep'
import {
  startVoice,
  stopVoice,
  voiceSetState,
  type VoiceParticipant,
  type VoiceStatus
} from '@/net/voice'
import { pushPresenceEverywhere } from '@/net/session'
import type { KeepPresence } from '@/net/keep'
import { getPresencePref, setPresencePref, type PresencePref } from '@/lib/presence'

let presenceTimer: ReturnType<typeof setTimeout> | null = null

/** Read the stored status, resolving an elapsed timer back to Online. */
function initialPresence(): PresencePref {
  const p = getPresencePref()
  if (p.until > 0 && Date.now() > p.until) {
    const reset: PresencePref = { state: 'online', until: 0 }
    setPresencePref(reset)
    return reset
  }
  return p
}

/** Auto-update lifecycle, driven by main-process electron-updater events. */
export interface UpdateState {
  status:
    | 'idle'
    | 'checking-for-update'
    | 'update-available'
    | 'update-not-available'
    | 'download-progress'
    | 'update-downloaded'
    | 'error'
  version?: string
  percent?: number
  message?: string
}

export interface KeepState {
  status: KeepStatus
  world: KeepWorld | null
  /** our own profile on this keep — carries the role that gates management UI */
  self: KeepUser | null
  ping: number
  /** channelId → loaded history + live appends. undefined = not loaded yet. */
  messages: Record<number, KeepMessage[] | undefined>
}

const emptyKeep: KeepState = { status: 'idle', world: null, self: null, ping: 0, messages: {} }

interface UiState {
  activeServerId: string
  activeChannelId: string
  collapsed: Record<string, boolean>
  update: UpdateState
  setUpdate: (u: Partial<UpdateState>) => void
  /** the local user's chosen status + auto-revert time */
  presence: PresencePref
  setPresenceState: (state: KeepPresence, durationMs: number) => void
  initPresence: () => void
  voiceChannelId: string | null
  /** which Keep the active voice call is on (sockets/PeerConnection live in net/voice) */
  voiceInstanceId: string | null
  voiceStatus: VoiceStatus
  voicePing: number
  /** `${instanceId}:${channelId}` → who's in that voice channel (from the SFU) */
  voiceParticipants: Record<string, VoiceParticipant[]>
  /** user ids currently detected speaking in the call we're in (local analysis) */
  voiceSpeaking: number[]
  muted: boolean
  deafened: boolean
  membersOpen: boolean
  paletteOpen: boolean
  addServerOpen: boolean
  serverSettingsOpen: boolean
  openServerSettings: () => void
  closeServerSettings: () => void
  inviteOpen: boolean
  openInvite: () => void
  closeInvite: () => void
  notifOpen: boolean
  openNotif: () => void
  closeNotif: () => void
  createEventOpen: boolean
  openCreateEvent: () => void
  closeCreateEvent: () => void
  eventsOpen: boolean
  openEvents: () => void
  closeEvents: () => void
  settingsOpen: boolean
  openSettings: () => void
  closeSettings: () => void
  profile: Profile
  setProfile: (profile: Profile) => void
  /** open a member's profile card by keep user id (null = closed) */
  viewedUserId: number | null
  viewUser: (id: number | null) => void
  extraInstances: Instance[]
  extraServers: Server[]
  identity: Identity | null
  /** base64 PKCS#8 private key — memory only, never persisted. */
  unlockedKey: string | null
  /** live Keep connection state, keyed by instanceId (sockets live in net/bind) */
  connections: Record<string, KeepState>
  setIdentity: (identity: Identity) => void
  unlock: (privKey: string) => void
  completeOnboarding: (identity: Identity, privKey: string) => void
  setKeep: (instanceId: string, partial: Partial<KeepState>) => void
  appendKeepMessage: (instanceId: string, msg: KeepMessage) => void
  setKeepMessages: (instanceId: string, channelId: number, msgs: KeepMessage[]) => void
  updateMessage: (instanceId: string, msg: KeepMessage) => void
  removeMessage: (instanceId: string, channelId: number, id: number) => void
  renameServer: (serverId: string, name: string) => void
  openPalette: () => void
  closePalette: () => void
  togglePalette: () => void
  openAddServer: () => void
  closeAddServer: () => void
  joinWorld: (instance: Instance, server: Server) => void
  addWorld: (instance: Instance, server: Server, activate: boolean) => void
  removeServer: (serverId: string, instanceId: string) => void
  setServer: (id: string) => void
  setChannel: (id: string) => void
  toggleCategory: (id: string) => void
  toggleMute: () => void
  toggleDeafen: () => void
  toggleMembers: () => void
  disconnectVoice: () => void
  joinVoice: (id: string) => void
  setVoiceStatus: (status: VoiceStatus, ping?: number) => void
  setVoiceSpeaking: (userIds: number[]) => void
  applyVoiceState: (instanceId: string, channelId: number, participants: VoiceParticipant[]) => void
}

export const useUi = create<UiState>((set) => ({
  activeServerId: '',
  activeChannelId: '',
  collapsed: {},
  update: { status: 'idle' },
  setUpdate: (u) => set((s) => ({ update: { ...s.update, ...u } })),
  presence: initialPresence(),
  setPresenceState: (state, durationMs) => {
    const until = durationMs > 0 ? Date.now() + durationMs : 0
    const pref: PresencePref = { state, until }
    setPresencePref(pref)
    if (presenceTimer) {
      clearTimeout(presenceTimer)
      presenceTimer = null
    }
    if (until > 0) {
      presenceTimer = setTimeout(
        () => useUi.getState().setPresenceState('online', 0),
        Math.max(0, until - Date.now())
      )
    }
    set({ presence: pref })
    pushPresenceEverywhere(state)
  },
  initPresence: () => {
    const { state, until } = useUi.getState().presence
    if (presenceTimer) clearTimeout(presenceTimer)
    presenceTimer =
      until > 0
        ? setTimeout(() => useUi.getState().setPresenceState('online', 0), Math.max(0, until - Date.now()))
        : null
    pushPresenceEverywhere(state)
  },
  voiceChannelId: null,
  voiceInstanceId: null,
  voiceStatus: 'idle',
  voicePing: 0,
  voiceParticipants: {},
  voiceSpeaking: [],
  muted: false,
  deafened: false,
  membersOpen: true,
  paletteOpen: false,
  addServerOpen: false,
  serverSettingsOpen: false,
  openServerSettings: () => set({ serverSettingsOpen: true }),
  closeServerSettings: () => set({ serverSettingsOpen: false }),
  inviteOpen: false,
  openInvite: () => set({ inviteOpen: true }),
  closeInvite: () => set({ inviteOpen: false }),
  notifOpen: false,
  openNotif: () => set({ notifOpen: true }),
  closeNotif: () => set({ notifOpen: false }),
  createEventOpen: false,
  openCreateEvent: () => set({ createEventOpen: true }),
  closeCreateEvent: () => set({ createEventOpen: false }),
  eventsOpen: false,
  openEvents: () => set({ eventsOpen: true }),
  closeEvents: () => set({ eventsOpen: false }),
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  profile: loadProfile(),
  setProfile: (profile) => {
    saveProfile(profile)
    set({ profile })
  },
  viewedUserId: null,
  viewUser: (id) => set({ viewedUserId: id }),
  extraInstances: [],
  extraServers: [],
  identity: loadIdentity(),
  unlockedKey: null,
  connections: {},
  setIdentity: (identity) => {
    // identity is always durable — persist every update (name, accent, password)
    saveIdentity(identity)
    set({ identity })
  },
  unlock: (privKey) => set({ unlockedKey: privKey }),
  completeOnboarding: (identity, privKey) => {
    saveIdentity(identity)
    set({ identity, unlockedKey: privKey })
  },
  setKeep: (instanceId, partial) =>
    set((s) => ({
      connections: {
        ...s.connections,
        [instanceId]: { ...emptyKeep, ...s.connections[instanceId], ...partial }
      }
    })),
  appendKeepMessage: (instanceId, msg) =>
    set((s) => {
      const keep = s.connections[instanceId] ?? emptyKeep
      const existing = keep.messages[msg.channel_id]
      // history not loaded yet → the eventual loadMessages will include it
      if (!existing) return {}
      if (existing.some((m) => m.id === msg.id)) return {}
      return {
        connections: {
          ...s.connections,
          [instanceId]: {
            ...keep,
            messages: { ...keep.messages, [msg.channel_id]: [...existing, msg] }
          }
        }
      }
    }),
  setKeepMessages: (instanceId, channelId, msgs) =>
    set((s) => {
      const keep = s.connections[instanceId] ?? emptyKeep
      return {
        connections: {
          ...s.connections,
          [instanceId]: { ...keep, messages: { ...keep.messages, [channelId]: msgs } }
        }
      }
    }),
  updateMessage: (instanceId, msg) =>
    set((s) => {
      const keep = s.connections[instanceId] ?? emptyKeep
      const existing = keep.messages[msg.channel_id]
      if (!existing) return {}
      return {
        connections: {
          ...s.connections,
          [instanceId]: {
            ...keep,
            messages: {
              ...keep.messages,
              [msg.channel_id]: existing.map((m) => (m.id === msg.id ? msg : m))
            }
          }
        }
      }
    }),
  removeMessage: (instanceId, channelId, id) =>
    set((s) => {
      const keep = s.connections[instanceId] ?? emptyKeep
      const existing = keep.messages[channelId]
      if (!existing) return {}
      return {
        connections: {
          ...s.connections,
          [instanceId]: {
            ...keep,
            messages: { ...keep.messages, [channelId]: existing.filter((m) => m.id !== id) }
          }
        }
      }
    }),
  renameServer: (serverId, name) =>
    set((s) => ({
      extraServers: s.extraServers.map((sv) => (sv.id === serverId ? { ...sv, name } : sv))
    })),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  openAddServer: () => set({ addServerOpen: true }),
  closeAddServer: () => set({ addServerOpen: false }),
  joinWorld: (instance, server) => useUi.getState().addWorld(instance, server, true),
  addWorld: (instance, server, activate) =>
    set((s) => {
      const alreadyJoined = s.extraServers.some((x) => x.id === server.id)
      return {
        extraInstances: s.extraInstances.some((x) => x.id === instance.id)
          ? s.extraInstances
          : [...s.extraInstances, instance],
        extraServers: alreadyJoined ? s.extraServers : [...s.extraServers, server],
        ...(activate ? { activeServerId: server.id, addServerOpen: false } : {})
      }
    }),
  removeServer: (serverId, instanceId) =>
    set((s) => {
      const connections = { ...s.connections }
      delete connections[instanceId]
      return {
        extraServers: s.extraServers.filter((x) => x.id !== serverId),
        extraInstances: s.extraInstances.filter((x) => x.id !== instanceId),
        connections,
        ...(s.activeServerId === serverId ? { activeServerId: '', activeChannelId: '' } : {})
      }
    }),
  setServer: (id) => set({ activeServerId: id }),
  setChannel: (id) => set({ activeChannelId: id }),
  toggleCategory: (id) => set((s) => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),
  toggleMute: () =>
    set((s) => {
      const muted = !s.muted
      // unmuting also lifts deafen — you can't be deafened with a live mic
      const deafened = muted ? s.deafened : false
      voiceSetState(muted, deafened)
      return { muted, deafened }
    }),
  toggleDeafen: () =>
    set((s) => {
      const deafened = !s.deafened
      const muted = deafened // deafen forces mute; undeafen unmutes
      voiceSetState(muted, deafened)
      return { deafened, muted }
    }),
  toggleMembers: () => set((s) => ({ membersOpen: !s.membersOpen })),
  disconnectVoice: () => {
    stopVoice()
    set({ voiceChannelId: null, voiceInstanceId: null, voiceStatus: 'idle', voicePing: 0, voiceSpeaking: [] })
  },
  joinVoice: (id) => {
    const s = useUi.getState()
    const server = s.extraServers.find((sv) => sv.id === s.activeServerId)
    if (!server) return
    // clicking the channel you're already in does nothing
    if (s.voiceChannelId === id && s.voiceInstanceId === server.instanceId) return
    set({
      voiceChannelId: id,
      voiceInstanceId: server.instanceId,
      voiceStatus: 'connecting',
      muted: false,
      deafened: false,
      voiceSpeaking: []
    })
    void startVoice(server.instanceId, Number(id))
  },
  setVoiceStatus: (status, ping) =>
    set(ping === undefined ? { voiceStatus: status } : { voiceStatus: status, voicePing: ping }),
  setVoiceSpeaking: (userIds) => set({ voiceSpeaking: userIds }),
  applyVoiceState: (instanceId, channelId, participants) =>
    set((s) => {
      const key = `${instanceId}:${channelId}`
      const voiceParticipants = { ...s.voiceParticipants }
      if (participants.length === 0) delete voiceParticipants[key]
      else voiceParticipants[key] = participants
      return { voiceParticipants }
    })
}))

/** Every joined Keep, with online flags driven by real connection status. */
export function useWorld(): { instances: Instance[]; servers: Server[] } {
  const extraInstances = useUi((s) => s.extraInstances)
  const extraServers = useUi((s) => s.extraServers)
  const connections = useUi((s) => s.connections)
  return {
    instances: extraInstances.map((i) => ({
      ...i,
      online: connections[i.id]?.status !== 'offline'
    })),
    servers: extraServers
  }
}
