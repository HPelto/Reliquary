import { useEffect, useRef, useState } from 'react'
import { Bell, Gift, Hash, Pin, SendHorizontal, SmilePlus, Users } from 'lucide-react'
import { hostTag } from '@/lib/relic'
import { nameColorFor } from '@/lib/nameStyle'
import { getKeep } from '@/net/bind'
import type { KeepMessage } from '@/net/keep'
import { useUi, useWorld } from '@/store'
import { KeepAvatar } from './KeepAvatar'
import { Md } from './Markdown'
import { StyledName } from './StyledName'

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function MessageRow({
  msg,
  grouped,
  instanceId,
  locked
}: {
  msg: KeepMessage
  grouped: boolean
  instanceId: string
  locked: boolean
}): React.JSX.Element {
  const a = msg.author
  const viewUser = useUi((s) => s.viewUser)
  return (
    <div className="msg-in group relative rounded-lg px-3 py-0.5 transition-colors duration-100 hover:bg-void-2/50">
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
          <p className="text-[13.5px] leading-[1.55] break-words text-hi/90 select-text">
            <Md text={msg.content} />
          </p>
        </div>
      </div>
    </div>
  )
}

export function ChatArea(): React.JSX.Element | null {
  const { activeServerId, activeChannelId, toggleMembers, connections, setKeepMessages } = useUi()
  const { servers, instances } = useWorld()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

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

  const send = (): void => {
    const content = draft.trim()
    if (!content || !channel || isVoice) return
    setDraft('')
    void getKeep(server.instanceId)?.sendMessage(channel.id, content)
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
          {[Bell, Pin].map((Icon, i) => (
            <button key={i} className="rounded-md p-1.5 transition-colors hover:bg-void-3 hover:text-hi">
              <Icon size={16} />
            </button>
          ))}
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
        <div className="mx-auto flex max-w-[860px] flex-col gap-2">
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
        <div className="mx-auto flex max-w-[860px] items-center gap-2 rounded-xl border border-edge bg-void-2 px-3 py-2.5 transition-colors duration-200 focus-within:border-[var(--accent)]/40 focus-within:shadow-[0_0_24px_-6px_var(--accent)]">
          <button className="text-lo transition-colors hover:text-pulse">
            <Gift size={18} />
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
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
            onClick={send}
            className="rounded-lg bg-[var(--accent)]/15 p-1.5 text-[var(--accent)] transition-all duration-150 hover:bg-[var(--accent)] hover:text-void-0"
          >
            <SendHorizontal size={16} />
          </button>
        </div>
      </div>
    </main>
  )
}
