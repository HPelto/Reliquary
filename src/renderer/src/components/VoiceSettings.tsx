/**
 * Voice settings — lives in Settings → Account. Personal & local (persisted via
 * lib/voicePrefs, never synced). Device pickers, a live mic-level test bar, and
 * the open-mic / push-to-talk mode toggle. Speaker changes apply to an active
 * call immediately; mic/mode/PTT changes take effect the next time you join.
 */

import { useEffect, useRef, useState } from 'react'
import { Keyboard, Mic, Volume2 } from 'lucide-react'
import { getVoicePrefs, setVoicePrefs, type VoicePrefs } from '@/lib/voicePrefs'
import { voiceSetMic, voiceSetSpeaker } from '@/net/voice'

const LEVEL_SCALE = 0.3 // RMS value that fills the meter; speech peaks well under this

function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code === 'Space') return 'Space'
  return code
}

export function VoiceSettings(): React.JSX.Element {
  const [prefs, setPrefsState] = useState<VoicePrefs>(getVoicePrefs)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const [binding, setBinding] = useState(false)
  const test = useRef<{ stream: MediaStream; ctx: AudioContext; raf: number } | null>(null)

  const update = (patch: Partial<VoicePrefs>): void => {
    const next = { ...prefs, ...patch }
    setPrefsState(next)
    setVoicePrefs(next)
  }

  const refreshDevices = async (): Promise<void> => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setMics(all.filter((d) => d.kind === 'audioinput'))
      setSpeakers(all.filter((d) => d.kind === 'audiooutput'))
    } catch {
      /* enumeration unavailable */
    }
  }

  const stopTest = (): void => {
    const t = test.current
    if (t) {
      cancelAnimationFrame(t.raf)
      t.stream.getTracks().forEach((x) => x.stop())
      void t.ctx.close().catch(() => {})
    }
    test.current = null
    setTesting(false)
    setLevel(0)
  }

  useEffect(() => {
    void refreshDevices()
    return () => stopTest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // capture the next key press as the push-to-talk binding
  useEffect(() => {
    if (!binding) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code !== 'Escape') update({ pttKey: e.code })
      setBinding(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding, prefs])

  const startTest = async (): Promise<void> => {
    try {
      const audio: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
      if (prefs.micDeviceId) audio.deviceId = { exact: prefs.micDeviceId }
      const stream = await navigator.mediaDevices.getUserMedia({ audio })
      const ctx = new AudioContext()
      const an = ctx.createAnalyser()
      an.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(an)
      const buf = new Uint8Array(512)
      test.current = { stream, ctx, raf: 0 }
      const loop = (): void => {
        an.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        setLevel(Math.sqrt(sum / buf.length))
        if (test.current) test.current.raf = requestAnimationFrame(loop)
      }
      test.current.raf = requestAnimationFrame(loop)
      setTesting(true)
      void refreshDevices() // permission granted → device labels are now readable
    } catch {
      /* mic unavailable / denied */
    }
  }

  const selectCls =
    'w-full rounded-lg border border-edge bg-void-2 px-3 py-2 text-[13px] text-mid outline-none transition-colors focus:border-relic/50'

  return (
    <div className="mt-6 rounded-2xl border border-edge bg-void-1 p-5">
      <div className="text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">Voice & audio</div>

      {/* microphone */}
      <label className="mt-4 block">
        <span className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-hi">
          <Mic size={13} className="text-relic" /> Microphone
        </span>
        <select
          className={selectCls}
          value={prefs.micDeviceId}
          onChange={(e) => {
            update({ micDeviceId: e.target.value })
            voiceSetMic(e.target.value) // switch live if a call is in progress
          }}
        >
          <option value="">System default</option>
          {mics.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `Microphone ${i + 1}`}
            </option>
          ))}
        </select>
      </label>

      {/* speaker */}
      <label className="mt-4 block">
        <span className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-hi">
          <Volume2 size={13} className="text-relic" /> Output device
        </span>
        <select
          className={selectCls}
          value={prefs.speakerDeviceId}
          onChange={(e) => {
            update({ speakerDeviceId: e.target.value })
            voiceSetSpeaker(e.target.value) // apply to an in-progress call right away
          }}
        >
          <option value="">System default</option>
          {speakers.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `Speaker ${i + 1}`}
            </option>
          ))}
        </select>
      </label>

      {/* mic test + level meter (the marker shows the voice-activity threshold) */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12.5px] font-medium text-hi">Mic test</span>
          <button
            onClick={() => (testing ? stopTest() : void startTest())}
            className={`rounded-lg border px-3 py-1 text-[12px] transition-colors ${
              testing
                ? 'border-ember/40 text-ember hover:bg-ember/10'
                : 'border-edge text-mid hover:border-relic/40 hover:text-hi'
            }`}
          >
            {testing ? 'Stop' : 'Test'}
          </button>
        </div>
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-void-3">
          <div
            className="h-full rounded-full bg-pulse transition-[width] duration-75"
            style={{ width: `${Math.min(100, (level / LEVEL_SCALE) * 100)}%` }}
          />
          {prefs.mode === 'voice' && (
            <div
              className="absolute top-0 h-full w-px bg-gold"
              style={{ left: `${Math.min(100, (prefs.sensitivity / LEVEL_SCALE) * 100)}%` }}
              title="Voice-activity threshold"
            />
          )}
        </div>
      </div>

      {/* input mode */}
      <div className="mt-5">
        <span className="text-[12.5px] font-medium text-hi">Input mode</span>
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          {(
            [
              { v: 'voice', label: 'Voice activity' },
              { v: 'ptt', label: 'Push to talk' }
            ] as const
          ).map((m) => (
            <button
              key={m.v}
              onClick={() => update({ mode: m.v })}
              className={`rounded-lg border px-3 py-2 text-[12.5px] transition-colors ${
                prefs.mode === m.v
                  ? 'border-relic/60 bg-relic/10 text-hi'
                  : 'border-edge text-mid hover:border-relic/30 hover:text-hi'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* mode-specific control */}
      {prefs.mode === 'voice' ? (
        <label className="mt-4 block">
          <span className="mb-1.5 block text-[12.5px] font-medium text-hi">Input sensitivity</span>
          <input
            type="range"
            min={0.01}
            max={0.3}
            step={0.005}
            value={prefs.sensitivity}
            onChange={(e) => update({ sensitivity: Number(e.target.value) })}
            className="w-full accent-relic"
          />
          <span className="mt-1 block text-[11px] text-lo">
            Lower = more sensitive. The gold marker on the meter is where talking registers.
          </span>
        </label>
      ) : (
        <div className="mt-4">
          <span className="mb-1.5 block text-[12.5px] font-medium text-hi">Push-to-talk key</span>
          <button
            onClick={() => setBinding(true)}
            className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-[13px] transition-colors ${
              binding
                ? 'border-relic/60 bg-relic/10 text-hi'
                : 'border-edge text-mid hover:border-relic/40 hover:text-hi'
            }`}
          >
            <Keyboard size={14} />
            {binding ? 'Press any key…' : keyLabel(prefs.pttKey)}
          </button>
          <span className="mt-1 block text-[11px] text-lo">
            Hold this key to transmit while you're in a voice channel.
          </span>
        </div>
      )}
    </div>
  )
}
