import { Plus } from 'lucide-react'
import type { Server } from '@/data/mock'
import { leaveWorld } from '@/net/session'
import { useUi, useWorld } from '@/store'

function ServerIcon({ server, offline }: { server: Server; offline?: boolean }): React.JSX.Element {
  const { activeServerId, setServer } = useUi()
  const active = server.id === activeServerId

  return (
    <div className="group relative flex w-full justify-center">
      {/* active / hover pill */}
      <span
        className={`absolute top-1/2 left-0 w-[3px] -translate-y-1/2 rounded-r-full bg-hi transition-all duration-200 ${
          active ? 'h-8' : 'h-0 group-hover:h-4'
        }`}
      />
      <button
        onClick={() => setServer(server.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          if (confirm(`Leave ${server.name}? You can rejoin with its address or an invite.`)) {
            leaveWorld(server.id)
          }
        }}
        title={`${server.name} — right-click to leave`}
        className={`relative flex h-11 w-11 items-center justify-center font-display text-[15px] font-bold transition-all duration-200 ${
          active ? 'rounded-[14px]' : 'rounded-[22px] hover:rounded-[14px]'
        } ${offline ? 'opacity-40 saturate-0' : ''}`}
        style={{
          color: active ? '#07080c' : server.accent,
          background: active
            ? `linear-gradient(135deg, ${server.accent}, color-mix(in srgb, ${server.accent} 60%, #5ea2ff))`
            : 'var(--color-void-2)',
          boxShadow: active ? `0 0 22px color-mix(in srgb, ${server.accent} 45%, transparent)` : undefined
        }}
      >
        {server.abbr}
      </button>
      {offline && (
        <span className="reconnecting absolute right-1.5 bottom-0.5 h-2 w-2 rounded-full bg-ember" />
      )}
    </div>
  )
}

export function ServerRail(): React.JSX.Element {
  const { instances, servers } = useWorld()
  const openAddServer = useUi((s) => s.openAddServer)

  return (
    <nav className="z-10 flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-void-0 py-3 scroll-thin">
      {/* home — direct messages live here eventually */}
      <button
        title="Direct messages — coming soon"
        className="flex h-11 w-11 items-center justify-center rounded-[22px] bg-void-2 text-[var(--accent)] transition-all duration-200 hover:rounded-[14px] hover:bg-[var(--accent)] hover:text-void-0"
      >
        <span className="text-lg">◆</span>
      </button>

      <div className="my-1 h-px w-8 bg-edge" />

      {servers.map((s) => {
        const instance = instances.find((i) => i.id === s.instanceId)
        return <ServerIcon key={s.id} server={s} offline={instance && !instance.online} />
      })}

      <button
        onClick={openAddServer}
        title="Add a world — paste an address, relic:// link, or invite code"
        className="flex h-11 w-11 items-center justify-center rounded-[22px] bg-void-2 text-pulse transition-all duration-200 hover:rounded-[14px] hover:bg-pulse hover:text-void-0"
      >
        <Plus size={20} />
      </button>
    </nav>
  )
}
