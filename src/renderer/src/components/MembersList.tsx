import { useRef, useState } from 'react'
import { nameColorFor } from '@/lib/nameStyle'
import { presenceColor } from '@/lib/presence'
import type { KeepMember } from '@/net/keep'
import { useUi, useWorld } from '@/store'
import { KeepAvatar } from './KeepAvatar'
import { StyledName } from './StyledName'
import { UserCard } from './UserCard'

function MemberRow({
  m,
  instanceId,
  locked,
  onHover,
  onLeave
}: {
  m: KeepMember
  instanceId: string
  locked: boolean
  onHover: (m: KeepMember, top: number) => void
  onLeave: () => void
}): React.JSX.Element {
  const viewUser = useUi((s) => s.viewUser)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      onClick={() => viewUser(m.id)}
      onMouseEnter={() => onHover(m, ref.current?.getBoundingClientRect().top ?? 0)}
      onMouseLeave={onLeave}
      className={`flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-void-2 ${
        m.online ? '' : 'opacity-40'
      }`}
    >
      <div className="relative shrink-0">
        <KeepAvatar
          instanceId={instanceId}
          avatar={m.avatar}
          name={m.username}
          accent={m.accent}
          size={30}
        />
        <span
          className="absolute -right-0.5 -bottom-0.5 block h-2.5 w-2.5 rounded-full border-2 border-void-1"
          style={{ background: presenceColor(m.state ?? (m.online ? 'online' : 'offline')) }}
        />
      </div>
      <div className="min-w-0 leading-tight">
        <div className="flex items-center gap-1.5">
          <StyledName
            name={m.username}
            color={nameColorFor(m, locked)}
            font={locked ? 'default' : m.name_font}
            effect={locked ? 'none' : m.name_effect}
            mode="static"
            className="truncate text-[13px]"
          />
          {m.role === 'owner' && <span className="text-[10px] text-gold">♛</span>}
        </div>
        <div className="truncate text-[10.5px] text-lo">
          {m.status || `◆ ${m.fingerprint}`}
        </div>
      </div>
    </button>
  )
}

export function MembersList(): React.JSX.Element | null {
  const { membersOpen, activeServerId, connections } = useUi()
  const { servers } = useWorld()
  const [hover, setHover] = useState<{ m: KeepMember; top: number } | null>(null)
  const server = servers.find((s) => s.id === activeServerId)
  if (!membersOpen || !server) return null

  const world = connections[server.instanceId]?.world
  const members = world?.members ?? []
  const locked = !!world?.lock_name_style
  const online = members.filter((m) => m.online)
  const offline = members.filter((m) => !m.online)

  const groups: { label: string; color: string; list: KeepMember[] }[] = [
    { label: `Online — ${online.length}`, color: 'text-[var(--accent)]', list: online },
    { label: `Offline — ${offline.length}`, color: 'text-lo', list: offline }
  ]

  return (
    <aside className="relative z-10 w-[232px] shrink-0 overflow-y-auto border-l border-edge bg-void-1 px-3 py-4 scroll-thin">
      {groups.map(
        (g) =>
          g.list.length > 0 && (
            <div key={g.label} className="mb-4">
              <div
                className={`mb-2 px-1 text-[10.5px] font-semibold tracking-[0.12em] uppercase ${g.color}`}
              >
                {g.label}
              </div>
              {g.list.map((m) => (
                <MemberRow
                  key={m.id}
                  m={m}
                  instanceId={server.instanceId}
                  locked={locked}
                  onHover={(mem, top) => setHover({ m: mem, top })}
                  onLeave={() => setHover(null)}
                />
              ))}
            </div>
          )
      )}
      {members.length === 0 && <p className="px-1 font-mono text-[11px] text-lo">syncing members…</p>}

      {/* hover card, floated to the left of the rail */}
      {hover && (
        <div
          className="pointer-events-none fixed right-[244px] z-[120]"
          style={{ top: Math.min(hover.top, window.innerHeight - 220) }}
        >
          <UserCard member={hover.m} instanceId={server.instanceId} locked={locked} />
        </div>
      )}
    </aside>
  )
}
