import type { KeepChannel, KeepEvent } from '@/net/keep'

/** Show a banner for events starting within this window (or already live). */
export const SOON_WINDOW_MS = 60 * 60 * 1000

export function startsInText(ms: number): string {
  const d = ms - Date.now()
  if (d <= 0) return 'Live now'
  const m = Math.round(d / 60000)
  if (m < 60) return `Starting in ${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `Starting in ${h}h`
  return `Starting in ${Math.round(h / 24)}d`
}

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function eventWhenText(ms: number): string {
  const date = new Date(ms)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  if (sameDay) return `Today · ${timeOf(ms)}`
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${timeOf(ms)}`
}

/** "Today · 2:00 – 3:00 AM" / "Jun 12 · 8:00 PM → Jun 13 · 1:00 AM". */
export function eventRangeText(startsAt: number, endsAt: number): string {
  if (!endsAt) return eventWhenText(startsAt)
  const sameDay = new Date(startsAt).toDateString() === new Date(endsAt).toDateString()
  if (sameDay) return `${eventWhenText(startsAt)} – ${timeOf(endsAt)}`
  return `${eventWhenText(startsAt)} → ${eventWhenText(endsAt)}`
}

export function eventLocationText(e: KeepEvent, channels: KeepChannel[]): string {
  if (e.location_kind === 'voice') {
    return channels.find((c) => c.id === e.channel_id)?.name ?? 'voice channel'
  }
  return e.location_text || 'Somewhere else'
}

/** Whether an event is over: past its end time (or, if open-ended, >3h after start). */
export function eventEnded(e: KeepEvent): boolean {
  const over = e.ends_at > 0 ? e.ends_at : e.starts_at + 3 * 60 * 60 * 1000
  return Date.now() > over
}

/** Events sorted soonest-first, dropping ones that have ended. */
export function upcomingEvents(events: KeepEvent[] | undefined): KeepEvent[] {
  if (!events) return []
  return [...events].filter((e) => !eventEnded(e)).sort((a, b) => a.starts_at - b.starts_at)
}

/** The single most relevant event to show as a "soon" banner, if any. */
export function soonEvent(events: KeepEvent[] | undefined): KeepEvent | null {
  const up = upcomingEvents(events)
  const first = up[0]
  if (!first) return null
  return first.starts_at - Date.now() <= SOON_WINDOW_MS ? first : null
}
