/**
 * Glue between KeepConnection (pure protocol, owns the sockets) and the
 * zustand store (serializable state the UI renders). Socket objects never
 * enter the store; the registry here owns them per instance.
 */

import { KeepConnection, type KeepMessage, type KeepUser } from './keep'
import { routeVoiceFrame } from './voice'
import { isP2PEnabled } from '@/lib/experiments'
import { resolved } from '@/lib/notifications'
import { playChatNotification } from '@/lib/sound'
import { updateWorld } from '@/lib/worlds'
import { useUi } from '@/store'

const registry = new Map<string, KeepConnection>()

// brief guard so a burst of messages doesn't stack the sound on itself
let lastNotifyAt = 0

/** Play the chat sound for an incoming message, honoring this Keep's notification
 *  level. Skips your own messages and the channel you're actively looking at. */
function notifyMessage(instanceId: string, serverId: string, msg: KeepMessage, selfId?: number): void {
  if (selfId && msg.author.id === selfId) return // my own message echoed back
  const ui0 = useUi.getState()
  // silenced or blocked users never make a sound, regardless of prefs
  if (ui0.silenced[msg.author.pubkey] || ui0.blocked[msg.author.pubkey]) return
  // 'all' plays; 'mentions' and 'nothing' stay quiet (no @mention system yet)
  if (resolved(instanceId, String(msg.channel_id)) !== 'all') return
  const ui = useUi.getState()
  const looking = ui.activeServerId === serverId && ui.activeChannelId === String(msg.channel_id)
  if (looking && document.hasFocus()) return // you can already see it
  const now = Date.now()
  if (now - lastNotifyAt < 400) return
  lastNotifyAt = now
  playChatNotification()
}

export function getKeep(instanceId: string): KeepConnection | undefined {
  return registry.get(instanceId)
}

export function dropKeep(instanceId: string): void {
  registry.get(instanceId)?.close()
  registry.delete(instanceId)
}

export function allKeeps(): KeepConnection[] {
  return [...registry.values()]
}

function upsertMember(instanceId: string, user: KeepUser, online?: boolean): void {
  const { connections, setKeep } = useUi.getState()
  const world = connections[instanceId]?.world
  if (!world) return
  const existing = world.members.find((m) => m.id === user.id)
  const members = existing
    ? world.members.map((m) =>
        m.id === user.id ? { ...m, ...user, online: online ?? m.online } : m
      )
    : [...world.members, { ...user, online: online ?? false }]
  setKeep(instanceId, { world: { ...world, members } })
}

export function createKeep(
  instanceId: string,
  serverId: string,
  target: { host: string; port: number; secure?: boolean; keepKey?: string }
): KeepConnection {
  dropKeep(instanceId)

  // The P2P transport is an opt-in experiment, chosen per connection at create
  // time so flipping the toggle takes effect on the next (re)join.
  const withTransport = { ...target, transport: isP2PEnabled() ? ('rtc' as const) : ('http' as const) }

  const conn: KeepConnection = new KeepConnection(withTransport, {
    onStatus: (status) => useUi.getState().setKeep(instanceId, { status }),
    onWorld: (world) => {
      useUi.getState().setKeep(instanceId, { world, ping: conn.ping })
      useUi.getState().renameServer(serverId, world.name)
      // seed voice occupancy from the snapshot so occupants show before joining
      // (live VOICE_STATE_UPDATE only fires on join/leave)
      for (const vs of world.voice_states ?? []) {
        useUi.getState().applyVoiceState(
          instanceId,
          vs.channel_id,
          vs.participants.map((p) => ({ userId: p.user_id, muted: p.muted, deafened: p.deafened }))
        )
      }
      // pin the Keep's identity key on first connect (TOFU), so later P2P
      // connects to this world can detect a man-in-the-middle
      updateWorld(instanceId, {
        name: world.name,
        ...(conn.keepKey ? { keepKey: conn.keepKey } : {})
      })
    },
    onMessage: (msg) => {
      useUi.getState().appendKeepMessage(instanceId, msg)
      notifyMessage(instanceId, serverId, msg, conn.self?.id)
    },
    onMessageUpdate: (msg) => useUi.getState().updateMessage(instanceId, msg),
    onMessageDelete: (channelId, id) => useUi.getState().removeMessage(instanceId, channelId, id),
    onPresence: (userId, online, state) => {
      const { connections, setKeep } = useUi.getState()
      const world = connections[instanceId]?.world
      if (!world) return
      setKeep(instanceId, {
        world: {
          ...world,
          members: world.members.map((m) => (m.id === userId ? { ...m, online, state } : m))
        }
      })
    },
    onMemberJoin: (user) => upsertMember(instanceId, user),
    onMemberUpdate: (user) => upsertMember(instanceId, user),
    onVoice: (t, d) => routeVoiceFrame(instanceId, t, d)
  })

  registry.set(instanceId, conn)
  return conn
}
