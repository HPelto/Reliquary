import { useEffect, useRef } from 'react'
import { Bell, CalendarPlus, Settings, UserPlus } from 'lucide-react'
import { useUi } from '@/store'

/** The dropdown that opens from the server banner. Manage items (invite,
 *  settings, create event) show only for owners/admins. */
export function ServerMenu({
  open,
  onClose,
  canManage
}: {
  open: boolean
  onClose: () => void
  canManage: boolean
}): React.JSX.Element | null {
  const { openInvite, openServerSettings, openNotif, openCreateEvent } = useUi()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  const run = (fn: () => void): void => {
    fn()
    onClose()
  }

  const item =
    'flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px] text-mid transition-colors hover:bg-void-3 hover:text-hi'

  return (
    <div
      ref={ref}
      className="glass palette-in absolute top-full right-3 left-3 z-50 mt-1 rounded-xl p-1.5 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]"
    >
      {canManage && (
        <>
          <button onClick={() => run(openInvite)} className={item}>
            Invite to Keep <UserPlus size={15} />
          </button>
          <button onClick={() => run(openServerSettings)} className={item}>
            Keep Settings <Settings size={15} />
          </button>
          <button onClick={() => run(openCreateEvent)} className={item}>
            Create Event <CalendarPlus size={15} />
          </button>
          <div className="my-1 h-px bg-edge" />
        </>
      )}
      <button onClick={() => run(openNotif)} className={item}>
        Notification Settings <Bell size={15} />
      </button>
    </div>
  )
}
