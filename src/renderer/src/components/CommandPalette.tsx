import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CornerDownLeft,
  Hash,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  Users,
  Volume2
} from 'lucide-react'
import { hostTag } from '@/lib/relic'
import { useUi, useWorld } from '@/store'

interface Entry {
  id: string
  label: string
  sub: string
  icon: React.ReactNode
  perform: () => void
}

interface Scored {
  entry: Entry
  score: number
  indices: number[]
}

/** Subsequence fuzzy match: word-start and run bonuses, null on miss. */
function fuzzy(query: string, text: string): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const indices: number[] = []
  let qi = 0
  let score = 0
  let last = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti)
      score += last === ti - 1 ? 3 : 1
      if (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '-' || t[ti - 1] === '#') score += 2
      last = ti
      qi++
    }
  }
  return qi === q.length ? { score, indices } : null
}

function Highlight({ text, indices }: { text: string; indices: number[] }): React.JSX.Element {
  const set = new Set(indices)
  return (
    <>
      {text.split('').map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="font-semibold text-[var(--accent)]">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        )
      )}
    </>
  )
}

export function CommandPalette(): React.JSX.Element | null {
  const {
    paletteOpen,
    closePalette,
    setServer,
    setChannel,
    joinVoice,
    muted,
    deafened,
    toggleMute,
    toggleDeafen,
    toggleMembers,
    voiceChannelId,
    disconnectVoice,
    connections
  } = useUi()
  const { instances, servers } = useWorld()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const entries = useMemo<Entry[]>(() => {
    // channels across every connected keep — the palette is cross-instance
    const channelEntries: Entry[] = servers.flatMap((sv) => {
      const world = connections[sv.instanceId]?.world
      if (!world) return []
      return world.channels.map((ch) => ({
        id: `ch-${sv.id}-${ch.id}`,
        label: ch.kind === 'voice' ? ch.name : `# ${ch.name}`,
        sub: sv.name,
        icon:
          ch.kind === 'voice' ? (
            <Volume2 size={15} className="text-pulse" />
          ) : (
            <Hash size={15} className="text-lo" />
          ),
        perform: () => {
          setServer(sv.id)
          if (ch.kind === 'voice') joinVoice(String(ch.id))
          else setChannel(String(ch.id))
        }
      }))
    })

    const serverEntries: Entry[] = servers.map((s) => {
      const inst = instances.find((i) => i.id === s.instanceId)
      return {
        id: `sv-${s.id}`,
        label: `Go to ${s.name}`,
        sub: (inst ? hostTag(inst.domain) : '') + (inst && !inst.online ? ' · offline' : ''),
        icon: (
          <span
            className="flex h-[18px] w-[18px] items-center justify-center rounded-md font-display text-[9px] font-bold text-void-0"
            style={{ background: s.accent }}
          >
            {s.abbr}
          </span>
        ),
        perform: () => setServer(s.id)
      }
    })

    const actionEntries: Entry[] = [
      {
        id: 'act-mute',
        label: muted ? 'Unmute microphone' : 'Mute microphone',
        sub: 'Ctrl+Shift+M',
        icon: muted ? <Mic size={15} className="text-pulse" /> : <MicOff size={15} className="text-ember" />,
        perform: toggleMute
      },
      {
        id: 'act-deafen',
        label: deafened ? 'Undeafen' : 'Deafen',
        sub: 'Ctrl+Shift+D',
        icon: <Headphones size={15} className={deafened ? 'text-pulse' : 'text-ember'} />,
        perform: toggleDeafen
      },
      {
        id: 'act-members',
        label: 'Toggle members list',
        sub: 'View',
        icon: <Users size={15} className="text-abyss" />,
        perform: toggleMembers
      },
      ...(voiceChannelId
        ? [
            {
              id: 'act-disconnect',
              label: 'Disconnect from voice',
              sub: 'Voice',
              icon: <PhoneOff size={15} className="text-ember" />,
              perform: disconnectVoice
            }
          ]
        : [])
    ]

    return [...channelEntries, ...serverEntries, ...actionEntries]
  }, [servers, instances, connections, muted, deafened, voiceChannelId, setServer, setChannel, joinVoice, toggleMute, toggleDeafen, toggleMembers, disconnectVoice])

  const results = useMemo<Scored[]>(() => {
    const scored: Scored[] = []
    for (const entry of entries) {
      const m = fuzzy(query.trim(), entry.label)
      if (m) scored.push({ entry, score: m.score, indices: m.indices })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 10)
  }, [entries, query])

  useEffect(() => {
    if (paletteOpen) {
      setQuery('')
      setSelected(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [paletteOpen])

  useEffect(() => setSelected(0), [query])

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (!paletteOpen) return null

  const run = (s: Scored): void => {
    s.entry.perform()
    closePalette()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (results[selected]) run(results[selected])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closePalette()
    }
  }

  return (
    <div
      className="absolute inset-0 z-[100] flex items-start justify-center bg-void-0/60 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={closePalette}
    >
      <div
        className="glass palette-in w-[560px] overflow-hidden rounded-2xl shadow-[0_24px_80px_-12px_rgba(0,0,0,0.8),0_0_40px_-18px_var(--accent)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-edge px-4 py-3.5">
          <span className="text-[15px] text-relic" style={{ textShadow: '0 0 12px rgba(139,124,246,0.7)' }}>
            ◆
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a channel, join voice, run an action…"
            className="min-w-0 flex-1 bg-transparent text-[14.5px] text-hi outline-none select-text placeholder:text-lo"
          />
          <kbd className="rounded border border-edge bg-void-3 px-1.5 py-px font-mono text-[10px] text-lo">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[340px] overflow-y-auto p-2 scroll-thin">
          {results.length === 0 ? (
            <div className="px-3 py-8 text-center text-[13px] text-lo">
              Nothing matches <span className="text-mid">“{query}”</span> — yet.
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.entry.id}
                data-selected={i === selected}
                onMouseEnter={() => setSelected(i)}
                onClick={() => run(r)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-75"
                style={
                  i === selected
                    ? { background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }
                    : undefined
                }
              >
                <span className="flex w-5 shrink-0 justify-center">{r.entry.icon}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-hi">
                  <Highlight text={r.entry.label} indices={r.indices} />
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-lo">{r.entry.sub}</span>
                {i === selected && <CornerDownLeft size={13} className="shrink-0 text-mid" />}
              </button>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-edge px-4 py-2 font-mono text-[10px] text-lo">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span className="ml-auto">searching all connected keeps</span>
        </div>
      </div>
    </div>
  )
}
