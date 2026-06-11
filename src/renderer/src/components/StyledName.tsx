import { effectClass, effectOwnsColor, fontClass } from '@/lib/nameStyle'

/**
 * A username with its chosen font + effect.
 *
 * mode controls animation:
 *  - 'static'  → font + static effect look, never animates (member list, self)
 *  - 'hover'   → animates only while an ancestor `.group` is hovered (messages)
 *  - 'always'  → animates continuously (hover card, profile modal, preview)
 */
export function StyledName({
  name,
  color,
  font,
  effect,
  mode = 'static',
  className = '',
  style
}: {
  name: string
  color: string
  font?: string
  effect?: string
  mode?: 'static' | 'hover' | 'always'
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const fx = effectClass(effect)
  const animClass = fx ? (mode === 'always' ? 'on' : mode === 'hover' ? 'hoverable' : '') : ''
  const ownsColor = effectOwnsColor(effect)

  return (
    <span
      data-text={name}
      className={`uname ${fontClass(font)} ${fx} ${animClass} ${className}`}
      style={{ '--u': color, ...(ownsColor ? {} : { color }), ...style } as React.CSSProperties}
    >
      {name}
    </span>
  )
}
