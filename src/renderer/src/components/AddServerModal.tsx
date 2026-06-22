import { useEffect, useRef, useState } from 'react'
import { Check, Globe, KeyRound, Loader2, Lock, ShieldAlert, X } from 'lucide-react'
import { loadProfile } from '@/lib/profile'
import { accentFor, hostTag, parseAddress, type RelicTarget } from '@/lib/relic'
import { upsertWorld } from '@/lib/worlds'
import { createKeep, dropKeep, getKeep } from '@/net/bind'
import { KeepError, type KeepDiscovery, type KeepWorld } from '@/net/keep'
import { useUi } from '@/store'

type Stage = 'idle' | 'resolving' | 'securing' | 'keep-password' | 'fetching' | 'preview'

const STAGES: { key: Stage; label: string }[] = [
  { key: 'resolving', label: 'Resolving address' },
  { key: 'securing', label: 'Securing connection' },
  { key: 'fetching', label: 'Fetching world' }
]

function securityBadge(t: RelicTarget): { icon: React.ReactNode; label: string; cls: string } {
  if (t.fingerprint)
    return {
      icon: <KeyRound size={12} />,
      label: 'Pinned key from invite',
      cls: 'border-pulse/30 bg-pulse/10 text-pulse'
    }
  if (t.source === 'ip')
    return {
      icon: <ShieldAlert size={12} />,
      label: 'First connection â€” trust on first use',
      cls: 'border-gold/30 bg-gold/10 text-gold'
    }
  return {
    icon: <Lock size={12} />,
    label: 'TLS Â· certificate verified',
    cls: 'border-pulse/30 bg-pulse/10 text-pulse'
  }
}

function JoinTab(): React.JSX.Element {
  const joinWorld = useUi((s) => s.joinWorld)
  const setChannel = useUi((s) => s.setChannel)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('idle')
  const [target, setTarget] = useState<RelicTarget | null>(null)
  const [disc, setDisc] = useState<KeepDiscovery | null>(null)
  const [world, setWorld] = useState<KeepWorld | null>(null)
  const [keepPw, setKeepPw] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const enteredRef = useRef(false)
  const instanceIdRef = useRef<string | null>(null)

  useEffect(() => inputRef.current?.focus(), [])

  // if the modal closes mid-handshake without joining, tear the socket down
  useEffect(
    () => () => {
      if (!enteredRef.current && instanceIdRef.current) dropKeep(instanceIdRef.current)
    },
    []
  )

  const begin = async (): Promise<void> => {
    const parsed = await parseAddress(input)
    if (!parsed) {
      setError("That doesn't look like an address. Try a relic:// link, a REL3 code, a domain, or an IP like 203.0.113.7:7777.")
      return
    }
    const { identity, unlockedKey } = useUi.getState()
    if (!identity || !unlockedKey) {
      setError('Your relic key is locked â€” restart the app and unlock it first.')
      return
    }
    setError(null)
    setTarget(parsed)

    const instanceId = `inst-${parsed.host}`
    instanceIdRef.current = instanceId
    const conn = createKeep(instanceId, `joined-${parsed.host}`, parsed)
    try {
      setStage('resolving')
      const d = await conn.discover()
      setDisc(d)
      await secure(parsed, '')
    } catch (e) {
      dropKeep(instanceId)
      instanceIdRef.current = null
      setStage('idle')
      setError(e instanceof Error ? e.message : 'Connection failed.')
    }
  }

  /** Handshake + world fetch; pauses on the keep-password gate if the host enabled one. */
  const secure = async (parsed: RelicTarget, keepPassword: string): Promise<void> => {
    const { identity, unlockedKey } = useUi.getState()
    const conn = getKeep(instanceIdRef.current!)
    if (!conn || !identity || !unlockedKey) throw new Error('connection lost')
    setStage('securing')
    try {
      const profile = loadProfile()
      const user = await conn.handshake(
        { pub: identity.pub, name: identity.name, accent: identity.accent },
        unlockedKey,
        { invite: parsed.token, keepPassword: keepPassword || undefined, profile }
      )
      useUi.getState().setKeep(instanceIdRef.current!, { self: user })
      await conn.ensureMedia(profile).catch(() => {})
    } catch (e) {
      if (e instanceof KeepError && e.code === 'keep_password_required') {
        setPwError(keepPassword ? 'Wrong keep password.' : null)
        setStage('keep-password')
        return
      }
      throw e
    }
    setStage('fetching')
    const w = await conn.fetchWorld()
    setWorld(w)
    setStage('preview')
  }

  const submitKeepPassword = async (): Promise<void> => {
    if (!target || !keepPw) return
    try {
      await secure(target, keepPw)
    } catch (e) {
      if (instanceIdRef.current) dropKeep(instanceIdRef.current)
      instanceIdRef.current = null
      setStage('idle')
      setError(e instanceof Error ? e.message : 'Connection failed.')
    }
  }

  const enter = (): void => {
    if (!target || !world || !instanceIdRef.current) return
    const instanceId = instanceIdRef.current
    enteredRef.current = true
    getKeep(instanceId)?.openGateway()
    const abbr = world.name
      .split(/[\s-]+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase()
    const accent = accentFor(target.host)
    joinWorld(
      { id: instanceId, domain: target.host, online: true },
      { id: `joined-${target.host}`, instanceId, name: world.name, abbr, accent, real: true }
    )
    // persist so the client reconnects on every launch (no tokens stored â€”
    // the unlocked relic key re-handshakes)
    upsertWorld({
      v: 1,
      instanceId,
      serverId: `joined-${target.host}`,
      host: target.host,
      port: target.port,
      secure: target.secure,
      name: world.name,
      abbr,
      accent,
      keepPassword: keepPw || undefined
    })
    const firstText = world.channels.find((c) => c.kind === 'text')
    if (firstText) setChannel(String(firstText.id))
  }

  const ping = getKeep(instanceIdRef.current ?? '')?.ping ?? 0
  const onlineCount = world ? world.members.filter((m) => m.online).length : 0
  const reached = (key: Stage): boolean => {
    const order: Stage[] = ['resolving', 'securing', 'fetching', 'preview']
    return order.indexOf(stage) > order.indexOf(key)
  }

  return (
    <div className="p-5">
      {stage === 'idle' && (
        <>
          <label className="text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
            Paste anything
          </label>
          <div className="mt-2 flex gap-2">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && void begin()}
              placeholder="relic://vault.aria-clan.gg/x7Kp2 Â· REL3-â€¦ Â· 203.0.113.7:7777"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 font-mono text-[12.5px] text-hi outline-none transition-colors select-text placeholder:text-lo/60 focus:border-relic/50"
            />
            <button
              onClick={() => void begin()}
              disabled={!input.trim()}
              className="rounded-xl bg-relic px-4 text-[13px] font-semibold text-void-0 transition-all duration-150 hover:shadow-[0_0_18px_rgba(139,124,246,0.45)] disabled:opacity-30 disabled:hover:shadow-none"
            >
              Connect
            </button>
          </div>
          {error ? (
            <p className="mt-3 text-[12px] text-ember">{error}</p>
          ) : (
            <p className="mt-3 text-[12px] leading-relaxed text-lo">
              Works with a friend&apos;s <span className="font-mono text-[11px] text-mid">relic://</span> link,
              an encrypted <span className="font-mono text-[11px] text-mid">REL3</span> invite code, a domain,
              or a raw IP. Codes decrypt locally â€” no registry, no middleman.
            </p>
          )}
        </>
      )}

      {stage === 'keep-password' && target && (
        <div className="py-2">
          <div className="mb-3 flex items-center gap-2">
            <KeyRound size={16} className="text-gold" />
            <span className="text-[13.5px] font-semibold">This keep is gated</span>
          </div>
          <p className="text-[12.5px] leading-relaxed text-mid">
            <span className="font-mono text-[11.5px] text-hi">{hostTag(target.host)}</span> requires a
            keep password from everyone who enters â€” ask whoever runs the server.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              autoFocus
              type="password"
              value={keepPw}
              onChange={(e) => setKeepPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submitKeepPassword()}
              placeholder="keep password"
              className="min-w-0 flex-1 rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[13px] text-hi outline-none transition-colors select-text placeholder:text-lo/60 focus:border-gold/50"
            />
            <button
              onClick={() => void submitKeepPassword()}
              disabled={!keepPw}
              className="rounded-xl bg-gold px-4 text-[13px] font-semibold text-void-0 transition-all duration-150 hover:shadow-[0_0_18px_rgba(232,201,122,0.45)] disabled:opacity-30"
            >
              Enter
            </button>
          </div>
          {pwError && <p className="mt-2 text-[12px] text-ember">{pwError}</p>}
        </div>
      )}

      {stage !== 'idle' && stage !== 'preview' && stage !== 'keep-password' && target && (
        <div className="py-2">
          <div className="mb-4 truncate font-mono text-[12px] text-mid">â—† {hostTag(target.host)}</div>
          <div className="flex flex-col gap-2.5">
            {STAGES.map((s) => (
              <div key={s.key} className="flex items-center gap-2.5 text-[13px]">
                {reached(s.key) ? (
                  <Check size={15} className="text-pulse" />
                ) : stage === s.key ? (
                  <Loader2 size={15} className="animate-spin text-relic" />
                ) : (
                  <span className="h-[15px] w-[15px] rounded-full border border-edge" />
                )}
                <span className={reached(s.key) ? 'text-mid' : stage === s.key ? 'text-hi' : 'text-lo'}>
                  {s.label}
                  {s.key === 'securing' && stage === 'securing' && (
                    <span className="ml-2 font-mono text-[10.5px] text-lo">handshake Â· relic.v1</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stage === 'preview' && target && world && (
        <div>
          {/* banner reveal */}
          <div
            className="palette-in relative h-20 overflow-hidden rounded-xl"
            style={{
              background: `linear-gradient(120deg, color-mix(in srgb, ${accentFor(target.host)} 45%, #0c0e14), color-mix(in srgb, ${accentFor(target.host)} 12%, #07080c))`
            }}
          >
            <div className="absolute right-3 bottom-2 font-mono text-[10px] text-hi/50">
              {disc?.protocol ?? 'relic.v1'} Â· v{disc?.version}
            </div>
          </div>
          <div className="mt-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate font-display text-[17px] font-bold">{world.name}</h3>
              <div className="mt-0.5 truncate font-mono text-[11px] text-lo">
                â—† {hostTag(target.host)} Â· address hidden â€” see server settings
              </div>
            </div>
            <span className="shrink-0 rounded border border-gold/30 bg-gold/10 px-1.5 py-0.5 text-[9px] tracking-wide text-gold">
              SELF-HOSTED
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(() => {
              const b = securityBadge(target)
              return (
                <span
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${b.cls}`}
                >
                  {b.icon}
                  {b.label}
                </span>
              )
            })()}
            <span className="flex items-center gap-1.5 rounded-md border border-edge bg-void-0/50 px-2 py-1 font-mono text-[11px] text-mid">
              <Globe size={12} className="text-abyss" />
              {ping}ms
            </span>
            <span className="rounded-md border border-edge bg-void-0/50 px-2 py-1 font-mono text-[11px] text-mid">
              {world.members.length} member{world.members.length === 1 ? '' : 's'}
            </span>
            <span className="rounded-md border border-edge bg-void-0/50 px-2 py-1 font-mono text-[11px] text-pulse">
              {onlineCount} online
            </span>
          </div>

          <button
            onClick={enter}
            className="mt-5 w-full rounded-xl bg-gold py-2.5 font-display text-[14px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_28px_rgba(232,201,122,0.45)]"
          >
            Enter the Vault
          </button>
        </div>
      )}
    </div>
  )
}


export function AddServerModal(): React.JSX.Element | null {
  const { addServerOpen, closeAddServer } = useUi()

  useEffect(() => {
    if (!addServerOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeAddServer()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addServerOpen, closeAddServer])

  if (!addServerOpen) return null

  return (
    <div
      className="absolute inset-0 z-[100] flex items-start justify-center bg-void-0/60 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={closeAddServer}
    >
      <div
        className="glass palette-in w-[520px] overflow-hidden rounded-2xl shadow-[0_24px_80px_-12px_rgba(0,0,0,0.8),0_0_40px_-18px_var(--accent)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-edge px-5 py-4">
          <h2 className="flex-1 font-display text-[16px] font-bold">Add a world</h2>
          <button
            onClick={closeAddServer}
            className="rounded-md p-1.5 text-lo transition-colors hover:bg-void-3 hover:text-hi"
          >
            <X size={16} />
          </button>
        </div>

        <JoinTab />
      </div>
    </div>
  )
}
