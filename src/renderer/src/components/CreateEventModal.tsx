import { useEffect, useState } from 'react'
import { CalendarPlus, Globe, ImagePlus, Loader2, MapPin, Trash2, Volume2 } from 'lucide-react'
import { fileToMediaRef, type MediaRef } from '@/lib/profile'
import { eventRangeText } from '@/lib/events'
import { getKeep } from '@/net/bind'
import { useUi, useWorld } from '@/store'

type Step = 'location' | 'info' | 'review'
type Kind = 'voice' | 'other'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function CreateEventModal(): React.JSX.Element | null {
  const { createEventOpen, closeCreateEvent, activeServerId, connections } = useUi()
  const { servers } = useWorld()
  const server = servers.find((s) => s.id === activeServerId)
  const keep = server?.real ? connections[server.instanceId] : undefined
  const conn = server?.real ? getKeep(server.instanceId) : undefined
  const canManage = keep?.self?.role === 'owner' || keep?.self?.role === 'admin'
  const voiceChannels = (keep?.world?.channels ?? []).filter((c) => c.kind === 'voice')

  const [step, setStep] = useState<Step>('location')
  const [kind, setKind] = useState<Kind>('voice')
  const [channelId, setChannelId] = useState<number | null>(null)
  const [locationText, setLocationText] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [endDate, setEndDate] = useState('')
  const [endTime, setEndTime] = useState('')
  const [frequency, setFrequency] = useState('once')
  const [cover, setCover] = useState<MediaRef | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (createEventOpen) {
      const start = new Date(Date.now() + 60 * 60 * 1000)
      const end = new Date(start.getTime() + 60 * 60 * 1000)
      const dStr = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const tStr = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`
      setStep('location')
      setKind(voiceChannels.length > 0 ? 'voice' : 'other')
      setChannelId(voiceChannels[0]?.id ?? null)
      setLocationText('')
      setTitle('')
      setDescription('')
      setDate(dStr(start))
      setTime(tStr(start))
      setEndDate(dStr(end))
      setEndTime(tStr(end))
      setFrequency('once')
      setCover(undefined)
      setError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createEventOpen])

  useEffect(() => {
    if (!createEventOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeCreateEvent()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [createEventOpen, closeCreateEvent])

  if (!createEventOpen || !server?.real || !conn || !canManage) return null

  const startsAt = date && time ? new Date(`${date}T${time}`).getTime() : 0
  const endsAt = endDate && endTime ? new Date(`${endDate}T${endTime}`).getTime() : 0

  const pickCover = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      setCover(await fileToMediaRef(file))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that image.')
    }
  }

  const canNextLocation = kind === 'voice' ? channelId !== null : locationText.trim().length > 0
  const endValid = endsAt === 0 || endsAt > startsAt
  const canNextInfo = title.trim().length >= 1 && startsAt > 0 && endValid

  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (cover) await conn.uploadMedia(cover)
      await conn.createEvent({
        title: title.trim(),
        description: description.trim(),
        location_kind: kind,
        channel_id: kind === 'voice' ? (channelId ?? 0) : 0,
        location_text: kind === 'other' ? locationText.trim() : '',
        cover: cover?.hash ?? '',
        starts_at: startsAt,
        ends_at: endsAt,
        frequency
      })
      closeCreateEvent()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the event.')
      setBusy(false)
    }
  }

  const steps: Step[] = ['location', 'info', 'review']
  const input =
    'w-full rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[13.5px] text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-relic/50'

  return (
    <div
      className="absolute inset-0 z-[100] flex items-start justify-center bg-void-0/60 pt-[8vh] backdrop-blur-[2px]"
      onMouseDown={closeCreateEvent}
    >
      <div
        className="glass palette-in flex max-h-[82vh] w-[500px] flex-col overflow-hidden rounded-2xl shadow-[0_24px_80px_-12px_rgba(0,0,0,0.8),0_0_40px_-18px_var(--accent)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* step progress */}
        <div className="flex items-center gap-2 px-5 pt-4">
          {steps.map((s) => (
            <div
              key={s}
              className={`h-1 flex-1 rounded-full transition-colors ${
                steps.indexOf(s) <= steps.indexOf(step) ? 'bg-relic' : 'bg-void-3'
              }`}
            />
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 scroll-thin">
          {step === 'location' && (
            <>
              <h2 className="font-display text-[19px] font-bold tracking-tight">Where is your event?</h2>
              <p className="mt-1 text-[12.5px] text-mid">So everyone knows where to show up.</p>

              <div className="mt-5 flex flex-col gap-2">
                <button
                  onClick={() => setKind('voice')}
                  disabled={voiceChannels.length === 0}
                  className={`flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors disabled:opacity-40 ${
                    kind === 'voice' ? 'border-relic/60 bg-relic/10' : 'border-edge bg-void-0/50 hover:border-relic/30'
                  }`}
                >
                  <Volume2 size={17} className="mt-0.5 text-pulse" />
                  <span>
                    <span className="block text-[13.5px] font-medium text-hi">Voice Channel</span>
                    <span className="block text-[11.5px] text-lo">
                      {voiceChannels.length ? 'Hang out with voice on this Keep' : 'No voice channels yet'}
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => setKind('other')}
                  className={`flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
                    kind === 'other' ? 'border-relic/60 bg-relic/10' : 'border-edge bg-void-0/50 hover:border-relic/30'
                  }`}
                >
                  <MapPin size={17} className="mt-0.5 text-gold" />
                  <span>
                    <span className="block text-[13.5px] font-medium text-hi">Somewhere else</span>
                    <span className="block text-[11.5px] text-lo">An external link or a place</span>
                  </span>
                </button>
              </div>

              {kind === 'voice' ? (
                <div className="mt-4">
                  <label className="text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                    Channel
                  </label>
                  <select
                    value={channelId ?? ''}
                    onChange={(e) => setChannelId(Number(e.target.value))}
                    className={`${input} mt-1.5`}
                  >
                    {voiceChannels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="mt-4">
                  <label className="text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                    Location
                  </label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Globe size={15} className="shrink-0 text-lo" />
                    <input
                      value={locationText}
                      onChange={(e) => setLocationText(e.target.value)}
                      placeholder="A link, address, or place"
                      maxLength={200}
                      className={input}
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {step === 'info' && (
            <>
              <h2 className="font-display text-[19px] font-bold tracking-tight">What&apos;s it about?</h2>
              <p className="mt-1 text-[12.5px] text-mid">Fill out the details.</p>

              <label className="mt-5 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                Event topic <span className="text-ember">*</span>
              </label>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What's your event?"
                maxLength={100}
                className={`${input} mt-1.5`}
              />

              <div className="mt-4 flex gap-3">
                <div className="flex-1">
                  <label className="block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                    Start date <span className="text-ember">*</span>
                  </label>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${input} mt-1.5`} />
                </div>
                <div className="w-[130px]">
                  <label className="block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                    Time <span className="text-ember">*</span>
                  </label>
                  <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`${input} mt-1.5`} />
                </div>
              </div>

              <div className="mt-3 flex gap-3">
                <div className="flex-1">
                  <label className="block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                    End date
                  </label>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={`${input} mt-1.5`} />
                </div>
                <div className="w-[130px]">
                  <label className="block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                    Time
                  </label>
                  <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={`${input} mt-1.5`} />
                </div>
              </div>
              {!endValid && (
                <p className="mt-1.5 text-[11.5px] text-ember">The event must end after it starts.</p>
              )}

              <label className="mt-4 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                Frequency
              </label>
              <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className={`${input} mt-1.5`}>
                <option value="once">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>

              <label className="mt-4 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Tell people a little more…"
                className={`${input} mt-1.5 resize-none`}
              />

              <label className="mt-4 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                Cover image
              </label>
              <div className="mt-1.5 flex gap-2">
                <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-edge bg-void-0/70 py-2 text-[12.5px] text-mid transition-colors hover:border-relic/40 hover:text-hi">
                  <ImagePlus size={14} />
                  {cover ? 'Replace cover' : 'Upload cover'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    hidden
                    onChange={(e) => void pickCover(e)}
                  />
                </label>
                {cover && (
                  <button
                    onClick={() => setCover(undefined)}
                    className="rounded-xl border border-edge px-2.5 text-lo transition-colors hover:border-ember/40 hover:text-ember"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </>
          )}

          {step === 'review' && (
            <>
              <h2 className="font-display text-[19px] font-bold tracking-tight">Preview</h2>
              <p className="mt-1 text-[12.5px] text-mid">This is how your event will look.</p>

              <div className="mt-4 overflow-hidden rounded-2xl border border-edge bg-void-1">
                <div
                  className="h-28 bg-void-3"
                  style={
                    cover?.dataUrl
                      ? { backgroundImage: `url(${cover.dataUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                      : { background: 'linear-gradient(120deg, color-mix(in srgb, var(--accent) 45%, #0c0e14), #0c0e14)' }
                  }
                />
                <div className="p-3.5">
                  <div className="font-mono text-[11px] text-relic">{eventRangeText(startsAt, endsAt)}</div>
                  <div className="mt-0.5 font-display text-[16px] font-bold">{title || 'Untitled event'}</div>
                  {description && <div className="mt-0.5 text-[12px] text-mid">{description}</div>}
                  <div className="mt-2 flex items-center gap-1.5 border-t border-edge pt-2 text-[12px] text-lo">
                    {kind === 'voice' ? <Volume2 size={13} /> : <MapPin size={13} />}
                    {kind === 'voice'
                      ? voiceChannels.find((c) => c.id === channelId)?.name ?? 'voice'
                      : locationText || 'Somewhere else'}
                  </div>
                </div>
              </div>
            </>
          )}

          {error && <p className="mt-3 text-[12px] text-ember">{error}</p>}
        </div>

        {/* footer nav */}
        <div className="flex items-center justify-between border-t border-edge px-5 py-3.5">
          <button
            onClick={() => {
              if (step === 'location') closeCreateEvent()
              else setStep(step === 'review' ? 'info' : 'location')
            }}
            className="rounded-xl px-3 py-2 text-[13px] text-mid transition-colors hover:text-hi"
          >
            {step === 'location' ? 'Cancel' : 'Back'}
          </button>
          {step === 'review' ? (
            <button
              onClick={() => void create()}
              disabled={busy}
              className="flex items-center gap-2 rounded-xl bg-gold px-5 py-2 font-display text-[13.5px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_24px_rgba(232,201,122,0.45)] disabled:opacity-40"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <CalendarPlus size={15} />}
              Create Event
            </button>
          ) : (
            <button
              onClick={() => setStep(step === 'location' ? 'info' : 'review')}
              disabled={step === 'location' ? !canNextLocation : !canNextInfo}
              className="rounded-xl bg-relic px-5 py-2 font-display text-[13.5px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_24px_rgba(139,124,246,0.45)] disabled:opacity-30"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
