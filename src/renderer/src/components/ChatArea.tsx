import { useEffect, useRef, useState } from 'react'
import {
  BarChart2,
  Bell,
  CornerUpRight,
  Hash,
  ImagePlus,
  LayoutGrid,
  Pin,
  Plus,
  Reply as ReplyIcon,
  SendHorizontal,
  SmilePlus,
  Users,
  X
} from 'lucide-react'
import { hostTag } from '@/lib/relic'
import { nameColorFor } from '@/lib/nameStyle'
import { fileToPendingAttachment, type PendingAttachment } from '@/lib/profile'
import { getKeep } from '@/net/bind'
import type { Attachment, KeepMessage } from '@/net/keep'
import { useUi, useWorld } from '@/store'
import { AttachmentGrid, Lightbox } from './Attachments'
import { KeepAvatar } from './KeepAvatar'
import { Md } from './Markdown'
import { MessageMenu, type MenuTarget } from './MessageMenu'
import { PinsPanel } from './PinsPanel'
import { StyledName } from './StyledName'

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function MessageRow({
  msg,
  grouped,
  instanceId,
  locked,
  editing,
  onContextMenu,
  onEditSubmit,
  onEditCancel,
  onOpenLightbox
}: {
  msg: KeepMessage
  grouped: boolean
  instanceId: string
  locked: boolean
  editing: boolean
  onContextMenu: (e: React.MouseEvent, msg: KeepMessage) => void
  onEditSubmit: (msg: KeepMessage, content: string) => void
  onEditCancel: () => void
  onOpenLightbox: (items: Attachment[], index: number) => void
}): React.JSX.Element {
  const a = msg.author
  const viewUser = useUi((s) => s.viewUser)
  const [edit, setEdit] = useState(msg.content)
  useEffect(() => {
    if (editing) setEdit(msg.content)
  }, [editing, msg.content])

  return (
    <div
      onContextMenu={(e) => onContextMenu(e, msg)}
      className={`msg-in group relative rounded-lg px-3 py-0.5 transition-colors duration-100 hover:bg-void-2/50 ${
        grouped ? 'mt-0.5' : 'mt-3'
      } ${msg.pinned ? 'bg-gold/[0.04]' : ''}`}
    >
      {msg.pinned && (
        <Pin
          size={11}
          className="absolute right-3 top-1.5 text-gold/70"
          aria-label="Pinned"
        />
      )}
      {msg.reply_to ? (
        <div className="mb-0.5 ml-12 flex items-center gap-1.5 text-[12px] text-lo">
          <CornerUpRight size={12} className="shrink-0 opacity-60" />
          {msg.reply_preview ? (
            <>
              <span className="shrink-0 font-medium text-mid">
                @{msg.reply_preview.author_username}
              </span>
              <span className="truncate opacity-80">
                {msg.reply_preview.content ||
                  (msg.reply_preview.has_attachments ? '🖼 image' : '')}
              </span>
            </>
          ) : (
            <span className="italic opacity-70">original message deleted</span>
          )}
        </div>
      ) : null}
      <div className="flex gap-3">
        {grouped ? (
          <span className="w-9 shrink-0 pt-1 text-right font-mono text-[9px] text-lo opacity-0 group-hover:opacity-100">
            {timeOf(msg.created_at)}
          </span>
        ) : (
          <button onClick={() => viewUser(a.id)} className="mt-0.5 transition-transform hover:scale-105" title={`◆ ${a.fingerprint}`}>
            <KeepAvatar instanceId={instanceId} avatar={a.avatar} name={a.username} accent={a.accent} size={36} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {!grouped && (
            <div className="flex items-baseline gap-2">
              <StyledName
                name={a.username}
                color={nameColorFor(a, locked)}
                font={locked ? 'default' : a.name_font}
                effect={locked ? 'none' : a.name_effect}
                mode="hover"
                className="text-[13.5px] font-semibold"
                style={{ cursor: 'pointer' }}
              />
              {a.role === 'owner' && <span className="text-[10px] text-gold">♛</span>}
              <span className="font-mono text-[10px] text-lo">{timeOf(msg.created_at)}</span>
            </div>
          )}
          {editing ? (
            <div className="mt-0.5">
              <textarea
                autoFocus
                value={edit}
                onChange={(e) => setEdit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    onEditSubmit(msg, edit)
                  } else if (e.key === 'Escape') {
                    onEditCancel()
                  }
                }}
                rows={Math.min(8, edit.split('\n').length)}
                className="w-full resize-none rounded-lg border border-edge bg-void-2 px-3 py-2 text-[13.5px] text-hi outline-none focus:border-[var(--accent)]/40"
              />
              <div className="mt-1 text-[11px] text-lo">
                escape to{' '}
                <button onClick={onEditCancel} className="text-mid hover:text-hi">
                  cancel
                </button>{' '}
                · enter to{' '}
                <button onClick={() => onEditSubmit(msg, edit)} className="text-mid hover:text-hi">
                  save
                </button>
              </div>
            </div>
          ) : (
            <>
              {msg.content && (
                <p className="text-[13.5px] leading-[1.55] break-words text-hi/90 select-text">
                  <Md text={msg.content} />
                  {!!msg.edited_at && <span className="ml-1 text-[10px] text-lo">(edited)</span>}
                </p>
              )}
              {msg.attachments && msg.attachments.length > 0 && (
                <AttachmentGrid
                  items={msg.attachments}
                  instanceId={instanceId}
                  onOpen={(i) => onOpenLightbox(msg.attachments as Attachment[], i)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function ChatArea(): React.JSX.Element | null {
  const { activeServerId, activeChannelId, toggleMembers, connections, setKeepMessages } = useUi()
  const { servers, instances } = useWorld()
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [lightbox, setLightbox] = useState<{ items: Attachment[]; index: number } | null>(null)
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [uploadOpen, setUploadOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [replyingTo, setReplyingTo] = useState<KeepMessage | null>(null)
  const [pinsOpen, setPinsOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pinBtnRef = useRef<HTMLButtonElement>(null)

  const server = servers.find((s) => s.id === activeServerId)
  const instance = server ? instances.find((i) => i.id === server.instanceId) : undefined
  const keep = server ? connections[server.instanceId] : undefined
  const channel = keep?.world?.channels.find((c) => String(c.id) === activeChannelId)
  const msgs = channel ? keep?.messages[channel.id] : undefined
  const isVoice = channel?.kind === 'voice'

  // lazy-load history the first time a channel is opened
  useEffect(() => {
    if (!server || !channel || msgs !== undefined) return
    const conn = getKeep(server.instanceId)
    if (!conn) return
    void conn
      .loadMessages(channel.id)
      .then((m) => setKeepMessages(server.instanceId, channel.id, m))
      .catch(() => {})
  }, [server, channel, msgs, setKeepMessages])

  // keep the view pinned to the newest message
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs?.length, activeChannelId])

  if (!server) return null

  const self = getKeep(server.instanceId)?.self
  const canManage = self?.role === 'owner' || self?.role === 'admin'

  const send = async (): Promise<void> => {
    const content = draft.trim()
    if ((!content && pending.length === 0) || !channel || isVoice || sending) return
    const conn = getKeep(server.instanceId)
    if (!conn) return
    setSending(true)
    try {
      const uploaded = await Promise.all(pending.map((p) => conn.uploadAttachment(p)))
      await conn.sendMessage(channel.id, content, uploaded, replyingTo?.id)
      setDraft('')
      setPending([])
      setReplyingTo(null)
    } catch {
      /* leave the draft + pending so the user can retry */
    } finally {
      setSending(false)
    }
  }

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    const added: PendingAttachment[] = []
    for (const f of files) {
      try {
        added.push(await fileToPendingAttachment(f))
      } catch {
        /* skip non-image / too-large files */
      }
    }
    setPending((p) => [...p, ...added].slice(0, 10))
  }

  const submitEdit = (msg: KeepMessage, content: string): void => {
    setEditingId(null)
    const c = content.trim()
    if (c === msg.content || (!c && !(msg.attachments && msg.attachments.length > 0))) return
    void getKeep(server.instanceId)?.editMessage(msg.channel_id, msg.id, c).catch(() => {})
  }

  const doDelete = (msg: KeepMessage): void => {
    void getKeep(server.instanceId)?.deleteMessage(msg.channel_id, msg.id).catch(() => {})
  }

  return (
    <main className="relative z-10 flex min-w-0 flex-1 flex-col bg-void-2/40">
      {/* channel header */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-edge px-4">
        <Hash size={18} className="text-lo" />
        <span className="text-[14px] font-semibold">{channel?.name ?? '…'}</span>
        <span className="h-4 w-px bg-edge" />
        <span className="truncate text-[12px] text-lo">
          Live · self-hosted — your hardware, your rules
        </span>
        <div className="ml-auto flex items-center gap-1 text-mid">
          <button className="rounded-md p-1.5 transition-colors hover:bg-void-3 hover:text-hi">
            <Bell size={16} />
          </button>
          <button
            ref={pinBtnRef}
            onClick={() => setPinsOpen((v) => !v)}
            className={`rounded-md p-1.5 transition-colors hover:bg-void-3 hover:text-hi ${
              pinsOpen ? 'bg-void-3 text-hi' : ''
            }`}
            title="Pinned messages"
          >
            <Pin size={16} />
          </button>
          <button
            onClick={toggleMembers}
            className="rounded-md p-1.5 transition-colors hover:bg-void-3 hover:text-hi"
          >
            <Users size={16} />
          </button>
        </div>
      </header>

      {/* messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 scroll-thin">
        <div className="mx-auto flex max-w-[860px] flex-col">
          {!channel ? (
            <p className="px-3 text-[13px] text-lo">Pick a channel on the left.</p>
          ) : (
            <>
              <div className="mb-4 px-3">
                <div
                  className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl text-2xl"
                  style={{ background: 'color-mix(in srgb, var(--accent) 18%, var(--color-void-3))' }}
                >
                  #
                </div>
                <h2 className="font-display text-xl font-bold">Welcome to #{channel.name}</h2>
                <p className="mt-1 text-[13px] text-lo">
                  Live on{' '}
                  <span className="font-mono text-[12px] text-pulse">
                    {instance ? hostTag(instance.domain) : 'a keep'}
                  </span>{' '}
                  — a real, self-hosted Keep. Its address stays private.
                </p>
              </div>
              {isVoice ? (
                <p className="px-3 text-[13px] text-lo">This is a voice channel — text lives elsewhere.</p>
              ) : msgs === undefined ? (
                <p className="px-3 font-mono text-[12px] text-lo">syncing history…</p>
              ) : msgs.length === 0 ? (
                <p className="px-3 text-[13px] text-lo">
                  No messages yet. The keep stands silent — break it in.
                </p>
              ) : (
                msgs.map((m, i) => (
                  <MessageRow
                    key={m.id}
                    msg={m}
                    instanceId={server.instanceId}
                    locked={!!keep?.world?.lock_name_style}
                    editing={editingId === m.id}
                    onContextMenu={(e, msg) => {
                      e.preventDefault()
                      setMenu({ msg, x: e.clientX, y: e.clientY })
                    }}
                    onEditSubmit={submitEdit}
                    onEditCancel={() => setEditingId(null)}
                    onOpenLightbox={(items, index) => setLightbox({ items, index })}
                    grouped={
                      i > 0 &&
                      msgs[i - 1].author.id === m.author.id &&
                      m.created_at - msgs[i - 1].created_at < 5 * 60_000
                    }
                  />
                ))
              )}
            </>
          )}
        </div>
      </div>

      {/* composer */}
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto max-w-[860px]">
          {replyingTo && (
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-edge bg-void-2 px-3 py-1.5 text-[12px] text-mid">
              <ReplyIcon size={13} className="text-[var(--accent)]" />
              <span>
                Replying to <span className="font-medium text-hi">{replyingTo.author.username}</span>
              </span>
              <button
                onClick={() => setReplyingTo(null)}
                className="ml-auto text-lo transition-colors hover:text-ember"
                title="Cancel reply"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {pending.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2 rounded-xl border border-edge bg-void-2 p-2">
              {pending.map((p, i) => (
                <div
                  key={p.ref.hash + i}
                  className="group/att relative h-20 w-20 overflow-hidden rounded-lg border border-edge"
                >
                  <img src={p.ref.dataUrl} alt={p.name} className="h-full w-full object-cover" />
                  <button
                    onClick={() => setPending((arr) => arr.filter((_, j) => j !== i))}
                    className="absolute right-1 top-1 rounded-md bg-void-0/80 p-0.5 text-mid opacity-0 transition group-hover/att:opacity-100 hover:text-ember"
                    title="Remove"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 rounded-xl border border-edge bg-void-2 px-3 py-2.5 transition-colors duration-200 focus-within:border-[var(--accent)]/40 focus-within:shadow-[0_0_24px_-6px_var(--accent)]">
            <div className="relative">
              <button
                onClick={() => setUploadOpen((v) => !v)}
                disabled={isVoice || !channel}
                className="text-lo transition-colors hover:text-[var(--accent)] disabled:opacity-40"
                title="Upload"
              >
                <Plus size={20} />
              </button>
              {uploadOpen && (
                <>
                  <div className="fixed inset-0 z-[110]" onMouseDown={() => setUploadOpen(false)} />
                  <div className="glass palette-in absolute bottom-9 left-0 z-[120] w-[184px] rounded-xl p-1.5 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]">
                    <button
                      onClick={() => {
                        setUploadOpen(false)
                        fileRef.current?.click()
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-mid transition-colors hover:bg-void-3 hover:text-hi"
                    >
                      <ImagePlus size={15} className="text-[var(--accent)]" /> Upload a File
                    </button>
                    <div className="flex w-full cursor-not-allowed items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-lo/60">
                      <BarChart2 size={15} /> Create Poll
                      <span className="ml-auto text-[10px]">soon</span>
                    </div>
                    <div className="flex w-full cursor-not-allowed items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-lo/60">
                      <LayoutGrid size={15} /> Use Apps
                      <span className="ml-auto text-[10px]">soon</span>
                    </div>
                  </div>
                </>
              )}
            </div>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder={
                isVoice ? 'Voice channels have no text — yet' : `Message #${channel?.name ?? ''}`
              }
              disabled={isVoice || !channel}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-hi outline-none select-text placeholder:text-lo disabled:opacity-50"
            />
            <button className="text-lo transition-colors hover:text-gold">
              <SmilePlus size={18} />
            </button>
            <button
              onClick={() => void send()}
              disabled={sending || isVoice || !channel}
              className="rounded-lg bg-[var(--accent)]/15 p-1.5 text-[var(--accent)] transition-all duration-150 hover:bg-[var(--accent)] hover:text-void-0 disabled:opacity-40 disabled:hover:bg-[var(--accent)]/15 disabled:hover:text-[var(--accent)]"
            >
              <SendHorizontal size={16} />
            </button>
          </div>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => void onFiles(e)}
      />

      {menu && (
        <MessageMenu
          target={menu}
          canEdit={!!self && menu.msg.author.id === self.id}
          canDelete={!!self && (menu.msg.author.id === self.id || canManage)}
          canPin={canManage}
          onReply={() => setReplyingTo(menu.msg)}
          onEdit={() => setEditingId(menu.msg.id)}
          onPin={() =>
            void getKeep(server.instanceId)
              ?.pinMessage(menu.msg.channel_id, menu.msg.id, !menu.msg.pinned)
              .catch(() => {})
          }
          onDelete={() => doDelete(menu.msg)}
          onClose={() => setMenu(null)}
        />
      )}

      {pinsOpen && channel && (
        <PinsPanel
          instanceId={server.instanceId}
          channelId={channel.id}
          canManage={canManage}
          anchor={(() => {
            const r = pinBtnRef.current?.getBoundingClientRect()
            return { right: r ? window.innerWidth - r.right : 16, top: r ? r.bottom + 8 : 52 }
          })()}
          onClose={() => setPinsOpen(false)}
        />
      )}

      {lightbox && (
        <Lightbox
          items={lightbox.items}
          index={lightbox.index}
          instanceId={server.instanceId}
          onIndex={(i) => setLightbox((lb) => (lb ? { ...lb, index: i } : lb))}
          onClose={() => setLightbox(null)}
        />
      )}
    </main>
  )
}
