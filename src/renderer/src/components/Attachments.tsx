import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, File as FileIcon, Film, Music, X } from 'lucide-react'
import { getKeep } from '@/net/bind'
import { attachmentKind, type Attachment } from '@/net/keep'

const SINGLE_MAX = { w: 400, h: 320 }

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function extOf(a: Attachment): string {
  const m = a.name.match(/\.([a-z0-9]+)$/i)
  if (m) return m[1].toUpperCase().slice(0, 4)
  const sub = (a.content_type.split('/')[1] ?? '').replace(/[^a-z0-9]/gi, '')
  return sub.toUpperCase().slice(0, 4) || 'FILE'
}

/** All attachments under a message: images render as a gallery (→ lightbox),
 *  while video / audio / other files render as their own players or cards. */
export function MessageAttachments({
  items,
  instanceId,
  onOpenLightbox
}: {
  items: Attachment[]
  instanceId: string
  onOpenLightbox: (images: Attachment[], index: number) => void
}): React.JSX.Element | null {
  if (!items || items.length === 0) return null
  const images = items.filter((a) => attachmentKind(a) === 'image')
  const others = items.filter((a) => attachmentKind(a) !== 'image')
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {images.length > 0 && (
        <ImageGrid items={images} instanceId={instanceId} onOpen={(i) => onOpenLightbox(images, i)} />
      )}
      {others.map((a, i) => (
        <AttachmentBlock key={a.hash + i} a={a} instanceId={instanceId} />
      ))}
    </div>
  )
}

function ImageGrid({
  items,
  instanceId,
  onOpen
}: {
  items: Attachment[]
  instanceId: string
  onOpen: (index: number) => void
}): React.JSX.Element {
  const conn = getKeep(instanceId)
  const url = (a: Attachment): string => conn?.mediaUrl(a.hash) ?? ''

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
      <img
        src={url(a)}
        alt={a.name}
        onClick={() => onOpen(0)}
        style={{ width: w, height: h }}
        className="cursor-pointer rounded-lg border border-edge object-cover transition-[filter] hover:brightness-90"
        loading="lazy"
        draggable={false}
      />
    )
  }
  return (
    <div className="grid max-w-[440px] grid-cols-2 gap-1">
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

function AttachmentBlock({
  a,
  instanceId
}: {
  a: Attachment
  instanceId: string
}): React.JSX.Element {
  const conn = getKeep(instanceId)
  const url = conn?.mediaUrl(a.hash) ?? ''
  const dl = conn?.mediaDownloadUrl(a.hash, a.name) ?? url
  const kind = attachmentKind(a)

  const footer = (icon: React.ReactNode): React.JSX.Element => (
    <div className="flex items-center gap-2 px-3 py-1.5">
      {icon}
      <span className="truncate text-[12px] text-mid">{a.name}</span>
      <span className="ml-auto shrink-0 text-[11px] text-lo">{formatBytes(a.size)}</span>
      <a
        href={dl}
        download={a.name}
        className="shrink-0 text-lo transition-colors hover:text-hi"
        title="Download"
      >
        <Download size={14} />
      </a>
    </div>
  )

  if (kind === 'video') {
    return (
      <div className="w-fit max-w-full overflow-hidden rounded-lg border border-edge bg-void-0">
        <video
          src={url}
          controls
          preload="metadata"
          className="block max-h-[360px] max-w-[480px]"
        />
        <div className="border-t border-edge bg-void-2">{footer(<Film size={13} className="shrink-0 text-relic" />)}</div>
      </div>
    )
  }

  if (kind === 'audio') {
    return (
      <div className="w-[380px] max-w-full rounded-lg border border-edge bg-void-2 p-3">
        <div className="mb-2 flex items-center gap-2">
          <Music size={15} className="shrink-0 text-relic" />
          <span className="truncate text-[12.5px] font-medium text-hi">{a.name}</span>
          <span className="ml-auto shrink-0 text-[11px] text-lo">{formatBytes(a.size)}</span>
          <a
            href={dl}
            download={a.name}
            className="shrink-0 text-lo transition-colors hover:text-hi"
            title="Download"
          >
            <Download size={14} />
          </a>
        </div>
        <audio src={url} controls className="w-full" />
      </div>
    )
  }

  // generic file card
  return (
    <a
      href={dl}
      download={a.name}
      className="flex w-[340px] max-w-full items-center gap-3 rounded-lg border border-edge bg-void-2 p-2.5 transition-colors hover:border-relic/40"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-void-3 text-[9.5px] font-bold tracking-wide text-relic uppercase">
        {extOf(a)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-hi">{a.name}</div>
        <div className="text-[11px] text-lo">
          {formatBytes(a.size)} · {extOf(a)}
        </div>
      </div>
      <Download size={15} className="shrink-0 text-lo" />
    </a>
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
      {/* sits below the window's title-bar / native controls so it isn't clipped */}
      <button
        onClick={onClose}
        className="absolute right-5 top-12 z-20 rounded-lg p-2 text-mid transition-colors hover:bg-void-3 hover:text-hi"
        title="Close (Esc)"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <X size={22} />
      </button>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-16 pt-16 pb-8"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {many && (
          <button onClick={prev} className={`${arrow} left-6`} title="Previous (←)">
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
          <button onClick={next} className={`${arrow} right-6`} title="Next (→)">
            <ChevronRight size={28} />
          </button>
        )}
      </div>

      {many && (
        <div
          className="flex shrink-0 items-center justify-center gap-2 overflow-x-auto px-6 pb-6 scroll-thin"
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
