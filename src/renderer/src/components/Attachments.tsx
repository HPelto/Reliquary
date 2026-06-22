import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, File as FileIcon, Music, Play, X } from 'lucide-react'
import { getKeep } from '@/net/bind'
import { attachmentKind, type Attachment } from '@/net/keep'
import { VideoPlayer } from './VideoPlayer'

const SINGLE_MAX = { w: 420, h: 340 }

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

const isVisual = (a: Attachment): boolean => {
  const k = attachmentKind(a)
  return k === 'image' || k === 'video'
}

/** Capped display box that preserves the media's aspect ratio. */
function fitBox(a: Attachment): { width: number; height: number } {
  const scale = Math.min(
    1,
    SINGLE_MAX.w / (a.width || SINGLE_MAX.w),
    SINGLE_MAX.h / (a.height || SINGLE_MAX.h)
  )
  return {
    width: a.width ? Math.round(a.width * scale) : SINGLE_MAX.w,
    height: a.height ? Math.round(a.height * scale) : Math.round((SINGLE_MAX.w * 9) / 16)
  }
}

/** All attachments under a message. Images + videos render together as visual
 *  media (single clean preview or a mixed gallery → lightbox); audio and other
 *  files render as their own players / cards below. */
export function MessageAttachments({
  items,
  instanceId,
  onOpenLightbox
}: {
  items: Attachment[]
  instanceId: string
  onOpenLightbox: (visuals: Attachment[], index: number, startAt?: number, autoPlay?: boolean) => void
}): React.JSX.Element | null {
  if (!items || items.length === 0) return null
  const visuals = items.filter(isVisual)
  const others = items.filter((a) => !isVisual(a))
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {visuals.length > 0 && (
        <VisualMedia items={visuals} instanceId={instanceId} onOpen={onOpenLightbox} />
      )}
      {others.map((a, i) => (
        <AttachmentBlock key={a.hash + i} a={a} instanceId={instanceId} />
      ))}
    </div>
  )
}

function VisualMedia({
  items,
  instanceId,
  onOpen
}: {
  items: Attachment[]
  instanceId: string
  onOpen: (visuals: Attachment[], index: number, startAt?: number, autoPlay?: boolean) => void
}): React.JSX.Element {
  const conn = getKeep(instanceId)
  const url = (a: Attachment): string => conn?.mediaUrl(a.hash) ?? ''
  const dl = (a: Attachment): string => conn?.mediaDownloadUrl(a.hash, a.name) ?? url(a)

  // single visual: a clean, aspect-preserving preview
  if (items.length === 1) {
    const a = items[0]
    const box = fitBox(a)
    if (attachmentKind(a) === 'video') {
      return (
        <VideoPlayer
          src={url(a)}
          name={a.name}
          downloadUrl={dl(a)}
          onExpand={(time, playing) => onOpen(items, 0, time, playing)}
          boxStyle={{ width: box.width, height: box.height }}
        />
      )
    }
    return (
      <img
        src={url(a)}
        alt={a.name}
        onClick={() => onOpen(items, 0)}
        style={{ width: box.width, height: box.height }}
        className="cursor-pointer rounded-lg border border-edge object-cover transition-[filter] hover:brightness-90"
        loading="lazy"
        draggable={false}
      />
    )
  }

  // gallery: mixed images + videos, each a square thumbnail → lightbox
  return (
    <div className="grid max-w-[440px] grid-cols-2 gap-1">
      {items.map((a, i) => (
        <div
          key={a.hash + i}
          onClick={() => onOpen(items, i, 0, attachmentKind(a) === 'video')}
          className="group/cell relative aspect-square w-full cursor-pointer overflow-hidden rounded-lg border border-edge bg-void-0"
        >
          {attachmentKind(a) === 'video' ? (
            <video
              src={`${url(a)}#t=0.1`}
              muted
              preload="metadata"
              className="h-full w-full object-cover"
            />
          ) : (
            <img
              src={url(a)}
              alt={a.name}
              className="h-full w-full object-cover transition-[filter] group-hover/cell:brightness-90"
              loading="lazy"
              draggable={false}
            />
          )}
          {attachmentKind(a) === 'video' && (
            <div className="absolute inset-0 flex items-center justify-center bg-void-0/15 transition group-hover/cell:bg-void-0/30">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-void-0/70 backdrop-blur">
                <Play size={20} className="ml-0.5 text-hi" fill="currentColor" />
              </div>
            </div>
          )}
        </div>
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

  if (attachmentKind(a) === 'audio') {
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
      <FileIcon size={15} className="shrink-0 text-lo" />
    </a>
  )
}

/** Full-app viewer for a visual gallery — images show as images, videos play
 *  with controls. Prev/next arrows + a thumbnail strip (videos badged). */
export function Lightbox({
  items,
  index,
  instanceId,
  startAt,
  autoPlay,
  onIndex,
  onClose
}: {
  items: Attachment[]
  index: number
  instanceId: string
  startAt?: number
  autoPlay?: boolean
  onIndex: (i: number) => void
  onClose: () => void
}): React.JSX.Element {
  const conn = getKeep(instanceId)
  const url = (a: Attachment): string => conn?.mediaUrl(a.hash) ?? ''
  const dl = (a: Attachment): string => conn?.mediaDownloadUrl(a.hash, a.name) ?? url(a)
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
  const isVid = attachmentKind(cur) === 'video'

  const arrow =
    'absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-void-1/70 p-2 text-hi backdrop-blur transition-colors hover:bg-void-2'

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex flex-col bg-void-0/92 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      {/* below the window's title-bar / native controls so nothing is clipped */}
      <div
        className="absolute right-5 top-12 z-20 flex items-center gap-1"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <a
          href={dl(cur)}
          download={cur.name}
          className="rounded-lg p-2 text-mid transition-colors hover:bg-void-3 hover:text-hi"
          title={`Download ${cur.name}`}
        >
          <Download size={20} />
        </a>
        <button
          onClick={onClose}
          className="rounded-lg p-2 text-mid transition-colors hover:bg-void-3 hover:text-hi"
          title="Close (Esc)"
        >
          <X size={22} />
        </button>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-16 pt-16 pb-8"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {many && (
          <button onClick={prev} className={`${arrow} left-6`} title="Previous (←)">
            <ChevronLeft size={28} />
          </button>
        )}
        {isVid ? (
          <VideoPlayer
            key={cur.hash}
            src={url(cur)}
            name={cur.name}
            downloadUrl={dl(cur)}
            startAt={startAt}
            autoPlay={autoPlay}
            large
          />
        ) : (
          <img
            src={url(cur)}
            alt={cur.name}
            className="max-h-full max-w-full rounded-lg object-contain shadow-[0_20px_80px_-12px_rgba(0,0,0,0.9)]"
            draggable={false}
          />
        )}
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
            <div
              key={a.hash + i}
              onClick={() => onIndex(i)}
              className={`relative h-16 w-16 shrink-0 cursor-pointer overflow-hidden rounded-md transition ${
                i === index ? 'opacity-100 ring-2 ring-[var(--accent)]' : 'opacity-50 hover:opacity-80'
              }`}
            >
              {attachmentKind(a) === 'video' ? (
                <video src={`${url(a)}#t=0.1`} muted preload="metadata" className="h-full w-full object-cover" />
              ) : (
                <img src={url(a)} alt={a.name} className="h-full w-full object-cover" draggable={false} />
              )}
              {attachmentKind(a) === 'video' && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Play size={14} className="text-hi drop-shadow" fill="currentColor" />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body
  )
}
