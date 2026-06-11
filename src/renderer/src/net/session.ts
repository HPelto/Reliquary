/**
 * Lifecycle orchestration above bind.ts: resuming saved worlds at launch
 * (re-handshake with the unlocked relic key — no tokens are persisted) and
 * leaving a keep for good.
 */

import { loadProfile, type Profile } from '@/lib/profile'
import { loadWorlds, removeWorld, type SavedWorld } from '@/lib/worlds'
import type { Identity } from '@/lib/identity'
import { useUi } from '@/store'
import { allKeeps, createKeep, dropKeep, getKeep } from './bind'
import { KeepError, profilePayload, type KeepPresence } from './keep'

let resumed = false

/** Call once the identity is unlocked. Safe against double-invocation. */
export function resumeWorlds(): void {
  if (resumed) return
  resumed = true
  for (const w of loadWorlds()) {
    void connectWorld(w)
  }
}

async function connectWorld(w: SavedWorld): Promise<void> {
  // show it in the rail immediately; the status line says the rest
  useUi.getState().addWorld(
    { id: w.instanceId, domain: w.host, online: true },
    {
      id: w.serverId,
      instanceId: w.instanceId,
      name: w.name,
      abbr: w.abbr,
      accent: w.accent,
      real: true
    },
    false
  )
  const conn = createKeep(w.instanceId, w.serverId, w)

  for (let attempt = 0; ; attempt++) {
    // stop if the user left the keep (or a fresh join replaced this conn)
    if (getKeep(w.instanceId) !== conn) return
    const { identity, unlockedKey, setKeep } = useUi.getState()
    if (!identity || !unlockedKey) return
    try {
      const profile = loadProfile()
      await conn.discover()
      const user = await conn.handshake(
        { pub: identity.pub, name: identity.name, accent: identity.accent },
        unlockedKey,
        { keepPassword: w.keepPassword, profile }
      )
      setKeep(w.instanceId, { self: user })
      // upload our avatar/background bytes BEFORE the world renders, so our
      // own member tile doesn't flash a broken image
      await conn.ensureMedia(profile).catch(() => {})
      await conn.fetchWorld()
      // start this connection with our chosen presence so onopen asserts it
      conn.presence = useUi.getState().presence.state
      conn.openGateway()
      return
    } catch (e) {
      setKeep(w.instanceId, { status: 'offline' })
      // 403 = the keep rejected us (profile removed, password changed, …) —
      // retrying won't help; the user has to re-add with fresh credentials
      if (e instanceof KeepError && e.status === 403) return
      await new Promise((r) => setTimeout(r, Math.min(5_000 * 2 ** attempt, 30_000)))
    }
  }
}

/** Push the local presence state to every connected Keep (broadcast to members). */
export function pushPresenceEverywhere(state: KeepPresence): void {
  for (const conn of allKeeps()) conn.setPresence(state)
}

export function leaveWorld(serverId: string): void {
  const server = useUi.getState().extraServers.find((s) => s.id === serverId)
  if (!server) return
  dropKeep(server.instanceId)
  removeWorld(server.instanceId)
  useUi.getState().removeServer(serverId, server.instanceId)
}

/** Push a profile edit to every connected Keep: upload any new media, then
 *  PATCH the profile so other members see it live. */
export async function pushProfileEverywhere(identity: Identity, profile: Profile): Promise<void> {
  const payload = profilePayload(
    { pub: identity.pub, name: identity.name, accent: identity.accent },
    profile
  )
  await Promise.allSettled(
    allKeeps()
      .filter((conn) => conn.token)
      .map(async (conn) => {
        // a media upload failure must never block the text sync — try it,
        // but patch the profile regardless
        await conn.ensureMedia(profile).catch(() => {})
        const user = await conn.patchProfile(payload)
        // reflect our own change locally (gateway won't echo to the sender for
        // a self-targeted broadcast race — set it directly)
        const instanceId = [...useUi.getState().extraInstances].find(
          (i) => i.domain === conn.host
        )?.id
        if (instanceId) useUi.getState().setKeep(instanceId, { self: user })
      })
  )
}
