/**
 * Self-profile popover — opens from the bottom-left user card. Profile preview
 * header + Edit Profile (→ profile settings), a status selector
 * (Online/Idle/DND/Invisible) whose non-online options reveal a duration flyout,
 * a dimmed Switch Accounts (deferred), and Copy User ID (→ the fingerprint).
 *
 * Rendered through a PORTAL to <body> with fixed positioning anchored to the
 * user card. The menu overflows the channel panel into the chat pane; rendering
 * it inside the panel let the chat pane (its own stacking context) steal clicks
 * on the overflowing part. At body level it sits above everything.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, Copy, Pencil, Users } from 'lucide-react'
import { DEFAULT_NAME_COLOR } from '@/lib/nameStyle'
import { PRESENCE_DURATIONS, presenceColor, presenceLabel } from '@/lib/presence'
import type { KeepPresence } from '@/net/keep'
import { useUi } from '@/store'
import { SelfAvatar } from './KeepAvatar'
import { StyledName } from './StyledName'

const STATES: KeepPresence[] = ['online', 'idle', 'dnd', 'invisible']

function Dot({ state, size = 10 }: { state: KeepPresence | 'offline'; size?: number }): React.JSX.Element {
  return (
    <span
      className="block shrink-0 rounded-full"
      style={{ width: size, height: size, background: presenceColor(state) }}
    />
  )
}

export function SelfMenu({
  onClose,
  anchorRef
}: {
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const { identity, profile, presence, setPresenceState, openSettings } = useUi()
  const ref = useRef<HTMLDivElement>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const [flyout, setFlyout] = useState<KeepPresence | null>(null)
  const [copied, setCopied] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)

  // anchor the menu just above the user card
  useLayoutEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: r.left, bottom: window.innerHeight - r.top + 6 })
  }, [anchorRef])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current && !ref.current.contains(t) && !anchorRef.current?.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose, anchorRef])

  const item =
    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-mid transition-colors hover:bg-void-3 hover:text-hi'

  const editProfile = (): void => {
    openSettings()
    onClose()
  }
  const copyId = (): void => {
    void navigator.clipboard.writeText(identity?.fingerprint ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const pick = (state: KeepPresence, ms: number): void => {
    setPresenceState(state, ms)
    onClose()
  }
  const closeStatus = (): void => {
    setStatusOpen(false)
    setFlyout(null)
  }

  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', left: pos?.left ?? -9999, bottom: pos?.bottom ?? 0 }}
      className="glass palette-in z-[200] w-[248px] rounded-xl p-1.5 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]"
    >
      {/* profile preview header */}
      <div className="mb-1 overflow-hidden rounded-lg">
        <div
          className="h-12 w-full"
          style={{
            background: profile.background?.dataUrl
              ? `center/cover url(${profile.background.dataUrl})`
              : `linear-gradient(135deg, color-mix(in srgb, var(--accent) 60%, transparent), transparent)`
          }}
        />
        <div className="flex items-start gap-2.5 bg-void-1/70 px-2.5 pb-2.5">
          <div className="relative -mt-5">
            <div className="rounded-full border-[3px] border-void-1">
              <SelfAvatar
                dataUrl={profile.avatar?.dataUrl}
                name={identity?.name ?? '◆'}
                accent={identity?.accent ?? '#8b7cf6'}
                size={44}
              />
            </div>
            <span className="absolute right-0 bottom-0 rounded-full border-2 border-void-1">
              <Dot state={presence.state} size={12} />
            </span>
          </div>
          <div className="min-w-0 pt-1.5">
            <StyledName
              name={identity?.name ?? '—'}
              color={profile.nameColor || DEFAULT_NAME_COLOR}
              font={profile.nameFont}
              effect={profile.nameEffect}
              mode="always"
              className="truncate text-[14px] font-semibold"
            />
            <div className="truncate font-mono text-[10px] text-lo" title={identity?.fingerprint}>
              {identity?.fingerprint}
            </div>
          </div>
        </div>
        {profile.status && (
          <div className="truncate bg-void-1/70 px-2.5 pb-2 text-[11.5px] text-mid">
            {profile.status}
          </div>
        )}
      </div>

      <button className={item} onClick={editProfile} onMouseEnter={closeStatus}>
        <Pencil size={15} className="text-lo" />
        Edit Profile
      </button>

      {/* status selector with a duration flyout for non-online states */}
      <div className="relative">
        <button
          className={`${item} justify-between`}
          onMouseEnter={() => setStatusOpen(true)}
          onClick={() => setStatusOpen(true)}
        >
          <span className="flex items-center gap-2.5">
            <Dot state={presence.state} />
            {presenceLabel(presence.state)}
          </span>
          <ChevronRight size={14} className="text-lo" />
        </button>

        {statusOpen && (
          <div className="glass absolute bottom-0 left-full z-[200] ml-1 w-[208px] rounded-xl p-1.5 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]">
            {STATES.map((st) => (
              <button
                key={st}
                className={`${item} justify-between`}
                onMouseEnter={() => setFlyout(st === 'online' ? null : st)}
                onClick={() => {
                  if (st === 'online') pick('online', 0)
                }}
              >
                <span className="flex items-center gap-2.5">
                  <Dot state={st} />
                  {presenceLabel(st)}
                </span>
                {st !== 'online' && <ChevronRight size={14} className="text-lo" />}
              </button>
            ))}

            {/* one duration panel beside the whole submenu for the hovered status —
                reachable by moving straight right from any row (no crossing rows) */}
            {flyout && (
              <div className="glass absolute bottom-0 left-full z-[200] ml-1 w-[168px] rounded-xl p-1.5 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]">
                {PRESENCE_DURATIONS.map((d) => (
                  <button key={d.label} className={item} onClick={() => pick(flyout, d.ms)}>
                    {d.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* wrapper catches mouse-enter even though the button is disabled */}
      <div onMouseEnter={closeStatus}>
        <button className={`${item} cursor-not-allowed opacity-40`} disabled title="Coming soon">
          <Users size={15} className="text-lo" />
          Switch Accounts
        </button>
      </div>

      <button className={item} onClick={copyId} onMouseEnter={closeStatus}>
        {copied ? <Check size={15} className="text-pulse" /> : <Copy size={15} className="text-lo" />}
        {copied ? 'Copied!' : 'Copy User ID'}
      </button>
    </div>,
    document.body
  )
}
