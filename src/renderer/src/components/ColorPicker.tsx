import { useEffect, useState } from 'react'
import { clampHex, hexToHsv, hsvToHex } from '@/lib/color'

/** HSV color picker: hue / saturation / brightness sliders + hex input,
 *  with live gradient tracks. Matches the app's dark/glass vibe. */
export function ColorPicker({
  value,
  onChange
}: {
  value: string
  onChange: (hex: string) => void
}): React.JSX.Element {
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const [hex, setHex] = useState(value)

  // sync down when the parent value changes (e.g. preset clicked elsewhere)
  useEffect(() => {
    setHsv(hexToHsv(value))
    setHex(value)
  }, [value])

  const apply = (next: typeof hsv): void => {
    setHsv(next)
    const h = hsvToHex(next)
    setHex(h)
    onChange(h)
  }

  const atHue = hsvToHex({ h: hsv.h, s: 100, v: 100 })
  const satTrack = `linear-gradient(90deg, ${hsvToHex({ h: hsv.h, s: 0, v: hsv.v })}, ${hsvToHex({ h: hsv.h, s: 100, v: hsv.v })})`
  const valTrack = `linear-gradient(90deg, #000, ${hsvToHex({ h: hsv.h, s: hsv.s, v: 100 })})`

  const sliders: { label: string; max: number; key: 'h' | 's' | 'v'; track: string }[] = [
    {
      label: 'Hue',
      max: 360,
      key: 'h',
      track:
        'linear-gradient(90deg,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)'
    },
    { label: 'Saturation', max: 100, key: 's', track: satTrack },
    { label: 'Brightness', max: 100, key: 'v', track: valTrack }
  ]

  return (
    <div className="w-[268px]">
      <div className="mb-3 flex items-center gap-3">
        <div
          className="h-11 w-11 shrink-0 rounded-xl border border-edge"
          style={{ background: hex, boxShadow: `0 0 16px ${hex}66` }}
        />
        <div className="flex-1">
          <label className="text-[10px] font-semibold tracking-[0.12em] text-lo uppercase">Hex</label>
          <input
            value={hex}
            onChange={(e) => {
              setHex(e.target.value)
              const c = clampHex(e.target.value)
              if (c) {
                setHsv(hexToHsv(c))
                onChange(c)
              }
            }}
            spellCheck={false}
            className="mt-1 w-full rounded-lg border border-edge bg-void-0/70 px-2.5 py-1.5 font-mono text-[12.5px] text-hi outline-none select-text focus:border-relic/50"
          />
        </div>
      </div>

      {sliders.map((sl) => (
        <div key={sl.key} className="mb-2.5">
          <div className="mb-1 flex justify-between text-[10px] tracking-[0.1em] text-lo uppercase">
            <span>{sl.label}</span>
            <span className="font-mono">{hsv[sl.key]}</span>
          </div>
          <input
            type="range"
            min={0}
            max={sl.max}
            value={hsv[sl.key]}
            onChange={(e) => apply({ ...hsv, [sl.key]: Number(e.target.value) })}
            className="color-slider"
            style={{ '--track': sl.track, '--thumb': atHue } as React.CSSProperties}
          />
        </div>
      ))}
    </div>
  )
}
