import { useState } from 'react'
import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-react'
import { forgeIdentity, restoreIdentity, type ForgeResult } from '@/lib/identity'
import { ACCENT_PRESETS, DEFAULT_ACCENT } from '@/lib/relic'
import { useUi } from '@/store'
import { ColorField } from './ColorField'

type Step = 'forge' | 'recovery' | 'restore'
// none → charging (button swells, crypto runs) → burst (accent floods the
// screen) → reveal (flood fades out over the next page)
type Anim = 'none' | 'charging' | 'burst' | 'reveal'

const CHARGE_MS = 900

export function OnboardingOverlay(): React.JSX.Element | null {
  const { identity, completeOnboarding } = useUi()
  const [step, setStep] = useState<Step>('forge')
  const [anim, setAnim] = useState<Anim>('none')
  const [name, setName] = useState('')
  const [accent, setAccent] = useState(DEFAULT_ACCENT)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [result, setResult] = useState<ForgeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const [restoreKey, setRestoreKey] = useState('')
  const [restoring, setRestoring] = useState(false)

  if (identity) return null

  const validate = (): string | null => {
    if (name.trim().length < 2) return 'Pick a display name (at least 2 characters).'
    if (password.length < 8) return 'Password must be at least 8 characters.'
    if (password !== confirm) return "Passwords don't match."
    return null
  }

  const forge = async (): Promise<void> => {
    if (anim !== 'none') return
    const v = validate()
    if (v) {
      setError(v)
      return
    }
    setError(null)
    setAnim('charging')
    try {
      // The PBKDF2 stretch (600k rounds) runs while the button charges up —
      // the burst lands exactly when the real work is done.
      const [r] = await Promise.all([
        forgeIdentity(name.trim(), accent, password),
        new Promise((resolve) => setTimeout(resolve, CHARGE_MS))
      ])
      setResult(r)
      setAnim('burst')
    } catch {
      setAnim('none')
      setError('This build of Chromium cannot generate Ed25519 keys — file an issue.')
    }
  }

  const copyRecovery = (): void => {
    if (!result) return
    void navigator.clipboard.writeText(result.recoveryKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const enter = (): void => {
    if (!result || !saved) return
    // The identity is only written to disk once the user has confirmed the
    // recovery key is saved — quitting before this point forges nothing.
    completeOnboarding(result.identity, result.privKey)
  }

  const restore = async (): Promise<void> => {
    if (restoring) return
    const v = validate()
    if (v) {
      setError(v)
      return
    }
    setRestoring(true)
    setError(null)
    try {
      const r = await restoreIdentity(restoreKey, name.trim(), accent, password)
      // no reveal step — they already hold the key that rebuilt this
      completeOnboarding(r.identity, r.privKey)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed.')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="ambient absolute inset-0 z-[200] flex items-center justify-center bg-void-0">
      {/* stinger: floods the screen with the accent on burst, fades over the next page */}
      {(anim === 'burst' || anim === 'reveal') && (
        <div
          className={`absolute inset-0 z-30 ${anim === 'burst' ? 'stinger-in' : 'stinger-out'}`}
          style={{ background: `radial-gradient(circle at 50% 64%, ${accent}, color-mix(in srgb, ${accent} 72%, #ffffff) 45%, ${accent})` }}
          onAnimationEnd={() => {
            if (anim === 'burst') {
              setStep('recovery')
              setAnim('reveal')
            } else {
              setAnim('none')
            }
          }}
        />
      )}
      <div className="glass palette-in w-[480px] rounded-2xl p-7 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.8),0_0_60px_-20px_var(--color-relic)]">
        <div className="mb-1 flex items-center gap-2">
          <span
            className="text-[18px] text-relic"
            style={{ textShadow: '0 0 14px rgba(139,124,246,0.8)' }}
          >
            ◆
          </span>
          <span className="font-display text-[12px] font-semibold tracking-[0.18em] text-mid">
            RELIQUARY
          </span>
        </div>

        {step === 'forge' && (
          <>
            <h1 className="font-display text-[22px] font-bold tracking-tight">
              Forge your relic key
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-mid">
              Your identity is created <span className="text-hi">here, on this machine</span> — no
              email, no signup, no central account. The password encrypts it at rest.
            </p>

            <label className="mt-5 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
              Display name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Voidwalker"
              maxLength={32}
              className="mt-1.5 w-full rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[14px] text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-relic/50"
            />

            <div className="mt-4 flex gap-3">
              <div className="min-w-0 flex-1">
                <label className="block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8+ characters"
                  className="mt-1.5 w-full rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[14px] text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-relic/50"
                />
              </div>
              <div className="min-w-0 flex-1">
                <label className="block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                  Confirm
                </label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void forge()}
                  placeholder="re-enter"
                  className="mt-1.5 w-full rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[14px] text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-relic/50"
                />
              </div>
            </div>

            <label className="mt-4 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
              Accent
            </label>
            <div className="mt-2">
              <ColorField value={accent} presets={ACCENT_PRESETS} onChange={setAccent} />
            </div>

            {error && <p className="mt-3 text-[12px] text-ember">{error}</p>}

            <button
              onClick={() => void forge()}
              disabled={anim !== 'none'}
              className={`mt-6 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 font-display text-[14px] font-bold text-void-0 transition-all duration-150 ${
                anim === 'none' ? 'hover:shadow-[0_0_28px_rgba(139,124,246,0.5)]' : ''
              } ${anim === 'charging' || anim === 'burst' ? 'charging' : ''}`}
              style={
                {
                  background: accent,
                  '--charge': accent
                } as React.CSSProperties
              }
            >
              <KeyRound size={16} />
              Forge your destiny
            </button>
            <button
              onClick={() => {
                setStep('restore')
                setError(null)
              }}
              className="mt-3 w-full text-center text-[12px] text-lo transition-colors hover:text-mid"
            >
              Already have a relic key? Restore it from your recovery key
            </button>
          </>
        )}

        {step === 'restore' && (
          <>
            <h1 className="font-display text-[22px] font-bold tracking-tight">
              Restore your relic key
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-mid">
              Your recovery key alone rebuilds your entire identity — same fingerprint, same
              standing on every Keep. Enter it with a display name and a new password.
            </p>

            <label className="mt-5 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
              Recovery key
            </label>
            <input
              autoFocus
              value={restoreKey}
              onChange={(e) => setRestoreKey(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              spellCheck={false}
              className="mt-1.5 w-full rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 font-mono text-[12px] text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-gold/50"
            />

            <label className="mt-4 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
              Display name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Voidwalker"
              maxLength={32}
              className="mt-1.5 w-full rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[14px] text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-relic/50"
            />

            <div className="mt-4 flex gap-3">
              <div className="min-w-0 flex-1">
                <label className="block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                  New password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8+ characters"
                  className="mt-1.5 w-full rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[14px] text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-relic/50"
                />
              </div>
              <div className="min-w-0 flex-1">
                <label className="block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                  Confirm
                </label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void restore()}
                  placeholder="re-enter"
                  className="mt-1.5 w-full rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[14px] text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-relic/50"
                />
              </div>
            </div>

            {error && <p className="mt-3 text-[12px] text-ember">{error}</p>}

            <button
              onClick={() => void restore()}
              disabled={restoring || !restoreKey.trim()}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gold py-2.5 font-display text-[14px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_28px_rgba(232,201,122,0.45)] disabled:opacity-40"
            >
              <KeyRound size={16} />
              {restoring ? 'Restoring…' : 'Restore identity'}
            </button>
            <button
              onClick={() => {
                setStep('forge')
                setError(null)
              }}
              className="mt-3 w-full text-center text-[12px] text-lo transition-colors hover:text-mid"
            >
              Back
            </button>
          </>
        )}

        {step === 'recovery' && result && (
          <>
            <h1 className="font-display text-[22px] font-bold tracking-tight">
              Save your recovery key
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-mid">
              This key <span className="text-hi">is</span> your account. It can rebuild your entire
              identity on any machine — forgotten password, dead disk, stolen laptop, anything.
            </p>

            <div className="mt-4 rounded-xl border border-edge bg-void-0/70 p-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold tracking-[0.14em] text-lo uppercase">
                  Recovery key
                </span>
                <button
                  onClick={copyRecovery}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-mid transition-colors hover:bg-void-3 hover:text-hi"
                >
                  {copied ? <Check size={13} className="text-pulse" /> : <Copy size={13} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div
                className="mt-2 text-center font-mono text-[15px] leading-relaxed tracking-wider break-all select-text"
                style={{ color: result.identity.accent, textShadow: `0 0 18px ${result.identity.accent}55` }}
              >
                {result.recoveryKey}
              </div>
            </div>

            <div className="mt-4 flex gap-3 rounded-xl border border-ember/40 bg-ember/10 p-3.5">
              <TriangleAlert size={28} className="shrink-0 text-ember" />
              <p className="text-[12.5px] leading-relaxed text-hi">
                <span className="font-bold text-ember">There is no other way back.</span> No reset
                email, no support desk, no server that can help. As long as you have this key, your
                identity can <span className="font-bold">always</span> be restored — but lose it and
                forget your password, and it is gone forever, everywhere.
              </p>
            </div>

            <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[12.5px] text-mid select-none">
              <input
                type="checkbox"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-relic)]"
              />
              I have saved my recovery key somewhere safe (password manager, paper — not just this
              machine).
            </label>

            <button
              onClick={enter}
              disabled={!saved}
              className="mt-5 w-full rounded-xl bg-gold py-2.5 font-display text-[14px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_28px_rgba(232,201,122,0.45)] disabled:opacity-30 disabled:hover:shadow-none"
            >
              Enter Reliquary
            </button>
          </>
        )}
      </div>
    </div>
  )
}
