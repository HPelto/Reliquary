import { useEffect, useState } from 'react'
import { Check, Loader2, LockKeyhole } from 'lucide-react'
import { setNewPassword, unlockWithPassword } from '@/lib/identity'
import { useUi } from '@/store'

export function ChangePasswordModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const { identity, setIdentity } = useUi()
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (open) {
      setOldPw('')
      setNewPw('')
      setConfirm('')
      setError(null)
      setDone(false)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !identity) return null

  const submit = async (): Promise<void> => {
    if (busy) return
    if (newPw.length < 8) {
      setError('New password must be at least 8 characters.')
      return
    }
    if (newPw !== confirm) {
      setError("New passwords don't match.")
      return
    }
    setBusy(true)
    setError(null)
    // verify the current password by unwrapping the seed with it
    const seed = await unlockWithPassword(identity, oldPw)
    if (!seed) {
      setBusy(false)
      setError('Current password is incorrect.')
      return
    }
    const updated = await setNewPassword(identity, seed, newPw)
    setIdentity(updated)
    setBusy(false)
    setDone(true)
    setTimeout(onClose, 1100)
  }

  const input =
    'mt-1.5 w-full rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[14px] text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-relic/50'
  const label = 'block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase'

  return (
    <div
      className="fixed inset-0 z-[170] flex items-center justify-center bg-void-0/70 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="glass palette-in w-[420px] rounded-2xl p-7 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.8),0_0_50px_-20px_var(--color-relic)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2">
          <LockKeyhole size={16} className="text-relic" />
          <h2 className="font-display text-[18px] font-bold tracking-tight">Reset password</h2>
        </div>
        <p className="mb-5 text-[12.5px] leading-relaxed text-mid">
          Sets a new password for unlocking this device. Your recovery key is unchanged.
        </p>

        {done ? (
          <div className="flex items-center gap-2 rounded-xl border border-pulse/30 bg-pulse/10 px-4 py-3 text-[13px] text-pulse">
            <Check size={16} />
            Password updated.
          </div>
        ) : (
          <>
            <label className={label}>Current password</label>
            <input
              autoFocus
              type="password"
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
              placeholder="Current password"
              className={input}
            />

            <div className="mt-4">
              <label className={label}>New password</label>
              <input
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder="8+ characters"
                className={input}
              />
            </div>

            <div className="mt-4">
              <label className={label}>Confirm new password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                placeholder="re-enter"
                className={input}
              />
            </div>

            {error && <p className="mt-3 text-[12px] text-ember">{error}</p>}

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={onClose}
                className="rounded-xl border border-edge px-4 py-2.5 text-[13px] text-mid transition-colors hover:bg-void-3 hover:text-hi"
              >
                Cancel
              </button>
              <button
                onClick={() => void submit()}
                disabled={busy || !oldPw || !newPw || !confirm}
                className="flex items-center gap-2 rounded-xl bg-relic px-5 py-2.5 font-display text-[13.5px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_24px_rgba(139,124,246,0.45)] disabled:opacity-30 disabled:hover:shadow-none"
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                {busy ? 'Updating…' : 'Update password'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
