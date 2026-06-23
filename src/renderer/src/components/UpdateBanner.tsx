/**
 * Update banner — a full-width strip under the title bar that appears once a new
 * version has been downloaded in the background. Three choices:
 *   • Update now            → restart into the new version immediately
 *   • Remind me tomorrow     → hide for 24h (re-shows for the same version)
 *   • Ignore until next update → hide this version permanently (newer ones still show)
 * Snooze/ignore are version-scoped and persisted, so they survive restarts and a
 * newer release always surfaces a fresh banner.
 */

import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { getUpdatePrefs, setUpdatePrefs, type UpdatePrefs } from '@/lib/updatePrefs'
import { useUi } from '@/store'
import { LicenseGate } from './LicenseGate'

export function UpdateBanner(): React.JSX.Element | null {
  const update = useUi((s) => s.update)
  const [prefs, setPrefs] = useState<UpdatePrefs>(getUpdatePrefs)
  const [now, setNow] = useState(() => Date.now())
  const [gateOpen, setGateOpen] = useState(false)

  const version = update.version ?? ''
  const ready = update.status === 'update-downloaded' && version !== ''
  const ignored = prefs.ignoredVersion === version
  const snoozed = prefs.snoozedVersion === version && now < prefs.snoozeUntil
  const show = ready && !ignored && !snoozed

  // when snoozed, re-surface exactly when the snooze elapses (covers long sessions;
  // restarts re-evaluate on their own via the launch check)
  useEffect(() => {
    if (!ready || !snoozed) return
    const id = setTimeout(() => setNow(Date.now()), Math.max(1000, prefs.snoozeUntil - Date.now()))
    return () => clearTimeout(id)
  }, [ready, snoozed, prefs.snoozeUntil])

  if (!show) return null

  const save = (p: UpdatePrefs): void => {
    setUpdatePrefs(p)
    setPrefs(p)
  }
  const remindTomorrow = (): void =>
    save({ ...prefs, snoozedVersion: version, snoozeUntil: Date.now() + 24 * 60 * 60 * 1000 })
  const ignore = (): void => save({ ...prefs, ignoredVersion: version })

  return (
    <div className="flex items-center gap-3 border-b border-relic/30 bg-relic/10 px-4 py-2 text-[12.5px]">
      {gateOpen && (
        <LicenseGate
          version={version}
          onAccept={() => {
            setGateOpen(false)
            void window.reliquary.installUpdate()
          }}
          onCancel={() => setGateOpen(false)}
        />
      )}
      <Sparkles size={14} className="shrink-0 text-relic" />
      <span className="min-w-0 truncate text-hi">
        Reliquary <span className="font-semibold">v{version}</span> is ready to install.
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          onClick={() => setGateOpen(true)}
          className="rounded-md bg-relic px-3 py-1 text-[12px] font-semibold text-void-0 transition-all duration-150 hover:shadow-[0_0_16px_rgba(139,124,246,0.45)]"
        >
          Update now
        </button>
        <button
          onClick={remindTomorrow}
          className="rounded-md border border-edge px-3 py-1 text-[12px] text-mid transition-colors hover:border-relic/40 hover:text-hi"
        >
          Remind me tomorrow
        </button>
        <button
          onClick={ignore}
          className="rounded-md px-3 py-1 text-[12px] text-lo transition-colors hover:text-mid"
        >
          Ignore until next update
        </button>
        <button
          onClick={remindTomorrow}
          title="Dismiss for now"
          className="rounded-md p-1 text-lo transition-colors hover:bg-void-3 hover:text-hi"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
