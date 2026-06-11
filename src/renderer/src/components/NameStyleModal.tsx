import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { DEFAULT_NAME_COLOR, NAME_EFFECTS, NAME_FONTS } from '@/lib/nameStyle'
import { ACCENT_PRESETS } from '@/lib/relic'
import { ColorField } from './ColorField'
import { StyledName } from './StyledName'

/** Picker for username font + effect + color. Selections preview live;
 *  the parent applies them on Save alongside the rest of the profile. */
export function NameStyleModal({
  open,
  onClose,
  name,
  font,
  effect,
  color,
  onChange
}: {
  open: boolean
  onClose: () => void
  name: string
  font: string
  effect: string
  color: string
  onChange: (next: { font: string; effect: string; color: string }) => void
}): React.JSX.Element | null {
  const [f, setF] = useState(font)
  const [e, setE] = useState(effect)
  const [c, setC] = useState(color || DEFAULT_NAME_COLOR)

  useEffect(() => {
    if (open) {
      setF(font)
      setE(effect)
      setC(color || DEFAULT_NAME_COLOR)
    }
  }, [open, font, effect, color])

  useEffect(() => {
    if (!open) return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const preview = name.trim() || 'Voidwalker'

  return (
    <div
      className="fixed inset-0 z-[170] flex items-center justify-center bg-void-0/70 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="glass palette-in flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-2xl shadow-[0_24px_80px_-12px_rgba(0,0,0,0.8),0_0_50px_-20px_var(--color-relic)]"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
          <h2 className="font-display text-[16px] font-bold">Name style</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-lo transition-colors hover:bg-void-3 hover:text-hi"
          >
            <X size={16} />
          </button>
        </div>

        {/* live preview (always animated so the effect is visible) */}
        <div className="flex h-24 shrink-0 items-center justify-center border-b border-edge bg-void-0/50">
          <StyledName name={preview} color={c} font={f} effect={e} mode="always" style={{ fontSize: 30 }} />
        </div>

        <div className="flex-1 overflow-y-auto p-5 scroll-thin">
          <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
            Color
          </div>
          <ColorField value={c} presets={ACCENT_PRESETS} onChange={setC} />
          <p className="mt-2 text-[11px] text-lo">
            Some servers enforce role colors and ignore custom name styling.
          </p>

          <div className="mt-5 mb-2 text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
            Font
          </div>
          <div className="grid grid-cols-2 gap-2">
            {NAME_FONTS.map((nf) => (
              <button
                key={nf.key}
                onClick={() => setF(nf.key)}
                className={`flex items-center justify-between rounded-xl border px-3 py-2.5 transition-colors ${
                  f === nf.key
                    ? 'border-relic/60 bg-relic/10'
                    : 'border-edge bg-void-0/50 hover:border-relic/30'
                }`}
              >
                <StyledName name={preview} color={c} font={nf.key} style={{ fontSize: 16 }} />
                {f === nf.key && <Check size={14} className="shrink-0 text-relic" />}
              </button>
            ))}
          </div>

          <div className="mt-5 mb-2 text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
            Effect
          </div>
          <div className="grid grid-cols-2 gap-2">
            {NAME_EFFECTS.map((ne) => (
              <button
                key={ne.key}
                onClick={() => setE(ne.key)}
                onMouseEnter={(ev) => ev.currentTarget.classList.add('group')}
                className={`group flex items-center justify-between rounded-xl border px-3 py-2.5 transition-colors ${
                  e === ne.key
                    ? 'border-relic/60 bg-relic/10'
                    : 'border-edge bg-void-0/50 hover:border-relic/30'
                }`}
              >
                {/* animate on hover so the picker tiles demo their motion */}
                <StyledName
                  name={ne.label}
                  color={c}
                  font={f}
                  effect={ne.key}
                  mode="hover"
                  style={{ fontSize: 16 }}
                />
                {e === ne.key && <Check size={14} className="shrink-0 text-relic" />}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-edge px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-xl border border-edge px-4 py-2 text-[13px] text-mid transition-colors hover:bg-void-3 hover:text-hi"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onChange({ font: f, effect: e, color: c })
              onClose()
            }}
            className="rounded-xl bg-relic px-5 py-2 font-display text-[13.5px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_24px_rgba(139,124,246,0.45)]"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
