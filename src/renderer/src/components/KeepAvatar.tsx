import { useMedia } from '@/lib/useMedia'

/** Renders a member's avatar: the uploaded image (GIFs animate) when set,
 *  else a gradient disc with their initial. Image URL comes from the Keep
 *  the member belongs to. */
export function KeepAvatar({
  instanceId,
  avatar,
  name,
  accent,
  size = 36,
  ring
}: {
  instanceId: string
  avatar: string
  name: string
  accent: string
  size?: number
  ring?: boolean
}): React.JSX.Element {
  const { src: url } = useMedia(instanceId, avatar)
  return (
    <div
      className={`shrink-0 overflow-hidden rounded-full ${ring ? 'ring-2 ring-void-1' : ''}`}
      style={{ width: size, height: size }}
    >
      {url ? (
        <img src={url} alt={name} className="h-full w-full object-cover" draggable={false} />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center font-display font-semibold"
          style={{
            fontSize: size * 0.42,
            color: '#07080c',
            background: `linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 55%, #0c0e14))`
          }}
        >
          {name[0]?.toUpperCase()}
        </div>
      )}
    </div>
  )
}

/** Local-identity avatar (data URL straight from the profile, pre-upload). */
export function SelfAvatar({
  dataUrl,
  name,
  accent,
  size = 28
}: {
  dataUrl?: string
  name: string
  accent: string
  size?: number
}): React.JSX.Element {
  return (
    <div className="shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
      {dataUrl ? (
        <img src={dataUrl} alt={name} className="h-full w-full object-cover" draggable={false} />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center font-display font-semibold"
          style={{
            fontSize: size * 0.42,
            color: '#07080c',
            background: `linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 55%, #0c0e14))`
          }}
        >
          {name[0]?.toUpperCase()}
        </div>
      )}
    </div>
  )
}
