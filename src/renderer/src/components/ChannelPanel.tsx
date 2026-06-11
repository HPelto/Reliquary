import { useEffect, useState } from 'react'
import {
  Bell,
  BellOff,
  ChevronDown,
  Hash,
  Headphones,
  Lock,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Settings,
  Volume2
} from 'lucide-react'
import { CalendarClock, CalendarDays } from 'lucide-react'
import { hostTag } from '@/lib/relic'
import { DEFAULT_NAME_COLOR, nameColorFor } from '@/lib/nameStyle'
import { getChannelPrefs, setChannelPrefs, type ChannelPrefs } from '@/lib/notifications'
import {
  eventLocationText,
  soonEvent,
  startsInText,
  upcomingEvents
} from '@/lib/events'
import type { KeepChannel, KeepMember } from '@/net/keep'
import { useUi, useWorld, type KeepState } from '@/store'
import type { VoiceParticipant } from '@/net/voice'
import { KeepAvatar, SelfAvatar } from './KeepAvatar'
import { ServerMenu } from './ServerMenu'
import { StyledName } from './StyledName'

/** A "starting soon" event banner when one is imminent, otherwise a compact
 *  "Events" button — both sit above the channel list. */
function EventStrip({
  keep,
  channels
}: {
  keep: KeepState | undefined
  channels: KeepChannel[]
}): React.JSX.Element | null {
  const openEvents = useUi((s) => s.openEvents)
  const events = keep?.world?.events
  // re-render each minute so the countdown + soon-window stay fresh
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 60000)
    return () => clearInterval(t)
  }, [])

  const upcoming = upcomingEvents(events)
  if (upcoming.length === 0) return null
  const soon = soonEvent(events)

  if (soon) {
    return (
      <button
        onClick={openEvents}
        className="mx-2 mt-2 flex items-center gap-3 overflow-hidden rounded-xl border border-relic/30 bg-relic/10 p-2 text-left transition-colors hover:border-relic/50"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-relic/20 text-relic">
          <CalendarClock size={17} />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[12.5px] font-semibold text-hi">{soon.title}</span>
          <span className="block truncate text-[10.5px] text-relic">
            {startsInText(soon.starts_at)} · {eventLocationText(soon, channels)}
          </span>
        </span>
      </button>
    )
  }

  return (
    <button
      onClick={openEvents}
      className="mx-2 mt-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-mid transition-colors hover:bg-void-2 hover:text-hi"
    >
      <CalendarDays size={15} />
      Events
      <span className="ml-auto rounded-full bg-void-3 px-1.5 font-mono text-[10px] text-lo">
        {upcoming.length}
      </span>
    </button>
  )
}

const NOTIF_OPTS: { key: ChannelPrefs['level']; label: string }[] = [
  { key: 'inherit', label: 'Use server default' },
  { key: 'all', label: 'All messages' },
  { key: 'mentions', label: 'Only @mentions' },
  { key: 'nothing', label: 'Nothing' }
]

function TextChannelRow({
  id,
  name,
  instanceId
}: {
  id: string
  name: string
  instanceId: string
}): React.JSX.Element {
  const { activeChannelId, setChannel } = useUi()
  const active = id === activeChannelId
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [level, setLevel] = useState<ChannelPrefs['level']>(
    () => getChannelPrefs(instanceId, id).level
  )

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [menu])

  const muted = level === 'nothing'
  const overridden = level !== 'inherit'

  return (
    <>
      <button
        onClick={() => setChannel(id)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        className={`group relative flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-[13px] transition-colors duration-150 ${
          active ? 'bg-void-3 text-hi' : 'text-lo hover:bg-void-2 hover:text-mid'
        } ${muted ? 'opacity-60' : ''}`}
      >
        {active && (
          <span className="absolute top-1/2 -left-2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--accent)]" />
        )}
        <Hash size={15} className="shrink-0 opacity-70" />
        <span className="truncate">{name}</span>
        {muted ? (
          <BellOff size={12} className="ml-auto shrink-0 text-lo" />
        ) : overridden ? (
          <Bell size={12} className="ml-auto shrink-0 text-lo opacity-60" />
        ) : null}
      </button>

      {menu && (
        <div
          className="glass palette-in fixed z-[200] w-[190px] rounded-xl p-1.5 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]"
          style={{ left: Math.min(menu.x, window.innerWidth - 200), top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-2.5 py-1 text-[10px] font-semibold tracking-[0.12em] text-lo uppercase">
            Notifications
          </div>
          {NOTIF_OPTS.map((o) => (
            <button
              key={o.key}
              onClick={() => {
                setChannelPrefs(instanceId, id, { level: o.key })
                setLevel(o.key)
                setMenu(null)
              }}
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors hover:bg-void-3 ${
                level === o.key ? 'text-hi' : 'text-mid'
              }`}
            >
              {o.label}
              {level === o.key && <span className="h-1.5 w-1.5 rounded-full bg-relic" />}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

const NO_PARTICIPANTS: VoiceParticipant[] = []

/** A single person sitting in a voice channel — avatar with a speaking ring,
 *  their styled name, and mute/deafen indicators. */
function VoiceOccupant({
  p,
  member,
  instanceId,
  locked,
  speaking
}: {
  p: VoiceParticipant
  member: KeepMember | undefined
  instanceId: string
  locked: boolean
  speaking: boolean
}): React.JSX.Element {
  const viewUser = useUi((s) => s.viewUser)
  const name = member?.username ?? 'someone'
  return (
    <button
      onClick={() => member && viewUser(member.id)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-[3px] text-left transition-colors hover:bg-void-2"
    >
      <span
        className="shrink-0 rounded-full transition-shadow duration-150"
        style={speaking ? { boxShadow: '0 0 0 2px var(--color-pulse), 0 0 8px var(--color-pulse)' } : undefined}
      >
        <KeepAvatar
          instanceId={instanceId}
          avatar={member?.avatar ?? ''}
          name={name}
          accent={member?.accent ?? '#aab1c0'}
          size={20}
        />
      </span>
      <StyledName
        name={name}
        color={member ? nameColorFor(member, locked) : 'var(--color-lo)'}
        font={locked || !member ? 'default' : member.name_font}
        effect={locked || !member ? 'none' : member.name_effect}
        mode="static"
        className={`truncate text-[12px] ${speaking ? 'text-hi' : 'text-mid'}`}
      />
      <span className="ml-auto flex shrink-0 items-center gap-1 text-lo">
        {p.deafened ? (
          <Headphones size={12} className="text-ember" />
        ) : p.muted ? (
          <MicOff size={12} className="text-ember" />
        ) : null}
      </span>
    </button>
  )
}

function VoiceChannelRow({
  id,
  name,
  instanceId,
  members,
  locked
}: {
  id: string
  name: string
  instanceId: string
  members: KeepMember[]
  locked: boolean
}): React.JSX.Element {
  const { voiceChannelId, voiceInstanceId, joinVoice } = useUi()
  const connected = voiceChannelId === id && voiceInstanceId === instanceId
  const participants = useUi((s) => s.voiceParticipants[`${instanceId}:${id}`]) ?? NO_PARTICIPANTS
  const speaking = useUi((s) => s.voiceSpeaking)

  return (
    <div>
      <button
        onClick={() => joinVoice(id)}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-[13px] transition-colors duration-150 ${
          connected ? 'text-pulse' : 'text-lo hover:bg-void-2 hover:text-mid'
        }`}
      >
        <Volume2 size={15} className="shrink-0 opacity-80" />
        <span className="truncate">{name}</span>
        {participants.length > 0 && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-lo">{participants.length}</span>
        )}
      </button>
      {participants.length > 0 && (
        <div className="mt-px mb-1 flex flex-col gap-px pl-3">
          {participants.map((p) => (
            <VoiceOccupant
              key={p.userId}
              p={p}
              member={members.find((m) => m.id === p.userId)}
              instanceId={instanceId}
              locked={locked}
              // only the call we're actually in carries live speaking info
              speaking={connected && speaking.includes(p.userId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function VoiceDock({ channelName }: { channelName: string }): React.JSX.Element | null {
  const { voiceChannelId, voiceStatus, voicePing, muted, deafened, toggleMute, toggleDeafen, disconnectVoice } =
    useUi()
  if (!voiceChannelId) return null

  // header reflects the real WebRTC connection lifecycle
  const head =
    voiceStatus === 'connected'
      ? { dot: 'bg-pulse shadow-[0_0_6px_var(--color-pulse)]', text: 'text-pulse', label: 'Voice connected' }
      : voiceStatus === 'failed'
        ? { dot: 'bg-ember', text: 'text-ember', label: 'Connection failed' }
        : { dot: 'reconnecting bg-gold', text: 'text-gold', label: 'Connecting…' }

  return (
    <div className="glass mx-2 mb-2 rounded-xl p-2.5">
      <div className="min-w-0">
        <div className={`flex items-center gap-1.5 text-[12px] font-medium ${head.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${head.dot}`} />
          {head.label}
        </div>
        <div className="truncate text-[11.5px] text-lo">
          {channelName}
          {voiceStatus === 'connected' && (
            <>
              {' · '}
              <span className="font-mono text-pulse/80">{voicePing}ms</span>
            </>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1">
        <button
          onClick={toggleMute}
          title="Mute · Ctrl+Shift+M"
          className={`flex h-7 flex-1 items-center justify-center rounded-md transition-colors duration-150 ${
            muted ? 'bg-ember/20 text-ember' : 'bg-void-3/60 text-mid hover:bg-void-3 hover:text-hi'
          }`}
        >
          {muted ? <MicOff size={15} /> : <Mic size={15} />}
        </button>
        <button
          onClick={toggleDeafen}
          title="Deafen · Ctrl+Shift+D"
          className={`flex h-7 flex-1 items-center justify-center rounded-md transition-colors duration-150 ${
            deafened ? 'bg-ember/20 text-ember' : 'bg-void-3/60 text-mid hover:bg-void-3 hover:text-hi'
          }`}
        >
          <Headphones size={15} />
        </button>
        <button
          disabled
          title="Screen share — coming soon"
          className="flex h-7 flex-1 cursor-not-allowed items-center justify-center rounded-md bg-void-3/40 text-lo/50"
        >
          <MonitorUp size={15} />
        </button>
        <button
          onClick={disconnectVoice}
          title="Disconnect"
          className="flex h-7 flex-1 items-center justify-center rounded-md bg-void-3/60 text-mid transition-colors duration-150 hover:bg-ember/20 hover:text-ember"
        >
          <PhoneOff size={15} />
        </button>
      </div>
    </div>
  )
}

export function ChannelPanel(): React.JSX.Element | null {
  const {
    activeServerId,
    collapsed,
    toggleCategory,
    identity,
    connections,
    voiceChannelId,
    voiceInstanceId,
    openSettings,
    profile
  } = useUi()
  const { instances, servers } = useWorld()
  const [menuOpen, setMenuOpen] = useState(false)
  const server = servers.find((s) => s.id === activeServerId)
  if (!server) return null
  const instance = instances.find((i) => i.id === server.instanceId)
  const keep = connections[server.instanceId]
  const channels = keep?.world?.channels ?? []

  const cats = [
    {
      id: 'text',
      name: 'Text Channels',
      channels: channels.filter((c) => c.kind === 'text')
    },
    {
      id: 'voice',
      name: 'Voice Channels',
      channels: channels.filter((c) => c.kind === 'voice')
    }
  ].filter((c) => c.channels.length > 0)

  // the call is global — resolve its channel name from the Keep it's actually on
  const voiceChannel = voiceInstanceId
    ? connections[voiceInstanceId]?.world?.channels.find((c) => String(c.id) === voiceChannelId)
    : undefined
  const canManage = keep?.self?.role === 'owner' || keep?.self?.role === 'admin'

  return (
    <aside className="z-10 flex w-[264px] shrink-0 flex-col bg-void-1">
      {/* server header — click to open the server menu */}
      <header
        className="relative border-b border-edge px-4 pt-4 pb-3"
        style={{
          background: `linear-gradient(180deg, color-mix(in srgb, var(--accent) 14%, transparent), transparent)`
        }}
      >
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-md text-left transition-colors"
        >
          <h1 className="font-display text-[15.5px] font-bold tracking-tight">{server.name}</h1>
          <ChevronDown
            size={15}
            className={`text-lo transition-transform duration-200 ${menuOpen ? 'rotate-180' : ''}`}
          />
        </button>
        <ServerMenu open={menuOpen} onClose={() => setMenuOpen(false)} canManage={canManage} />
        <div className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-lo">
          <Lock size={10} className="text-pulse" />
          {/* never the real address on a normal screen — that lives in server settings */}
          <span>◆ {instance ? hostTag(instance.domain) : ''}</span>
          <span className="rounded border border-gold/30 bg-gold/10 px-1 text-[9px] tracking-wide text-gold">
            SELF-HOSTED
          </span>
        </div>
        {keep && (
          <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px]">
            {keep.status === 'online' ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-pulse shadow-[0_0_6px_var(--color-pulse)]" />
                <span className="text-pulse">live · {keep.ping}ms</span>
              </>
            ) : keep.status === 'offline' ? (
              <>
                <span className="reconnecting h-1.5 w-1.5 rounded-full bg-ember" />
                <span className="text-ember">reconnecting…</span>
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-gold" />
                <span className="text-gold">connecting…</span>
              </>
            )}
          </div>
        )}
      </header>

      {/* events: a "soon" banner takes priority, else a compact button */}
      <EventStrip keep={keep} channels={channels} />

      {/* channels */}
      <div className="flex-1 overflow-y-auto px-2 py-3 scroll-thin">
        {cats.map((cat) => (
          <div key={cat.id} className="mb-3">
            <button
              onClick={() => toggleCategory(cat.id)}
              className="mb-1 flex w-full items-center gap-1 px-2 text-[10.5px] font-semibold tracking-[0.12em] text-lo uppercase transition-colors hover:text-mid"
            >
              <ChevronDown
                size={11}
                className={`transition-transform duration-200 ${collapsed[cat.id] ? '-rotate-90' : ''}`}
              />
              {cat.name}
            </button>
            {!collapsed[cat.id] && (
              <div className="flex flex-col gap-px">
                {cat.channels.map((ch) =>
                  ch.kind === 'voice' ? (
                    <VoiceChannelRow
                      key={ch.id}
                      id={String(ch.id)}
                      name={ch.name}
                      instanceId={server.instanceId}
                      members={keep?.world?.members ?? []}
                      locked={!!keep?.world?.lock_name_style}
                    />
                  ) : (
                    <TextChannelRow
                      key={ch.id}
                      id={String(ch.id)}
                      name={ch.name}
                      instanceId={server.instanceId}
                    />
                  )
                )}
              </div>
            )}
          </div>
        ))}
        {channels.length === 0 && (
          <p className="px-2 font-mono text-[11px] text-lo">syncing channels…</p>
        )}
      </div>

      <VoiceDock channelName={voiceChannel?.name ?? 'voice'} />

      {/* self strip */}
      <footer className="flex items-center gap-2 border-t border-edge bg-void-0/60 px-2.5 py-2">
        <SelfAvatar
          dataUrl={profile.avatar?.dataUrl}
          name={identity?.name ?? '◆'}
          accent={identity?.accent ?? '#8b7cf6'}
          size={28}
        />
        <div className="group min-w-0 flex-1 leading-tight">
          {/* your own name shows your style locally — hover the strip to animate */}
          <StyledName
            name={identity?.name ?? '—'}
            color={profile.nameColor || DEFAULT_NAME_COLOR}
            font={profile.nameFont}
            effect={profile.nameEffect}
            mode="hover"
            className="truncate text-[12.5px] font-medium"
          />
          <div className="truncate text-[10px] text-lo" title={identity?.fingerprint}>
            {profile.status || `◆ ${identity?.fingerprint ?? ''}`}
          </div>
        </div>
        <button
          onClick={openSettings}
          title="Settings · Ctrl+,"
          className="rounded-md p-1.5 text-lo transition-colors hover:bg-void-3 hover:text-hi"
        >
          <Settings size={15} />
        </button>
      </footer>
    </aside>
  )
}
