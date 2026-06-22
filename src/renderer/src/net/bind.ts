/**
 * Glue between KeepConnection (pure protocol, owns the sockets) and the
 * zustand store (serializable state the UI renders). Socket objects never
 * enter the store; the registry here owns them per instance.
 */

import { KeepConnection, type KeepMessage, type KeepUser } from './keep'
import { routeVoiceFrame } from './voice'
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
  target: { host: string; port: number; secure?: boolean }
): KeepConnection {
  dropKeep(instanceId)

  const conn: KeepConnection = new KeepConnection(target, {
    onStatus: (status) => useUi.getState().setKeep(instanceId, { status }),
    onWorld: (world) => {
      useUi.getState().setKeep(instanceId, { world, ping: conn.ping })
      useUi.getState().renameServer(serverId, world.name)
      updateWorld(instanceId, { name: world.name })
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
