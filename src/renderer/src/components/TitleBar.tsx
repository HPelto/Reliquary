import { RefreshCw, Search } from 'lucide-react'
import { useUi, useWorld } from '@/store'

export function TitleBar(): React.JSX.Element {
  const { activeServerId, activeChannelId, openPalette, connections, update } = useUi()
  const { servers } = useWorld()
  const server = servers.find((s) => s.id === activeServerId)
  const channel = server
    ? connections[server.instanceId]?.world?.channels.find((c) => String(c.id) === activeChannelId)
    : undefined

  return (
    <header
      className="drag relative z-50 flex h-[38px] shrink-0 items-center gap-4 border-b border-edge bg-void-0 pl-4"
      style={{ width: 'env(titlebar-area-width, 100%)' }}
    >
      {/* sigil */}
      <div className="flex items-center gap-2">
        <span className="text-[15px] leading-none text-relic" style={{ textShadow: '0 0 12px rgba(139,124,246,0.7)' }}>
          ◆
        </span>
        <span className="font-display text-[12.5px] font-semibold tracking-[0.14em] text-mid">
          RELIQUARY
        </span>
      </div>

      {/* breadcrumb */}
      {server && (
        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-lo">
          <span className="truncate text-mid">{server.name}</span>
          {channel && (
            <>
              <span>/</span>
              <span className="truncate text-hi"># {channel.name}</span>
            </>
          )}
        </div>
      )}

      {/* auto-update: a quiet "downloading" hint; the actionable prompt is the
          full-width UpdateBanner that appears once the download finishes */}
      {update.status === 'download-progress' && (
        <span className="ml-auto flex items-center gap-1.5 px-2.5 text-[11px] text-lo">
          <RefreshCw size={11} className="animate-spin" />
          Updating… {update.percent ?? 0}%
        </span>
      )}

      {/* search — becomes the ⌘K palette */}
      <div className="pointer-events-none absolute left-1/2 -translate-x-1/2">
        <button
          onClick={openPalette}
          className="no-drag pointer-events-auto flex w-[300px] items-center gap-2 rounded-lg border border-edge bg-void-2/70 px-3 py-[5px] text-[12px] text-lo transition-colors duration-150 hover:border-relic/40 hover:text-mid"
        >
          <Search size={13} />
          <span className="flex-1 text-left">Search or jump anywhere…</span>
          <kbd className="rounded border border-edge bg-void-3 px-1.5 py-px font-mono text-[10px] text-lo">
            Ctrl K
          </kbd>
        </button>
      </div>
    </header>
  )
}
