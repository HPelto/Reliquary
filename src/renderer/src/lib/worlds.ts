/**
 * Persistence for joined keeps. Deliberately does NOT store session tokens —
 * the client re-handshakes with the unlocked relic key on every launch, so
 * no bearer credentials sit on disk. The keep password (if the host gated
 * the server) is stored so resume works; like the identity blobs, it moves
 * behind Electron safeStorage before beta.
 */

export interface SavedWorld {
  v: 1
  instanceId: string
  serverId: string
  host: string
  port: number
  /** true if joined over https/wss; undefined = infer from port (legacy worlds) */
  secure?: boolean
  name: string
  abbr: string
  accent: string
  keepPassword?: string
}

import { kvGet, kvSet } from './storage'

const STORAGE_KEY = 'reliquary.worlds.v1'

export function loadWorlds(): SavedWorld[] {
  try {
    const raw = kvGet(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SavedWorld[]
    return Array.isArray(parsed) ? parsed.filter((w) => w.v === 1 && w.host && w.instanceId) : []
  } catch {
    return []
  }
}

function save(worlds: SavedWorld[]): void {
  kvSet(STORAGE_KEY, JSON.stringify(worlds))
}

export function upsertWorld(world: SavedWorld): void {
  const worlds = loadWorlds().filter((w) => w.instanceId !== world.instanceId)
  worlds.push(world)
  save(worlds)
}

export function updateWorld(instanceId: string, partial: Partial<SavedWorld>): void {
  save(loadWorlds().map((w) => (w.instanceId === instanceId ? { ...w, ...partial } : w)))
}

export function removeWorld(instanceId: string): void {
  save(loadWorlds().filter((w) => w.instanceId !== instanceId))
}
