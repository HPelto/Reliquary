import { useState } from 'react'
import { KeyRound, Loader2, LockOpen, TriangleAlert } from 'lucide-react'
import {
  setNewPassword,
  unlockWithPassword,
  unlockWithRecoveryKey,
  saveIdentity
} from '@/lib/identity'
import { useUi } from '@/store'

type Mode = 'password' | 'recovery' | 'reset'

export function UnlockOverlay(): React.JSX.Element | null {
  const { identity, unlockedKey, unlock, setIdentity } = useUi()
  const [mode, setMode] = useState<Mode>('password')
  const [password, setPassword] = useState('')
  const [recoveryInput, setRecoveryInput] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [recoveredKey, setRecoveredKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!identity || unlockedKey) return null

  const tryPassword = async (): Promise<void> => {
    if (busy || !password) return
    setBusy(true)
    setError(null)
    const priv = await unlockWithPassword(identity, password)
    setBusy(false)
    if (!priv) {
      setError('Wrong password.')
      return
    }
    unlock(priv)
  }

  const tryRecovery = async (): Promise<void> => {
    if (busy || !recoveryInput.trim()) return
    setBusy(true)
    setError(null)
    const priv = await unlockWithRecoveryKey(identity, recoveryInput)
    setBusy(false)
    if (!priv) {
      setError("That recovery key doesn't unlock this identity.")
      return
    }
    setRecoveredKey(priv)
    setMode('reset')
  }

  const applyNewPassword = async (): Promise<void> => {
    if (busy || !recoveredKey) return
    if (newPw.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (newPw !== newPw2) {
      setError("Passwords don't match.")
      return
    }
    setBusy(true)
    setError(null)
    const updated = await setNewPassword(identity, recoveredKey, newPw)
    saveIdentity(updated)
    setIdentity(updated)
    setBusy(false)
    unlock(recoveredKey)
  }

  const input =
    'mt-1.5 w-full rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[14px] text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-relic/50'

  return (
    <div className="ambient absolute inset-0 z-[200] flex items-center justify-center bg-void-0">
      <div className="glass palette-in w-[440px] rounded-2xl p-7 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.8),0_0_60px_-20px_var(--color-relic)]">
        <div className="mb-5 flex flex-col items-center text-center">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-full font-display text-xl font-bold text-void-0"
            style={{
              background: `linear-gradient(135deg, ${identity.accent}, color-mix(in srgb, ${identity.accent} 55%, #0c0e14))`,
              boxShadow: `0 0 28px ${identity.accent}55`
            }}
          >
            {identity.name[0]}
          </div>
          <h1 className="mt-3 font-display text-[20px] font-bold tracking-tight">
            {mode === 'password' ? `Welcome back, ${identity.name}` : 'Recover your relic key'}
          </h1>
          <div className="mt-1 font-mono text-[11px] text-lo">◆ {identity.fingerprint}</div>
        </div>

        {mode === 'password' && (
          <>
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void tryPassword()}
              placeholder="Password"
              className={input}
            />
            {error && <p className="mt-2 text-[12px] text-ember">{error}</p>}
            <button
              onClick={() => void tryPassword()}
              disabled={busy || !password}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-relic py-2.5 font-display text-[14px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_28px_rgba(139,124,246,0.5)] disabled:opacity-40"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <LockOpen size={16} />}
              Unlock
            </button>
            <button
              onClick={() => {
                setMode('recovery')
                setError(null)
              }}
              className="mt-3 w-full text-center text-[12px] text-lo transition-colors hover:text-mid"
            >
              Forgot your password? Use your recovery key
            </button>
          </>
        )}

        {mode === 'recovery' && (
          <>
            <p className="text-[12.5px] leading-relaxed text-mid">
              Enter the recovery key you saved when this identity was forged.
            </p>
            <input
              autoFocus
              value={recoveryInput}
              onChange={(e) => setRecoveryInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void tryRecovery()}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              spellCheck={false}
              className={`${input} font-mono text-[12.5px]`}
            />
            {error && <p className="mt-2 text-[12px] text-ember">{error}</p>}
            <button
              onClick={() => void tryRecovery()}
              disabled={busy || !recoveryInput.trim()}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-relic py-2.5 font-display text-[14px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_28px_rgba(139,124,246,0.5)] disabled:opacity-40"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
              Recover
            </button>
            <div className="mt-4 flex gap-2.5 rounded-xl border border-ember/40 bg-ember/10 p-3">
              <TriangleAlert size={20} className="shrink-0 text-ember" />
              <p className="text-[11.5px] leading-relaxed text-mid">
                No recovery key either? Then this identity cannot be recovered — there is no reset
                email and no server that can help. Your only path is forging a new Relic Key. (With
                the recovery key, you can always restore — even on a brand-new machine.)
              </p>
            </div>
            <button
              onClick={() => {
                setMode('password')
                setError(null)
              }}
              className="mt-3 w-full text-center text-[12px] text-lo transition-colors hover:text-mid"
            >
              Back to password
            </button>
          </>
        )}

        {mode === 'reset' && (
          <>
            <p className="text-[12.5px] leading-relaxed text-pulse">
              Recovery key accepted. Set a new password — your recovery key stays the same.
            </p>
            <input
              autoFocus
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="New password (8+ characters)"
              className={input}
            />
            <input
              type="password"
              value={newPw2}
              onChange={(e) => setNewPw2(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void applyNewPassword()}
              placeholder="Confirm new password"
              className={input}
            />
            {error && <p className="mt-2 text-[12px] text-ember">{error}</p>}
            <button
              onClick={() => void applyNewPassword()}
              disabled={busy}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gold py-2.5 font-display text-[14px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_28px_rgba(232,201,122,0.45)] disabled:opacity-40"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <LockOpen size={16} />}
              Set password & enter
            </button>
          </>
        )}
      </div>
    </div>
  )
}
