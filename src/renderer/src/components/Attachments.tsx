import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { getKeep } from '@/net/bind'
import type { Attachment } from '@/net/keep'

const SINGLE_MAX = { w: 400, h: 320 }

/** Images under a message. One image renders at a capped size with its true
 *  aspect ratio; multiple render as a compact gallery grid. Click → lightbox. */
export function AttachmentGrid({
  items,
  instanceId,
  onOpen
}: {
  items: Attachment[]
  instanceId: string
  onOpen: (index: number) => void
}): React.JSX.Element | null {
  const conn = getKeep(instanceId)
  const url = (a: Attachment): string => conn?.mediaUrl(a.hash) ?? ''
  if (!items || items.length === 0) return null

  if (items.length === 1) {
    const a = items[0]
    const scale = Math.min(
      1,
      SINGLE_MAX.w / (a.width || SINGLE_MAX.w),
      SINGLE_MAX.h / (a.height || SINGLE_MAX.h)
    )
    const w = a.width ? Math.round(a.width * scale) : SINGLE_MAX.w
    const h = a.height ? Math.round(a.height * scale) : SINGLE_MAX.h
    return (
      <div className="mt-1.5">
        <img
          src={url(a)}
          alt={a.name}
          onClick={() => onOpen(0)}
          style={{ width: w, height: h }}
          className="cursor-pointer rounded-lg border border-edge object-cover transition-[filter] hover:brightness-90"
          loading="lazy"
          draggable={false}
        />
      </div>
    )
  }

  return (
    <div
      className="mt-1.5 grid max-w-[440px] gap-1"
      style={{ gridTemplateColumns: `repeat(${items.length === 2 ? 2 : 2}, 1fr)` }}
    >
      {items.map((a, i) => (
        <img
          key={a.hash + i}
          src={url(a)}
          alt={a.name}
          onClick={() => onOpen(i)}
          className="aspect-square w-full cursor-pointer rounded-lg border border-edge object-cover transition-[filter] hover:brightness-90"
          loading="lazy"
          draggable={false}
        />
      ))}
    </div>
  )
}

/** Full-app image viewer. Big preview with prev/next arrows; for a gallery, a
 *  thumbnail strip along the bottom to jump between images. */
export function Lightbox({
  items,
  index,
  instanceId,
  onIndex,
  onClose
}: {
  items: Attachment[]
  index: number
  instanceId: string
  onIndex: (i: number) => void
  onClose: () => void
}): React.JSX.Element {
  const conn = getKeep(instanceId)
  const url = (a: Attachment): string => conn?.mediaUrl(a.hash) ?? ''
  const many = items.length > 1
  const prev = (): void => onIndex((index - 1 + items.length) % items.length)
  const next = (): void => onIndex((index + 1) % items.length)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items.length])

  const cur = items[index]
  if (!cur) return <></>

  const arrow =
    'absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-void-1/70 p-2 text-hi backdrop-blur transition-colors hover:bg-void-2'

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex flex-col bg-void-0/92 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <button
        onClick={onClose}
        className="absolute right-4 top-4 z-20 rounded-lg p-2 text-mid transition-colors hover:bg-void-3 hover:text-hi"
        title="Close (Esc)"
      >
        <X size={22} />
      </button>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-6"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {many && (
          <button onClick={prev} className={`${arrow} left-4`} title="Previous (←)">
            <ChevronLeft size={28} />
          </button>
        )}
        <img
          src={url(cur)}
          alt={cur.name}
          className="max-h-full max-w-full rounded-lg object-contain shadow-[0_20px_80px_-12px_rgba(0,0,0,0.9)]"
          draggable={false}
        />
        {many && (
          <button onClick={next} className={`${arrow} right-4`} title="Next (→)">
            <ChevronRight size={28} />
          </button>
        )}
      </div>

      {many && (
        <div
          className="flex shrink-0 items-center justify-center gap-2 overflow-x-auto p-4 scroll-thin"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {items.map((a, i) => (
            <img
              key={a.hash + i}
              src={url(a)}
              alt={a.name}
              onClick={() => onIndex(i)}
              className={`h-16 w-16 shrink-0 cursor-pointer rounded-md object-cover transition ${
                i === index
                  ? 'opacity-100 ring-2 ring-[var(--accent)]'
                  : 'opacity-50 hover:opacity-80'
              }`}
              draggable={false}
            />
          ))}
        </div>
      )}
    </div>,
    document.body
  )
}
