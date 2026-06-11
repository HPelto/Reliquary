import { useEffect } from 'react'
import { useUi, useWorld } from '@/store'
import { UserCard } from './UserCard'

/** Click a member → their full profile (with About me) as a centered card. */
export function UserProfileOverlay(): React.JSX.Element | null {
  const { viewedUserId, viewUser, activeServerId, connections } = useUi()
  const { servers } = useWorld()

  useEffect(() => {
    if (viewedUserId === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') viewUser(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewedUserId, viewUser])

  if (viewedUserId === null) return null
  const server = servers.find((s) => s.id === activeServerId)
  if (!server) return null
  const world = connections[server.instanceId]?.world
  const member = world?.members.find((m) => m.id === viewedUserId)
  if (!member) return null

  return (
    <div
      className="absolute inset-0 z-[160] flex items-center justify-center bg-void-0/60 backdrop-blur-[2px]"
      onMouseDown={() => viewUser(null)}
    >
      <div className="palette-in" onMouseDown={(e) => e.stopPropagation()}>
        <UserCard member={member} instanceId={server.instanceId} locked={!!world?.lock_name_style} full />
      </div>
    </div>
  )
}
