/**
 * Settings → Account: current version + manual "Check for updates". Background
 * auto-update is driven by the main process (electron-updater); this card just
 * surfaces status and lets the user check/restart on demand. In dev the updater
 * is disabled, so the check reports that rather than erroring.
 */

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useUi } from '@/store'

export function UpdatesCard(): React.JSX.Element {
  const update = useUi((s) => s.update)
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [devDisabled, setDevDisabled] = useState(false)

  useEffect(() => {
    void window.reliquary.getVersion().then(setVersion)
  }, [])

  const check = async (): Promise<void> => {
    setChecking(true)
    const r = await window.reliquary.checkForUpdates()
    setChecking(false)
    setDevDisabled(!!r?.disabled)
  }

  const statusText = (): string => {
    if (devDisabled) return 'Updates are disabled in development.'
    switch (update.status) {
      case 'checking-for-update':
        return 'Checking for updates…'
      case 'update-available':
        return `Downloading v${update.version ?? ''}…`
      case 'download-progress':
        return `Downloading… ${update.percent ?? 0}%`
      case 'update-downloaded':
        return `Update ready — restart to install v${update.version ?? ''}.`
      case 'update-not-available':
        return "You're on the latest version."
      case 'error':
        return `Couldn't check: ${update.message ?? 'unknown error'}`
      default:
        return ''
    }
  }

  const text = statusText()
  const ready = update.status === 'update-downloaded'

  return (
    <div className="mt-6 flex items-center justify-between gap-3 rounded-2xl border border-edge bg-void-1 p-5">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-hi">Reliquary version</div>
        <div className="mt-0.5 font-mono text-[12px] text-mid">v{version || '—'}</div>
        {text && <div className="mt-1.5 text-[11.5px] leading-relaxed text-lo">{text}</div>}
      </div>
      {ready ? (
        <button
          onClick={() => void window.reliquary.installUpdate()}
          className="flex shrink-0 items-center gap-2 rounded-xl bg-relic px-4 py-2 text-[13px] font-semibold text-void-0 transition-all duration-150 hover:shadow-[0_0_18px_rgba(139,124,246,0.45)]"
        >
          <RefreshCw size={14} />
          Restart &amp; update
        </button>
      ) : (
        <button
          onClick={() => void check()}
          disabled={checking}
          className="flex shrink-0 items-center gap-2 rounded-xl border border-edge px-4 py-2 text-[13px] text-mid transition-colors hover:border-relic/40 hover:text-hi disabled:opacity-50"
        >
          <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
          Check for updates
        </button>
      )}
    </div>
  )
}
