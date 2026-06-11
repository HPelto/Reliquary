import { useEffect } from 'react'
import { CalendarPlus, MapPin, Trash2, Volume2, X } from 'lucide-react'
import { eventLocationText, eventRangeText, upcomingEvents } from '@/lib/events'
import { getKeep } from '@/net/bind'
import type { KeepChannel, KeepEvent } from '@/net/keep'
import { useUi, useWorld } from '@/store'

function EventCard({
  e,
  channels,
  baseUrl,
  canManage,
  onDelete
}: {
  e: KeepEvent
  channels: KeepChannel[]
  baseUrl: string
  canManage: boolean
  onDelete: () => void
}): React.JSX.Element {
  const cover = e.cover ? `${baseUrl}/v1/media/${e.cover}` : ''
  return (
    <div className="group overflow-hidden rounded-2xl border border-edge bg-void-1">
      <div
        className="h-24 bg-void-3"
        style={
          cover
            ? { backgroundImage: `url(${cover})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : { background: 'linear-gradient(120deg, color-mix(in srgb, var(--accent) 40%, #0c0e14), #0c0e14)' }
        }
      />
      <div className="p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-mono text-[11px] text-relic">{eventRangeText(e.starts_at, e.ends_at)}</div>
            <div className="mt-0.5 font-display text-[15px] font-bold">{e.title}</div>
          </div>
          {canManage && (
            <button
              onClick={onDelete}
              title="Delete event"
              className="rounded-md p-1 text-lo opacity-0 transition-colors group-hover:opacity-100 hover:bg-ember/15 hover:text-ember"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        {e.description && <p className="mt-1 text-[12px] leading-relaxed text-mid">{e.description}</p>}
        <div className="mt-2 flex items-center gap-1.5 border-t border-edge pt-2 text-[12px] text-lo">
          {e.location_kind === 'voice' ? <Volume2 size={13} /> : <MapPin size={13} />}
          {eventLocationText(e, channels)}
          {e.frequency !== 'once' && (
            <span className="ml-auto rounded border border-edge px-1.5 text-[9.5px] tracking-wide text-lo uppercase">
              {e.frequency}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export function EventsModal(): React.JSX.Element | null {
  const { eventsOpen, closeEvents, openCreateEvent, activeServerId, connections } = useUi()
  const { servers } = useWorld()
  const server = servers.find((s) => s.id === activeServerId)
  const keep = server?.real ? connections[server.instanceId] : undefined
  const conn = server?.real ? getKeep(server.instanceId) : undefined
  const canManage = keep?.self?.role === 'owner' || keep?.self?.role === 'admin'

  useEffect(() => {
    if (!eventsOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeEvents()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [eventsOpen, closeEvents])

  if (!eventsOpen || !server?.real || !conn) return null

  const events = upcomingEvents(keep?.world?.events)
  const channels = keep?.world?.channels ?? []

  return (
    <div
      className="absolute inset-0 z-[100] flex items-start justify-center bg-void-0/60 pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={closeEvents}
    >
      <div
        className="glass palette-in flex max-h-[74vh] w-[460px] flex-col overflow-hidden rounded-2xl shadow-[0_24px_80px_-12px_rgba(0,0,0,0.8),0_0_40px_-18px_var(--accent)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
          <h2 className="font-display text-[16px] font-bold">Events · {keep?.world?.name}</h2>
          <div className="flex items-center gap-1">
            {canManage && (
              <button
                onClick={() => {
                  closeEvents()
                  openCreateEvent()
                }}
                className="flex items-center gap-1.5 rounded-lg bg-relic px-3 py-1.5 text-[12.5px] font-semibold text-void-0 transition-all hover:shadow-[0_0_18px_rgba(139,124,246,0.45)]"
              >
                <CalendarPlus size={14} />
                New
              </button>
            )}
            <button
              onClick={closeEvents}
              className="rounded-md p-1.5 text-lo transition-colors hover:bg-void-3 hover:text-hi"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 scroll-thin">
          {events.length === 0 ? (
            <div className="py-10 text-center">
              <CalendarPlus size={26} className="mx-auto text-lo" />
              <p className="mt-3 text-[13px] text-mid">No scheduled events yet.</p>
              {canManage && (
                <p className="mt-1 text-[12px] text-lo">Use “New” to plan one.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {events.map((e) => (
                <EventCard
                  key={e.id}
                  e={e}
                  channels={channels}
                  baseUrl={conn.baseUrl}
                  canManage={canManage}
                  onDelete={() => {
                    if (confirm(`Delete “${e.title}”?`)) void conn.deleteEvent(e.id)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
