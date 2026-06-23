/**
 * Username styling — fonts + effects, synced across Keeps like the rest of a
 * profile. All fonts are OFL-licensed. Effects render statically by
 * default and only animate on "spotlight" surfaces (message hover, the hover
 * card, the profile modal) so the member list never strobes.
 */

export interface NameFont {
  key: string
  label: string
  /** css class (defined in main.css) applying family + per-font size tuning */
  className: string
}

export interface NameEffect {
  key: string
  label: string
  className: string // e.g. "ufx-neon"
}

export const NAME_FONTS: NameFont[] = [
  { key: 'default', label: 'Clean', className: 'uf-default' },
  { key: 'orbitron', label: 'Orbitron', className: 'uf-orbitron' },
  { key: 'audiowide', label: 'Audiowide', className: 'uf-audiowide' },
  { key: 'bungee', label: 'Bungee', className: 'uf-bungee' },
  { key: 'monoton', label: 'Monoton', className: 'uf-monoton' },
  { key: 'pressstart', label: 'Arcade', className: 'uf-pressstart' },
  { key: 'vt323', label: 'Terminal', className: 'uf-vt323' },
  { key: 'pirata', label: 'Gothic', className: 'uf-pirata' },
  { key: 'glitchfont', label: 'Corrupt', className: 'uf-glitchfont' },
  { key: 'cinzel', label: 'Royal', className: 'uf-cinzel' }
]

export const NAME_EFFECTS: NameEffect[] = [
  { key: 'none', label: 'None', className: '' },
  { key: 'neon', label: 'Neon', className: 'ufx-neon' },
  { key: 'gradient', label: 'Gradient', className: 'ufx-gradient' },
  { key: 'rainbow', label: 'Rainbow', className: 'ufx-rainbow' },
  { key: 'chrome', label: 'Chrome', className: 'ufx-chrome' },
  { key: 'ember', label: 'Ember', className: 'ufx-ember' },
  { key: 'frost', label: 'Frost', className: 'ufx-frost' },
  { key: 'toxic', label: 'Toxic', className: 'ufx-toxic' },
  { key: 'flicker', label: 'Flicker', className: 'ufx-flicker' },
  { key: 'glitch', label: 'Glitch', className: 'ufx-glitch' }
]

const fontByKey = new Map(NAME_FONTS.map((f) => [f.key, f]))
const effectByKey = new Map(NAME_EFFECTS.map((e) => [e.key, e]))

export function fontClass(key?: string): string {
  return (key && fontByKey.get(key)?.className) || 'uf-default'
}

export function effectClass(key?: string): string {
  return (key && effectByKey.get(key)?.className) || ''
}

/** Effects that paint the glyphs themselves (background-clip) — they override
 *  the text color, so callers shouldn't also set color. */
export function effectOwnsColor(key?: string): boolean {
  return ['gradient', 'rainbow', 'chrome', 'ember', 'frost', 'toxic'].includes(key ?? '')
}

/** The neutral default username color when the user hasn't picked one. */
export const DEFAULT_NAME_COLOR = '#edeef4'

/** Role colors used when a Keep locks username styling. */
export function roleColor(role: string): string {
  if (role === 'owner') return '#e8c97a'
  if (role === 'admin') return '#8b7cf6'
  return DEFAULT_NAME_COLOR
}

/** Resolve a member's name color: role color when the Keep is locked,
 *  otherwise their chosen color (or the neutral default). */
export function nameColorFor(
  member: { name_color?: string; role: string },
  locked?: boolean
): string {
  if (locked) return roleColor(member.role)
  return member.name_color || DEFAULT_NAME_COLOR
}
