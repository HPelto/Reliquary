import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pin, PinOff, X } from 'lucide-react'
import { getKeep } from '@/net/bind'
import type { KeepMessage } from '@/net/keep'
import { KeepAvatar } from './KeepAvatar'

/** Popover listing a channel's pinned messages, opened from the header pin
 *  icon. Managers can unpin from here. Fetched fresh each open. */
export function PinsPanel({
  instanceId,
  channelId,
  canManage,
  anchor,
  onJump,
  onClose
}: {
  instanceId: string
  channelId: number
  canManage: boolean
  anchor: { right: number; top: number }
  onJump: (id: number) => void
  onClose: () => void
}): React.JSX.Element {
  const [pins, setPins] = useState<KeepMessage[] | null>(null)

  useEffect(() => {
    let live = true
    void getKeep(instanceId)
      ?.loadPins(channelId)
      .then((m) => live && setPins(m))
      .catch(() => live && setPins([]))
    return () => {
      live = false
    }
  }, [instanceId, channelId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const unpin = (id: number): void => {
    void getKeep(instanceId)
      ?.pinMessage(channelId, id, false)
      .then(() => setPins((p) => p?.filter((m) => m.id !== id) ?? null))
      .catch(() => {})
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-[150]" onMouseDown={onClose} />
      <div
        style={{ position: 'fixed', right: anchor.right, top: anchor.top }}
        className="glass palette-in z-[160] max-h-[60vh] w-[340px] overflow-y-auto rounded-xl p-2 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)] scroll-thin"
      >
        <div className="flex items-center justify-between px-2 pb-2">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
            <Pin size={12} /> Pinned Messages
          </span>
          <button onClick={onClose} className="text-lo transition-colors hover:text-hi">
            <X size={15} />
          </button>
        </div>
        {pins === null ? (
          <p className="px-2 py-3 font-mono text-[12px] text-lo">loading…</p>
        ) : pins.length === 0 ? (
          <p className="px-2 py-5 text-center text-[12.5px] text-lo">
            Nothing pinned yet. Right-click a message → Pin.
          </p>
        ) : (
          pins.map((m) => (
            <div
              key={m.id}
              onClick={() => {
                onJump(m.id)
                onClose()
              }}
              className="group/pin flex cursor-pointer gap-2.5 rounded-lg p-2 transition-colors hover:bg-void-3"
            >
              <div className="mt-0.5 shrink-0">
                <KeepAvatar
                  instanceId={instanceId}
                  avatar={m.author.avatar}
                  name={m.author.username}
                  accent={m.author.accent}
                  size={28}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[12px] font-semibold text-hi">
                    {m.author.username}
                  </span>
                  {canManage && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        unpin(m.id)
                      }}
                      className="shrink-0 text-lo opacity-0 transition group-hover/pin:opacity-100 hover:text-ember"
                      title="Unpin"
                    >
                      <PinOff size={13} />
                    </button>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-3 text-[12.5px] break-words text-mid">
                  {m.content || (m.attachments && m.attachments.length > 0 ? '🖼 image' : '')}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </>,
    document.body
  )
}
