import { useEffect, useState } from 'react'
import { AtSign, Bell, BellOff, MessageSquare, X } from 'lucide-react'
import {
  getServerPrefs,
  setServerPrefs,
  type Level,
  type ServerPrefs
} from '@/lib/notifications'
import { useUi, useWorld } from '@/store'

const LEVELS: { key: Level; label: string; desc: string; icon: React.ReactNode }[] = [
  { key: 'all', label: 'All messages', desc: 'Notify for every message', icon: <MessageSquare size={15} /> },
  { key: 'mentions', label: 'Only @mentions', desc: 'Only when you are mentioned', icon: <AtSign size={15} /> },
  { key: 'nothing', label: 'Nothing', desc: 'No notifications from this server', icon: <BellOff size={15} /> }
]

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ${
        on ? 'bg-relic' : 'border border-edge bg-void-3'
      }`}
    >
      <span
        className={`inline-block h-[18px] w-[18px] rounded-full bg-hi shadow-sm transition-transform duration-200 ${
          on ? 'translate-x-[23px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
}

/** Per-server notification preferences (client-local). */
export function NotificationSettingsModal(): React.JSX.Element | null {
  const { notifOpen, closeNotif, activeServerId, connections } = useUi()
  const { servers } = useWorld()
  const server = servers.find((s) => s.id === activeServerId)
  const keep = server?.real ? connections[server.instanceId] : undefined
  const [prefs, setPrefs] = useState<ServerPrefs | null>(null)

  useEffect(() => {
    if (notifOpen && server) setPrefs(getServerPrefs(server.instanceId))
  }, [notifOpen, server])

  useEffect(() => {
    if (!notifOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeNotif()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [notifOpen, closeNotif])

  if (!notifOpen || !server?.real || !prefs) return null

  const update = (next: ServerPrefs): void => {
    setPrefs(next)
    setServerPrefs(server.instanceId, next)
  }

  return (
    <div
      className="absolute inset-0 z-[100] flex items-start justify-center bg-void-0/60 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={closeNotif}
    >
      <div
        className="glass palette-in w-[460px] overflow-hidden rounded-2xl shadow-[0_24px_80px_-12px_rgba(0,0,0,0.8),0_0_40px_-18px_var(--accent)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Bell size={16} className="text-relic" />
            <h2 className="font-display text-[16px] font-bold">Notifications · {keep?.world?.name}</h2>
          </div>
          <button
            onClick={closeNotif}
            className="rounded-md p-1.5 text-lo transition-colors hover:bg-void-3 hover:text-hi"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          <div className="text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
            Server notifications
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                onClick={() => update({ ...prefs, level: l.key })}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  prefs.level === l.key
                    ? 'border-relic/60 bg-relic/10'
                    : 'border-edge bg-void-0/50 hover:border-relic/30'
                }`}
              >
                <span className={prefs.level === l.key ? 'text-relic' : 'text-mid'}>{l.icon}</span>
                <span className="flex-1">
                  <span className="block text-[13px] text-hi">{l.label}</span>
                  <span className="block text-[11.5px] text-lo">{l.desc}</span>
                </span>
                <span
                  className={`h-3.5 w-3.5 rounded-full border ${
                    prefs.level === l.key ? 'border-relic bg-relic' : 'border-edge'
                  }`}
                />
              </button>
            ))}
          </div>

          <div className="mt-5 text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
            Suppress
          </div>
          <div className="mt-2 flex flex-col gap-2">
            <label className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-void-0/40 px-3 py-2.5">
              <span className="text-[13px] text-hi">
                @everyone and @here
                <span className="block text-[11.5px] text-lo">Don&apos;t notify for mass pings</span>
              </span>
              <Toggle
                on={prefs.suppressEveryone}
                onClick={() => update({ ...prefs, suppressEveryone: !prefs.suppressEveryone })}
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-void-0/40 px-3 py-2.5">
              <span className="text-[13px] text-hi">
                Role @mentions
                <span className="block text-[11.5px] text-lo">Don&apos;t notify when a role you have is pinged</span>
              </span>
              <Toggle
                on={prefs.suppressRoles}
                onClick={() => update({ ...prefs, suppressRoles: !prefs.suppressRoles })}
              />
            </label>
          </div>

          <p className="mt-4 font-mono text-[10px] text-lo">
            Saved locally for you — these never leave your device. Per-channel overrides: right-click a
            channel.
          </p>
        </div>
      </div>
    </div>
  )
}
