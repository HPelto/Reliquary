import { useEffect, useState } from 'react'
import { Hash, Pencil, Plus, Trash2, Volume2, X } from 'lucide-react'
import { getKeep } from '@/net/bind'
import { useUi, useWorld } from '@/store'
import { InvitesPanel } from './InvitesPanel'

type Tab = 'overview' | 'channels' | 'invites'

/** Keep Settings — full page (owner/admin). Server name, the username-style
 *  lock, channel management, and invites. */
export function ServerSettingsModal(): React.JSX.Element | null {
  const { serverSettingsOpen, closeServerSettings, activeServerId, connections } = useUi()
  const { servers } = useWorld()
  const [tab, setTab] = useState<Tab>('overview')
  const [name, setName] = useState('')
  const [chName, setChName] = useState('')
  const [chKind, setChKind] = useState<'text' | 'voice'>('text')
  const [error, setError] = useState<string | null>(null)

  const server = servers.find((s) => s.id === activeServerId)
  const keep = server?.real ? connections[server.instanceId] : undefined
  const conn = server?.real ? getKeep(server.instanceId) : undefined
  const canManage = keep?.self?.role === 'owner' || keep?.self?.role === 'admin'
  const locked = !!keep?.world?.lock_name_style
  // unset defaults to true (the privacy-first behavior the Keep ships with)
  const requireInvite = keep?.world?.require_invite !== false

  useEffect(() => {
    if (serverSettingsOpen) {
      setTab('overview')
      setError(null)
      setName(keep?.world?.name ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSettingsOpen])

  useEffect(() => {
    if (!serverSettingsOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeServerSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [serverSettingsOpen, closeServerSettings])

  if (!serverSettingsOpen || !server?.real || !conn || !canManage) return null

  const act = (fn: () => Promise<unknown>): void => {
    setError(null)
    void fn().catch((e: Error) => setError(e.message))
  }

  const channels = keep?.world?.channels ?? []
  const TABS: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'channels', label: 'Channels' },
    { key: 'invites', label: 'Invites' }
  ]

  return (
    <div className="absolute inset-x-0 bottom-0 top-[38px] z-[150] flex bg-void-0">
      {/* sidebar */}
      <nav className="w-[210px] shrink-0 border-r border-edge bg-void-1 px-3 py-6">
        <div className="mb-1 px-2 font-display text-[14px] font-bold tracking-tight text-hi">
          {keep?.world?.name}
        </div>
        <div className="mb-4 px-2 font-mono text-[9.5px] break-all text-lo">
          ◆ {conn.host}:{conn.port}
        </div>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`mb-0.5 flex w-full items-center rounded-lg px-3 py-2 text-[13px] transition-colors ${
              tab === t.key ? 'bg-void-3 text-hi' : 'text-mid hover:bg-void-2 hover:text-hi'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* content */}
      <div className="relative flex-1 overflow-y-auto scroll-thin">
        <button
          onClick={closeServerSettings}
          className="absolute top-5 right-6 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-edge text-mid transition-colors hover:border-ember/40 hover:text-ember"
          title="Close · Esc"
        >
          <X size={16} />
        </button>

        <div className="mx-auto max-w-[600px] px-8 py-10">
          {tab === 'overview' && (
            <>
              <h1 className="font-display text-[22px] font-bold tracking-tight">Overview</h1>
              <label className="mt-6 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                Server name
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={48}
                  className="min-w-0 flex-1 rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[13.5px] text-hi outline-none select-text focus:border-relic/50"
                />
                <button
                  onClick={() => act(() => conn.setName(name))}
                  disabled={!name.trim() || name === keep?.world?.name}
                  className="rounded-xl bg-relic px-4 text-[13px] font-semibold text-void-0 transition-all duration-150 hover:shadow-[0_0_18px_rgba(139,124,246,0.45)] disabled:opacity-30"
                >
                  Rename
                </button>
              </div>

              <div className="mt-5 flex items-start justify-between gap-3 rounded-xl border border-edge bg-void-1 p-3.5">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-hi">Lock username styling</div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-lo">
                    Force role colors (owner gold · admin purple · member light) and ignore custom
                    fonts, effects, and name colors across this server.
                  </div>
                </div>
                <button
                  role="switch"
                  aria-checked={locked}
                  onClick={() => act(() => conn.setNameLock(!locked))}
                  className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ${
                    locked ? 'bg-relic' : 'border border-edge bg-void-3'
                  }`}
                >
                  <span
                    className={`inline-block h-[18px] w-[18px] rounded-full bg-hi shadow-sm transition-transform duration-200 ${
                      locked ? 'translate-x-[23px]' : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>

              <div className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-edge bg-void-1 p-3.5">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-hi">Require invite to join</div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-lo">
                    When on, new members need a valid invite code. Turn off to let anyone who has
                    the address — and the keep password, if you set one — join directly.
                  </div>
                  {!requireInvite && (
                    <div className="mt-1.5 text-[11.5px] leading-relaxed text-ember">
                      Open join: anyone who can reach this Keep (and knows the keep password, if
                      any) can join without an invite.
                    </div>
                  )}
                </div>
                <button
                  role="switch"
                  aria-checked={requireInvite}
                  onClick={() => act(() => conn.setRequireInvite(!requireInvite))}
                  className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ${
                    requireInvite ? 'bg-relic' : 'border border-edge bg-void-3'
                  }`}
                >
                  <span
                    className={`inline-block h-[18px] w-[18px] rounded-full bg-hi shadow-sm transition-transform duration-200 ${
                      requireInvite ? 'translate-x-[23px]' : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>

              <p className="mt-4 text-[12px] leading-relaxed text-lo">
                Server-side configuration — the keep password gate, admin roles, and user
                rescue/removal — lives in the host console on the machine running the Keep.
              </p>
            </>
          )}

          {tab === 'channels' && (
            <>
              <h1 className="font-display text-[22px] font-bold tracking-tight">Channels</h1>
              <div className="mt-6 flex flex-col gap-px">
                {channels.map((ch) => (
                  <div
                    key={ch.id}
                    className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-void-2"
                  >
                    {ch.kind === 'voice' ? (
                      <Volume2 size={14} className="text-lo" />
                    ) : (
                      <Hash size={14} className="text-lo" />
                    )}
                    <span className="text-[13px]">{ch.name}</span>
                    <span className="ml-auto hidden gap-1 group-hover:flex">
                      <button
                        onClick={() => {
                          const next = prompt('Rename channel', ch.name)
                          if (next) act(() => conn.renameChannel(ch.id, next))
                        }}
                        className="rounded-md p-1 text-mid transition-colors hover:bg-void-3 hover:text-hi"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => act(() => conn.deleteChannel(ch.id))}
                        className="rounded-md p-1 text-mid transition-colors hover:bg-ember/15 hover:text-ember"
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <input
                  value={chName}
                  onChange={(e) => setChName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && chName.trim()) {
                      act(() => conn.createChannel(chName, chKind))
                      setChName('')
                    }
                  }}
                  placeholder="new-channel"
                  maxLength={48}
                  className="min-w-0 flex-1 rounded-xl border border-edge bg-void-0/70 px-3.5 py-2 text-[13px] text-hi outline-none select-text placeholder:text-lo/60 focus:border-relic/50"
                />
                <select
                  value={chKind}
                  onChange={(e) => setChKind(e.target.value as 'text' | 'voice')}
                  className="rounded-xl border border-edge bg-void-0/70 px-2 text-[12.5px] text-mid outline-none"
                >
                  <option value="text">text</option>
                  <option value="voice">voice</option>
                </select>
                <button
                  onClick={() => {
                    if (chName.trim()) {
                      act(() => conn.createChannel(chName, chKind))
                      setChName('')
                    }
                  }}
                  className="flex items-center gap-1 rounded-xl bg-relic px-3.5 text-[13px] font-semibold text-void-0 transition-all duration-150 hover:shadow-[0_0_18px_rgba(139,124,246,0.45)]"
                >
                  <Plus size={14} />
                  Create
                </button>
              </div>
            </>
          )}

          {tab === 'invites' && (
            <>
              <h1 className="mb-6 font-display text-[22px] font-bold tracking-tight">Invites</h1>
              <InvitesPanel conn={conn} />
            </>
          )}

          {error && <p className="mt-3 text-[12px] text-ember">{error}</p>}
        </div>
      </div>
    </div>
  )
}
