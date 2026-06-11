/**
 * Per-server and per-channel notification preferences. Client-local and
 * personal — never synced to the Keep. Persisted in the durable file store.
 *
 * These are stored preferences only; a future notification-delivery engine
 * will read resolved(...) to decide whether to alert. Nothing fires yet.
 */

import { kvGet, kvSet } from './storage'

export type Level = 'all' | 'mentions' | 'nothing'

export interface ServerPrefs {
  level: Level
  suppressEveryone: boolean // @everyone / @here
  suppressRoles: boolean // role @mentions
}

export interface ChannelPrefs {
  level: Level | 'inherit'
}

interface Store {
  servers: Record<string, ServerPrefs> // instanceId → prefs
  channels: Record<string, ChannelPrefs> // `${instanceId}:${channelId}` → prefs
}

const KEY = 'reliquary.notifications.v1'

export const DEFAULT_SERVER_PREFS: ServerPrefs = {
  level: 'all',
  suppressEveryone: false,
  suppressRoles: false
}

function load(): Store {
  try {
    const raw = kvGet(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>
      return { servers: parsed.servers ?? {}, channels: parsed.channels ?? {} }
    }
  } catch {
    /* fall through */
  }
  return { servers: {}, channels: {} }
}

function save(s: Store): void {
  kvSet(KEY, JSON.stringify(s))
}

export function getServerPrefs(instanceId: string): ServerPrefs {
  return { ...DEFAULT_SERVER_PREFS, ...load().servers[instanceId] }
}

export function setServerPrefs(instanceId: string, prefs: ServerPrefs): void {
  const s = load()
  s.servers[instanceId] = prefs
  save(s)
}

export function getChannelPrefs(instanceId: string, channelId: string): ChannelPrefs {
  return load().channels[`${instanceId}:${channelId}`] ?? { level: 'inherit' }
}

export function setChannelPrefs(instanceId: string, channelId: string, prefs: ChannelPrefs): void {
  const s = load()
  s.channels[`${instanceId}:${channelId}`] = prefs
  save(s)
}

/** The effective level for a channel: channel override → server → default. */
export function resolved(instanceId: string, channelId: string): Level {
  const ch = getChannelPrefs(instanceId, channelId)
  if (ch.level !== 'inherit') return ch.level
  return getServerPrefs(instanceId).level
}
