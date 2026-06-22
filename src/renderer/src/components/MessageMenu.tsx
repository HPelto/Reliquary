import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ban, Bell, BellOff, Copy, Hash, Pencil, Pin, PinOff, Reply, Trash2 } from 'lucide-react'
import type { KeepMessage } from '@/net/keep'

export interface MenuTarget {
  msg: KeepMessage
  x: number
  y: number
}

/** Discord-style right-click menu for a message. Portaled to <body> so it
 *  escapes the chat pane's stacking/overflow. Only the actions the current
 *  user is allowed to take are shown. */
export function MessageMenu({
  target,
  canEdit,
  canDelete,
  canPin,
  canBlock,
  blocked,
  silenced,
  onReply,
  onEdit,
  onPin,
  onSilence,
  onBlock,
  onDelete,
  onClose
}: {
  target: MenuTarget
  canEdit: boolean
  canDelete: boolean
  canPin: boolean
  canBlock: boolean
  blocked: boolean
  silenced: boolean
  onReply: () => void
  onEdit: () => void
  onPin: () => void
  onSilence: () => void
  onBlock: () => void
  onDelete: () => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: target.x, top: target.y })

  // keep the menu fully on-screen, flipping off the edges if needed
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    let left = target.x
    let top = target.y
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8
    if (top + height > window.innerHeight - 8) top = window.innerHeight - height - 8
    setPos({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [target])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = (text: string): void => void navigator.clipboard.writeText(text)

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[190]"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={ref}
        style={{ position: 'fixed', left: pos.left, top: pos.top }}
        className="glass palette-in z-[200] w-[212px] rounded-xl p-1.5 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]"
      >
        <Item icon={<Reply size={14} />} label="Reply" onClick={onReply} onClose={onClose} />
        {canEdit && (
          <Item icon={<Pencil size={14} />} label="Edit Message" onClick={onEdit} onClose={onClose} />
        )}
        {canPin && (
          <Item
            icon={target.msg.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            label={target.msg.pinned ? 'Unpin Message' : 'Pin Message'}
            onClick={onPin}
            onClose={onClose}
          />
        )}
        <Item
          icon={<Copy size={14} />}
          label="Copy Text"
          onClick={() => copy(target.msg.content)}
          onClose={onClose}
        />
        <Item
          icon={<Hash size={14} />}
          label="Copy Message ID"
          onClick={() => copy(String(target.msg.id))}
          onClose={onClose}
        />
        {canBlock && (
          <>
            <div className="my-1 h-px bg-edge" />
            <Item
              icon={silenced ? <Bell size={14} /> : <BellOff size={14} />}
              label={silenced ? 'Unsilence User' : 'Silence User'}
              onClick={onSilence}
              onClose={onClose}
            />
            <Item
              danger
              icon={<Ban size={14} />}
              label={blocked ? 'Unblock User' : 'Block User'}
              onClick={onBlock}
              onClose={onClose}
            />
          </>
        )}
        {canDelete && (
          <>
            <div className="my-1 h-px bg-edge" />
            <Item
              danger
              icon={<Trash2 size={14} />}
              label="Delete Message"
              onClick={onDelete}
              onClose={onClose}
            />
          </>
        )}
      </div>
    </>,
    document.body
  )
}

function Item({
  icon,
  label,
  onClick,
  onClose,
  danger
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  onClose: () => void
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={() => {
        onClick()
        onClose()
      }}
      className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
        danger ? 'text-ember hover:bg-ember/10' : 'text-mid hover:bg-void-3 hover:text-hi'
      }`}
    >
      <span>{label}</span>
      <span className={danger ? 'text-ember' : 'text-lo'}>{icon}</span>
    </button>
  )
}
