/**
 * Durable key-value storage. Prefers the main process's atomic file store
 * (survives hard kills — localStorage does not, which once ate an identity);
 * falls back to localStorage when running outside Electron. Any value found
 * only in localStorage is migrated into the file store on first read.
 */

interface BridgeStorage {
  getSync: (key: string) => string | null
  set: (key: string, value: string) => void
  remove: (key: string) => void
}

function bridge(): BridgeStorage | null {
  if (typeof window === 'undefined') return null
  return (window as { reliquary?: { storage?: BridgeStorage } }).reliquary?.storage ?? null
}

export function kvGet(key: string): string | null {
  const b = bridge()
  if (b) {
    const v = b.getSync(key)
    if (v !== null) return v
    // migrate anything that survived in localStorage
    const legacy = localStorage.getItem(key)
    if (legacy !== null) {
      b.set(key, legacy)
      localStorage.removeItem(key)
    }
    return legacy
  }
  return localStorage.getItem(key)
}

export function kvSet(key: string, value: string): void {
  const b = bridge()
  if (b) b.set(key, value)
  else localStorage.setItem(key, value)
}

export function kvRemove(key: string): void {
  const b = bridge()
  if (b) b.remove(key)
  else localStorage.removeItem(key)
}
