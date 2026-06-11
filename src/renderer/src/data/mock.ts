// Shared UI types. (The demo world that used to live here is gone — the
// client now renders only real, connected Keeps.)

export type Status = 'online' | 'idle' | 'dnd' | 'offline'

export interface User {
  id: string
  name: string
  color: string
  status: Status
  roleId: string
  speaking?: boolean
  activity?: string
  owner?: boolean
}

export interface Instance {
  id: string
  domain: string
  official?: boolean
  online: boolean
}

export interface Server {
  id: string
  instanceId: string
  name: string
  abbr: string
  accent: string
  unread?: boolean
  mentions?: number
  voiceActive?: boolean
  /** true = a live self-hosted Keep; data comes from its connection */
  real?: boolean
}

export interface Channel {
  id: string
  kind: 'text' | 'voice'
  name: string
  unread?: boolean
  mentions?: number
  pinned?: boolean
  occupantIds?: string[]
}
