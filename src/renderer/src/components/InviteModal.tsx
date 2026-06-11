import { useEffect } from 'react'
import { UserPlus, X } from 'lucide-react'
import { getKeep } from '@/net/bind'
import { useUi, useWorld } from '@/store'
import { InvitesPanel } from './InvitesPanel'

/** Quick "Invite to Keep" — mint and share an encrypted invite code/link. */
export function InviteModal(): React.JSX.Element | null {
  const { inviteOpen, closeInvite, activeServerId, connections } = useUi()
  const { servers } = useWorld()
  const server = servers.find((s) => s.id === activeServerId)
  const keep = server?.real ? connections[server.instanceId] : undefined
  const conn = server?.real ? getKeep(server.instanceId) : undefined
  const canManage = keep?.self?.role === 'owner' || keep?.self?.role === 'admin'

  useEffect(() => {
    if (!inviteOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeInvite()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inviteOpen, closeInvite])

  if (!inviteOpen || !server?.real || !conn || !canManage) return null

  return (
    <div
      className="absolute inset-0 z-[100] flex items-start justify-center bg-void-0/60 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={closeInvite}
    >
      <div
        className="glass palette-in w-[520px] overflow-hidden rounded-2xl shadow-[0_24px_80px_-12px_rgba(0,0,0,0.8),0_0_40px_-18px_var(--accent)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
          <div className="flex items-center gap-2">
            <UserPlus size={16} className="text-relic" />
            <h2 className="font-display text-[16px] font-bold">Invite to {keep?.world?.name}</h2>
          </div>
          <button
            onClick={closeInvite}
            className="rounded-md p-1.5 text-lo transition-colors hover:bg-void-3 hover:text-hi"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">
          <p className="mb-4 text-[12.5px] leading-relaxed text-mid">
            Share an <span className="text-hi">encrypted</span> invite code or link — the Keep&apos;s
            address is hidden inside it. Anyone you give the full code to can join (share it like a
            password).
          </p>
          <InvitesPanel conn={conn} />
        </div>
      </div>
    </div>
  )
}
