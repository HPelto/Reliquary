/**
 * Self-profile popover — opens from the bottom-left user card. Profile preview
 * header + Edit Profile (→ profile settings), a status selector
 * (Online/Idle/DND/Invisible) whose non-online options reveal a duration flyout,
 * a dimmed Switch Accounts (deferred), and Copy User ID (→ the fingerprint).
 * Matches the ServerMenu popover pattern (glass, click-outside + Escape).
 */

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Copy, Pencil, Users } from 'lucide-react'
import { DEFAULT_NAME_COLOR } from '@/lib/nameStyle'
import {
  PRESENCE_DURATIONS,
  presenceColor,
  presenceLabel
} from '@/lib/presence'
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

export function SelfMenu({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { identity, profile, presence, setPresenceState, openSettings } = useUi()
  const ref = useRef<HTMLDivElement>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const [flyout, setFlyout] = useState<KeepPresence | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
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
  }, [onClose])

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
  // close the status submenu only when the cursor moves to another row — NOT on
  // the gap between the trigger and the submenu (which would make it unreachable)
  const closeStatus = (): void => {
    setStatusOpen(false)
    setFlyout(null)
  }

  return (
    <div
      ref={ref}
      className="glass palette-in absolute bottom-full left-2 z-[120] mb-2 w-[248px] rounded-xl p-1.5 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]"
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
          <div className="glass absolute bottom-0 left-full z-[120] ml-1 w-[200px] rounded-xl p-1.5 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]">
            {STATES.map((st) =>
              st === 'online' ? (
                <button
                  key={st}
                  className={`${item} justify-between`}
                  onMouseEnter={() => setFlyout(null)}
                  onClick={() => pick('online', 0)}
                >
                  <span className="flex items-center gap-2.5">
                    <Dot state="online" />
                    Online
                  </span>
                </button>
              ) : (
                <div key={st} className="relative" onMouseEnter={() => setFlyout(st)}>
                  <button className={`${item} justify-between`} onClick={() => setFlyout(st)}>
                    <span className="flex items-center gap-2.5">
                      <Dot state={st} />
                      {presenceLabel(st)}
                    </span>
                    <ChevronRight size={14} className="text-lo" />
                  </button>
                  {flyout === st && (
                    <div className="glass absolute bottom-0 left-full z-[120] ml-1 w-[150px] rounded-xl p-1.5 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]">
                      {PRESENCE_DURATIONS.map((d) => (
                        <button key={d.label} className={item} onClick={() => pick(st, d.ms)}>
                          {d.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
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
    </div>
  )
}
