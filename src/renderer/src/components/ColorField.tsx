import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { ColorPicker } from './ColorPicker'

/** A row of preset color swatches plus a rainbow "custom" swatch that opens
 *  the HSV picker. Reused for accent and username color. */
export function ColorField({
  value,
  presets,
  onChange
}: {
  value: string
  presets: string[]
  onChange: (hex: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const isCustom = !presets.includes(value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      {presets.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className="flex h-8 w-8 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110"
          style={{ background: c, boxShadow: value === c ? `0 0 14px ${c}` : undefined }}
        >
          {value === c && <Check size={14} className="text-void-0" />}
        </button>
      ))}

      {/* rainbow custom swatch */}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Custom color"
        className="flex h-8 w-8 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110"
        style={{
          background: isCustom
            ? value
            : 'conic-gradient(from 0deg,#ff6b81,#e8c97a,#3ddcc4,#5ea2ff,#8b7cf6,#ff6b81)',
          boxShadow: isCustom ? `0 0 14px ${value}` : undefined,
          outline: isCustom ? '2px solid var(--color-hi)' : undefined,
          outlineOffset: 2
        }}
      >
        {isCustom && <Check size={14} className="text-void-0" />}
      </button>

      {open && (
        <div className="glass palette-in absolute top-full left-0 z-[60] mt-2 rounded-2xl p-3.5 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.8)]">
          <ColorPicker value={isCustom ? value : '#8b7cf6'} onChange={onChange} />
        </div>
      )}
    </div>
  )
}
