import type { Status, User } from '@/data/mock'

const statusColor: Record<Status, string> = {
  online: 'var(--color-pulse)',
  idle: 'var(--color-gold)',
  dnd: 'var(--color-ember)',
  offline: 'var(--color-lo)'
}

interface Props {
  user: User
  size?: number
  speaking?: boolean
  showStatus?: boolean
}

export function Avatar({ user, size = 36, speaking, showStatus }: Props): React.JSX.Element {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className={`flex h-full w-full items-center justify-center rounded-full font-display font-semibold ${
          speaking ? 'speaking' : ''
        }`}
        style={{
          fontSize: size * 0.4,
          color: '#07080c',
          background: `linear-gradient(135deg, ${user.color}, color-mix(in srgb, ${user.color} 55%, #0c0e14))`
        }}
      >
        {user.name[0]}
      </div>
      {showStatus && (
        <span
          className="absolute -right-0.5 -bottom-0.5 block rounded-full border-2 border-void-1"
          style={{
            width: size * 0.34,
            height: size * 0.34,
            background: statusColor[user.status]
          }}
        />
      )}
    </div>
  )
}
