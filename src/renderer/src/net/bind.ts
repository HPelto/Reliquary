/**
 * Glue between KeepConnection (pure protocol, owns the sockets) and the
 * zustand store (serializable state the UI renders). Socket objects never
 * enter the store; the registry here owns them per instance.
 */

import { KeepConnection, type KeepUser } from './keep'
import { routeVoiceFrame } from './voice'
import { updateWorld } from '@/lib/worlds'
import { useUi } from '@/store'

const registry = new Map<string, KeepConnection>()

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
  target: { host: string; port: number }
): KeepConnection {
  dropKeep(instanceId)

  const conn: KeepConnection = new KeepConnection(target, {
    onStatus: (status) => useUi.getState().setKeep(instanceId, { status }),
    onWorld: (world) => {
      useUi.getState().setKeep(instanceId, { world, ping: conn.ping })
      useUi.getState().renameServer(serverId, world.name)
      updateWorld(instanceId, { name: world.name })
    },
    onMessage: (msg) => useUi.getState().appendKeepMessage(instanceId, msg),
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
