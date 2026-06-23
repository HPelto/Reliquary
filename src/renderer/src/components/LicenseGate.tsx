/**
 * License gate — shown before an update is installed. It fetches the license for
 * the version being installed and requires the user to scroll through and agree
 * before the update proceeds. Declining just closes it: the user stays on their
 * current version, which they're already licensed for — never a lockout.
 */

import { useEffect, useRef, useState } from 'react'

const FALLBACK =
  "Couldn't load the license to display. Please review it at\nhttps://polyformproject.org/licenses/noncommercial/1.0.0 before continuing."

export function LicenseGate({
  version,
  onAccept,
  onCancel
}: {
  version: string
  onAccept: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [text, setText] = useState('Loading license…')
  const [scrolledEnd, setScrolledEnd] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    window.reliquary
      .fetchUpdateLicense(version)
      .then((r) => {
        if (cancelled) return
        setText(r.text ?? `${FALLBACK}${r.error ? `\n\n(${r.error})` : ''}`)
      })
      .catch(() => {
        if (!cancelled) setText(FALLBACK)
      })
    return () => {
      cancelled = true
    }
  }, [version])

  // if the license is short enough not to scroll, unlock right away
  useEffect(() => {
    const box = boxRef.current
    if (box && box.scrollHeight <= box.clientHeight + 8) setScrolledEnd(true)
  }, [text])

  const onScroll = (): void => {
    const box = boxRef.current
    if (box && box.scrollTop + box.clientHeight >= box.scrollHeight - 8) setScrolledEnd(true)
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-void-0/70 p-6 backdrop-blur-sm">
      <div className="flex max-h-[84vh] w-full max-w-[560px] flex-col rounded-2xl border border-edge bg-void-1 p-5">
        <h3 className="text-[15px] font-semibold text-hi">Review the license before updating</h3>
        <p className="mt-1 text-[12px] leading-snug text-mid">
          This is the license for <span className="font-semibold text-hi">v{version}</span>. You can
          keep running your current version if you don&apos;t agree — you won&apos;t be locked out.
        </p>
        <div
          ref={boxRef}
          onScroll={onScroll}
          className="mt-3 min-h-[160px] flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border border-edge bg-void-0 p-3.5 font-mono text-[11px] leading-relaxed text-mid"
        >
          {text}
        </div>
        {!scrolledEnd && (
          <p className="mt-1.5 text-[10.5px] text-lo">Scroll to the bottom of the license to continue.</p>
        )}
        <label
          className={`mt-3 flex items-start gap-2 text-[12.5px] leading-snug ${
            scrolledEnd ? 'cursor-pointer text-hi' : 'cursor-default text-lo'
          }`}
        >
          <input
            type="checkbox"
            disabled={!scrolledEnd}
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 h-[15px] w-[15px] shrink-0 accent-relic disabled:opacity-50"
          />
          <span>I have read and agree to this license.</span>
        </label>
        <div className="mt-4 flex justify-end gap-2.5">
          <button
            onClick={onCancel}
            className="rounded-lg border border-edge px-3.5 py-1.5 text-[12.5px] text-mid transition-colors hover:border-relic/40 hover:text-hi"
          >
            Not now
          </button>
          <button
            onClick={onAccept}
            disabled={!agreed}
            className="rounded-lg bg-relic px-3.5 py-1.5 text-[12.5px] font-semibold text-void-0 transition-all hover:shadow-[0_0_16px_rgba(139,124,246,0.45)] disabled:cursor-default disabled:opacity-40"
          >
            Agree &amp; update
          </button>
        </div>
      </div>
    </div>
  )
}
