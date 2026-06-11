import { useEffect, useState } from 'react'
import { Check, Copy, Trash2 } from 'lucide-react'
import { encodeRelicCode, joinLink, parseHostPort } from '@/lib/relic'
import type { KeepConnection, KeepInvite } from '@/net/keep'

const CUSTOM = '__custom__'
const isLoopback = (host: string): boolean => /^(localhost|127\.|::1|0\.0\.0\.0)/i.test(host)

export function inviteAlive(inv: KeepInvite): boolean {
  if (inv.expires_at > 0 && Date.now() > inv.expires_at) return false
  if (inv.max_uses > 0 && inv.uses >= inv.max_uses) return false
  return true
}

export function expiryText(inv: KeepInvite): string {
  if (!inv.expires_at) return 'never expires'
  const ms = inv.expires_at - Date.now()
  if (ms < 0) return 'expired'
  const h = Math.round(ms / 36e5)
  return h < 1 ? 'expires <1h' : h < 48 ? `expires in ${h}h` : `expires in ${Math.round(h / 24)}d`
}

/** Create + list + copy (encrypted REL3 code / relic:// link) + revoke.
 *  Shared by the Invite modal and the Keep Settings invites tab. */
export function InvitesPanel({ conn }: { conn: KeepConnection }): React.JSX.Element {
  const [invites, setInvites] = useState<KeepInvite[] | null>(null)
  const [ttl, setTtl] = useState(604800)
  const [maxUses, setMaxUses] = useState(0)
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // which address the encrypted invite carries. A Keep joined over loopback
  // would otherwise bake "localhost" into the code — useless to a LAN peer.
  const [net, setNet] = useState<{ candidates: string[]; port: number } | null>(null)
  const [selected, setSelected] = useState<string>(conn.host)
  const [custom, setCustom] = useState('')

  const refresh = (): void => {
    void conn.listInvites().then(setInvites).catch(() => setInvites([]))
  }
  useEffect(refresh, [conn])

  useEffect(() => {
    void conn
      .netAddresses()
      .then((n) => {
        setNet(n)
        // default to a LAN IP when the owner is connected over loopback
        const lan = n.candidates[0]
        setSelected(isLoopback(conn.host) && lan ? lan : conn.host)
      })
      .catch(() => {
        setNet({ candidates: [], port: conn.port })
        setSelected(conn.host)
      })
  }, [conn])

  // the host + port actually embedded into the code/link
  const chosen = (): { host: string; port: number } => {
    const port = net?.port ?? conn.port
    if (selected === CUSTOM) {
      const raw = custom.trim()
      const parsed = parseHostPort(raw)
      if (parsed) return { host: parsed.host, port: /:\d+$/.test(raw) ? parsed.port : port }
      return { host: raw || conn.host, port }
    }
    return { host: selected || conn.host, port }
  }

  const act = (fn: () => Promise<unknown>): void => {
    setError(null)
    void fn()
      .then(refresh)
      .catch((e: Error) => setError(e.message))
  }

  const copy = (key: string, text: string): void => {
    void navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }
  const copyCode = (inv: KeepInvite): void =>
    void encodeRelicCode({ ...chosen(), token: inv.token }).then((c) =>
      copy(`code-${inv.token}`, c)
    )
  const copyLink = (inv: KeepInvite): void =>
    void encodeRelicCode({ ...chosen(), token: inv.token }).then((c) =>
      copy(`link-${inv.token}`, joinLink(c))
    )

  return (
    <>
      {invites === null ? (
        <p className="font-mono text-[12px] text-lo">loading invites…</p>
      ) : invites.length === 0 ? (
        <p className="text-[13px] text-lo">No invites yet — mint one below.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {invites.map((inv) => (
            <div
              key={inv.token}
              className="flex items-center gap-2.5 rounded-lg border border-edge bg-void-0/50 px-3 py-2"
            >
              <span className="font-mono text-[12px] text-pulse">{inv.token}</span>
              <span
                className={`rounded-full border px-1.5 py-px text-[9.5px] ${
                  inviteAlive(inv)
                    ? 'border-pulse/30 bg-pulse/10 text-pulse'
                    : 'border-ember/30 bg-ember/10 text-ember'
                }`}
              >
                {inviteAlive(inv) ? 'active' : 'dead'}
              </span>
              <span className="font-mono text-[10px] text-lo">
                {inv.uses}
                {inv.max_uses ? `/${inv.max_uses}` : ''} uses · {expiryText(inv)}
              </span>
              <span className="ml-auto flex gap-1">
                <button
                  onClick={() => copyCode(inv)}
                  title="Copy encrypted REL3 code"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] text-mid transition-colors hover:bg-void-3 hover:text-hi"
                >
                  {copied === `code-${inv.token}` ? (
                    <Check size={12} className="text-pulse" />
                  ) : (
                    <Copy size={12} />
                  )}
                  code
                </button>
                <button
                  onClick={() => copyLink(inv)}
                  title="Copy relic:// join link"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] text-mid transition-colors hover:bg-void-3 hover:text-hi"
                >
                  {copied === `link-${inv.token}` ? (
                    <Check size={12} className="text-pulse" />
                  ) : (
                    <Copy size={12} />
                  )}
                  link
                </button>
                <button
                  onClick={() => act(() => conn.revokeInvite(inv.token))}
                  title="Revoke"
                  className="rounded-md p-1 text-mid transition-colors hover:bg-ember/15 hover:text-ember"
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4">
        <label className="mb-1.5 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
          Address others will use
        </label>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="w-full rounded-xl border border-edge bg-void-0/70 px-2.5 py-2 text-[12.5px] text-mid outline-none focus:border-relic/50"
        >
          {Array.from(new Set([...(net?.candidates ?? []), conn.host].filter(Boolean))).map((h) => (
            <option key={h} value={h}>
              {h}
              {(net?.candidates ?? []).includes(h)
                ? ' · LAN'
                : isLoopback(h)
                  ? ' · this machine only'
                  : ''}
            </option>
          ))}
          <option value={CUSTOM}>Custom address…</option>
        </select>
        {selected === CUSTOM && (
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="e.g. 203.0.113.7:7777 or keep.example.com"
            className="mt-2 w-full rounded-xl border border-edge bg-void-0/70 px-3 py-2 text-[12.5px] text-hi outline-none select-text focus:border-relic/50"
          />
        )}
        <p className="mt-1.5 text-[11px] leading-relaxed text-lo">
          On a LAN, use your local IP (192.168.x.x). Over the internet, use your public IP +
          forwarded port or a domain. <span className="text-mid">localhost</span> only works on this
          machine.
        </p>
      </div>

      <div className="mt-3 flex gap-2">
        <select
          value={ttl}
          onChange={(e) => setTtl(Number(e.target.value))}
          className="rounded-xl border border-edge bg-void-0/70 px-2 py-2 text-[12.5px] text-mid outline-none"
        >
          <option value={3600}>expires in 1 hour</option>
          <option value={86400}>expires in 1 day</option>
          <option value={604800}>expires in 7 days</option>
          <option value={-1}>never expires</option>
        </select>
        <select
          value={maxUses}
          onChange={(e) => setMaxUses(Number(e.target.value))}
          className="rounded-xl border border-edge bg-void-0/70 px-2 py-2 text-[12.5px] text-mid outline-none"
        >
          <option value={1}>1 use</option>
          <option value={5}>5 uses</option>
          <option value={0}>unlimited uses</option>
        </select>
        <button
          onClick={() => act(() => conn.createInvite(ttl, maxUses))}
          className="ml-auto rounded-xl bg-gold px-4 py-2 text-[13px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_18px_rgba(232,201,122,0.45)]"
        >
          Mint invite
        </button>
      </div>
      {error && <p className="mt-3 text-[12px] text-ember">{error}</p>}
    </>
  )
}
