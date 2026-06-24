/**
 * Settings → Account: opt-in experimental features. Currently the P2P transport
 * — routing a Keep over the encrypted WebRTC data channel instead of HTTP +
 * WebSocket. The choice is durable and read when a connection is (re)created, so
 * it takes effect on the next join or restart, not retroactively on live ones.
 */

import { useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { getExperiments, setExperiments } from '@/lib/experiments'

function Toggle({
  on,
  onClick,
  disabled
}: {
  on: boolean
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40 ${
        on ? 'bg-relic' : 'border border-edge bg-void-3'
      }`}
    >
      <span
        className={`inline-block h-[18px] w-[18px] rounded-full bg-hi shadow-sm transition-transform duration-200 ${
          on ? 'translate-x-[23px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
}

export function ExperimentsCard(): React.JSX.Element {
  const [p2p, setP2p] = useState(() => getExperiments().p2pTransport)
  const [voiceTransport, setVoiceTransport] = useState(() => getExperiments().voiceOnTransport)

  const toggleP2p = (): void => {
    const next = !p2p
    setP2p(next)
    setExperiments({ p2pTransport: next })
  }
  const toggleVoice = (): void => {
    const next = !voiceTransport
    setVoiceTransport(next)
    setExperiments({ voiceOnTransport: next })
  }

  return (
    <div className="mt-6 rounded-2xl border border-edge bg-void-1 p-5">
      <div className="flex items-center gap-2">
        <FlaskConical size={15} className="text-relic" />
        <div className="text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
          Experimental
        </div>
      </div>

      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-hi">Peer-to-peer transport</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-mid">
            Tunnel this client&apos;s connection over an encrypted WebRTC data channel instead of
            HTTP. Only the initial handshake touches the network directly; messages, presence, and
            media then flow peer-to-peer.
          </div>
          <div className="mt-1.5 text-[11px] leading-relaxed text-lo">
            Applies on your next join or restart. Takes effect per connection.
          </div>
        </div>
        <Toggle on={p2p} onClick={toggleP2p} />
      </div>

      {/* nested: voice on the same P2P connection (only meaningful with P2P on) */}
      <div className="mt-4 flex items-start justify-between gap-3 border-t border-edge pt-4">
        <div className="min-w-0">
          <div className={`text-[13.5px] font-medium ${p2p ? 'text-hi' : 'text-lo'}`}>
            Voice over P2P connection
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-mid">
            Carry voice on the same peer connection instead of a separate SFU port — so voice needs
            no extra port forwarded. Off keeps the current SFU path.
          </div>
          <div className="mt-1.5 text-[11px] leading-relaxed text-lo">
            Requires Peer-to-peer transport. Experimental — rejoin a voice channel after toggling.
          </div>
        </div>
        <Toggle on={voiceTransport} onClick={toggleVoice} disabled={!p2p} />
      </div>
    </div>
  )
}
