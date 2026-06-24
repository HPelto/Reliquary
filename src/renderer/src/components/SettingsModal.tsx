import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2, LockKeyhole, Sparkles, Trash2, X } from 'lucide-react'
import { fileToMediaRef, type MediaRef, type Profile } from '@/lib/profile'
import { ACCENT_PRESETS, DEFAULT_ACCENT } from '@/lib/relic'
import { DEFAULT_NAME_COLOR } from '@/lib/nameStyle'
import { ColorField } from './ColorField'
import { pushProfileEverywhere } from '@/net/session'
import { useUi } from '@/store'
import { type BlockedUser } from '@/lib/blocks'
import { SelfAvatar } from './KeepAvatar'
import { ChangePasswordModal } from './ChangePasswordModal'
import { NameStyleModal } from './NameStyleModal'
import { StyledName } from './StyledName'
import { VoiceSettings } from './VoiceSettings'
import { UpdatesCard } from './UpdatesCard'
import { ExperimentsCard } from './ExperimentsCard'
import { LicenseCard } from './LicenseCard'

type Tab = 'profile' | 'account' | 'blocked' | 'license'

export function SettingsModal(): React.JSX.Element | null {
  const {
    settingsOpen,
    closeSettings,
    identity,
    setIdentity,
    profile,
    setProfile,
    blocked,
    silenced,
    unblockUser,
    unsilenceUser
  } = useUi()
  const [tab, setTab] = useState<Tab>('profile')

  // draft state — applied on Save
  const [name, setName] = useState('')
  const [accent, setAccent] = useState(DEFAULT_ACCENT)
  const [status, setStatus] = useState('')
  const [about, setAbout] = useState('')
  const [avatar, setAvatar] = useState<MediaRef | undefined>()
  const [background, setBackground] = useState<MediaRef | undefined>()
  const [nameFont, setNameFont] = useState('default')
  const [nameEffect, setNameEffect] = useState('none')
  const [nameColor, setNameColor] = useState(DEFAULT_NAME_COLOR)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pwOpen, setPwOpen] = useState(false)
  const [nsOpen, setNsOpen] = useState(false)
  const avatarInput = useRef<HTMLInputElement>(null)
  const bgInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (settingsOpen && identity) {
      setTab('profile')
      setName(identity.name)
      setAccent(identity.accent)
      setStatus(profile.status)
      setAbout(profile.about)
      setAvatar(profile.avatar)
      setBackground(profile.background)
      setNameFont(profile.nameFont ?? 'default')
      setNameEffect(profile.nameEffect ?? 'none')
      setNameColor(profile.nameColor ?? DEFAULT_NAME_COLOR)
      setError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen])

  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, closeSettings])

  if (!settingsOpen || !identity) return null

  const pick = async (
    e: React.ChangeEvent<HTMLInputElement>,
    set: (r: MediaRef) => void
  ): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      set(await fileToMediaRef(file))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that image.')
    }
  }

  const dirty =
    name.trim() !== identity.name ||
    accent !== identity.accent ||
    status !== profile.status ||
    about !== profile.about ||
    avatar?.hash !== profile.avatar?.hash ||
    background?.hash !== profile.background?.hash ||
    nameFont !== (profile.nameFont ?? 'default') ||
    nameEffect !== (profile.nameEffect ?? 'none') ||
    nameColor !== (profile.nameColor ?? DEFAULT_NAME_COLOR)

  const save = async (): Promise<void> => {
    if (saving) return
    if (name.trim().length < 2) {
      setError('Display name must be at least 2 characters.')
      return
    }
    setSaving(true)
    setError(null)
    const nextIdentity = { ...identity, name: name.trim(), accent }
    const nextProfile: Profile = {
      about: about.trim(),
      status: status.trim(),
      avatar,
      background,
      nameFont,
      nameEffect,
      nameColor: nameColor === DEFAULT_NAME_COLOR ? undefined : nameColor
    }
    setIdentity(nextIdentity)
    setProfile(nextProfile)
    try {
      await pushProfileEverywhere(nextIdentity, nextProfile)
    } catch {
      /* best-effort; offline keeps pick it up on reconnect */
    }
    setSaving(false)
    closeSettings()
  }

  const bgUrl = background?.dataUrl

  return (
    // start below the 38px custom title bar so this page's close button
    // doesn't sit under the native window controls (min/max/close)
    <div className="absolute inset-x-0 bottom-0 top-[38px] z-[150] flex bg-void-0">
      {/* sidebar */}
      <nav className="w-[200px] shrink-0 border-r border-edge bg-void-1 px-3 py-6">
        <div className="mb-4 px-2 font-display text-[11px] font-semibold tracking-[0.16em] text-lo uppercase">
          Settings
        </div>
        {(
          [
            { key: 'profile', label: 'My Profile' },
            { key: 'account', label: 'Account' },
            { key: 'blocked', label: 'Blocked Users' },
            { key: 'license', label: 'License' }
          ] as { key: Tab; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`mb-0.5 flex w-full items-center rounded-lg px-3 py-2 text-[13px] transition-colors ${
              tab === t.key ? 'bg-void-3 text-hi' : 'text-mid hover:bg-void-2 hover:text-hi'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* content */}
      <div className="relative flex-1 overflow-y-auto scroll-thin">
        <button
          onClick={closeSettings}
          className="absolute top-5 right-6 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-edge text-mid transition-colors hover:border-ember/40 hover:text-ember"
          title="Close · Esc"
        >
          <X size={16} />
        </button>

        {tab === 'profile' && (
          <div className="mx-auto max-w-[560px] px-8 py-10">
            <h1 className="font-display text-[22px] font-bold tracking-tight">My Profile</h1>
            <p className="mt-1 text-[13px] text-mid">
              This is how you appear on every Keep you join. Changes sync everywhere.
            </p>

            {/* live preview card */}
            <div className="mt-6 overflow-hidden rounded-2xl border border-edge bg-void-1">
              <div
                className="h-24 bg-void-3"
                style={
                  bgUrl
                    ? { backgroundImage: `url(${bgUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                    : { background: `linear-gradient(120deg, color-mix(in srgb, ${accent} 50%, #0c0e14), #0c0e14)` }
                }
              />
              <div className="px-4 pb-4">
                <div className="-mt-7 mb-2">
                  <div className="inline-block rounded-full ring-4 ring-void-1">
                    <SelfAvatar dataUrl={avatar?.dataUrl} name={name || '?'} accent={accent} size={56} />
                  </div>
                </div>
                <div className="group flex items-center gap-2">
                  {/* group-hover demos the effect's animation in the preview */}
                  <StyledName
                    name={name || 'Your name'}
                    color={nameColor}
                    font={nameFont}
                    effect={nameEffect}
                    mode="hover"
                    style={{ fontSize: 16, fontWeight: 700 }}
                  />
                </div>
                {status && <div className="text-[12px] text-mid">{status}</div>}
                <div className="mt-1 font-mono text-[10px] text-lo">◆ {identity.fingerprint}</div>
                {about && (
                  <p className="mt-2 border-t border-edge pt-2 text-[12.5px] leading-relaxed text-hi/90">
                    {about}
                  </p>
                )}
              </div>
            </div>

            {/* image pickers */}
            <div className="mt-6 flex gap-3">
              <input
                ref={avatarInput}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={(e) => void pick(e, setAvatar)}
              />
              <input
                ref={bgInput}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={(e) => void pick(e, setBackground)}
              />
              <div className="flex-1">
                <label className="text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                  Profile picture
                </label>
                <div className="mt-1.5 flex gap-2">
                  <button
                    onClick={() => avatarInput.current?.click()}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-edge bg-void-0/70 py-2 text-[12.5px] text-mid transition-colors hover:border-relic/40 hover:text-hi"
                  >
                    <ImagePlus size={14} />
                    {avatar ? 'Replace' : 'Upload'}
                  </button>
                  {avatar && (
                    <button
                      onClick={() => setAvatar(undefined)}
                      className="rounded-xl border border-edge px-2.5 text-lo transition-colors hover:border-ember/40 hover:text-ember"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
              <div className="flex-1">
                <label className="text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                  Profile background
                </label>
                <div className="mt-1.5 flex gap-2">
                  <button
                    onClick={() => bgInput.current?.click()}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-edge bg-void-0/70 py-2 text-[12.5px] text-mid transition-colors hover:border-relic/40 hover:text-hi"
                  >
                    <ImagePlus size={14} />
                    {background ? 'Replace' : 'Upload'}
                  </button>
                  {background && (
                    <button
                      onClick={() => setBackground(undefined)}
                      className="rounded-xl border border-edge px-2.5 text-lo transition-colors hover:border-ember/40 hover:text-ember"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <p className="mt-2 font-mono text-[10px] text-lo">GIF, PNG, JPEG or WebP · up to 8 MB · GIFs animate</p>

            {/* text fields */}
            <label className="mt-6 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
              Display name
            </label>
            <div className="relative mt-1.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                className="w-full rounded-xl border border-edge bg-void-0/70 py-2.5 pr-11 pl-3.5 text-[14px] text-hi outline-none transition-colors select-text focus:border-relic/50"
              />
              <button
                onClick={() => setNsOpen(true)}
                title="Name style — font & effect"
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-lg p-1.5 text-lo transition-colors hover:bg-void-3 hover:text-relic"
              >
                <Sparkles size={16} />
              </button>
            </div>

            <label className="mt-4 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
              Accent <span className="normal-case opacity-60">(UI glow — separate from name color)</span>
            </label>
            <div className="mt-2">
              <ColorField value={accent} presets={ACCENT_PRESETS} onChange={setAccent} />
            </div>

            <label className="mt-4 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
              Status
            </label>
            <input
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              maxLength={80}
              placeholder="What are you up to?"
              className="mt-1.5 w-full rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[13.5px] text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-relic/50"
            />

            <label className="mt-4 block text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
              About me
            </label>
            <textarea
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              maxLength={600}
              rows={4}
              placeholder="Tell people who you are…"
              className="mt-1.5 w-full resize-none rounded-xl border border-edge bg-void-0/70 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-hi outline-none transition-colors select-text placeholder:text-lo/50 focus:border-relic/50"
            />
            <div className="mt-1 text-right font-mono text-[10px] text-lo">{about.length}/600</div>

            {error && <p className="mt-3 text-[12px] text-ember">{error}</p>}

            <div className="mt-6 flex items-center justify-end gap-3">
              {dirty && <span className="text-[11.5px] text-lo">Unsaved changes</span>}
              <button
                onClick={() => void save()}
                disabled={!dirty || saving}
                className="flex items-center gap-2 rounded-xl bg-relic px-5 py-2.5 font-display text-[13.5px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_24px_rgba(139,124,246,0.45)] disabled:opacity-30 disabled:hover:shadow-none"
              >
                {saving && <Loader2 size={15} className="animate-spin" />}
                {saving ? 'Syncing…' : 'Save profile'}
              </button>
            </div>
          </div>
        )}

        {tab === 'account' && (
          <div className="mx-auto max-w-[560px] px-8 py-10">
            <h1 className="font-display text-[22px] font-bold tracking-tight">Account</h1>
            <div className="mt-6 rounded-2xl border border-edge bg-void-1 p-5">
              <div className="text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
                Relic key fingerprint
              </div>
              <div
                className="mt-1.5 font-mono text-[16px] tracking-wider"
                style={{ color: identity.accent, textShadow: `0 0 16px ${identity.accent}55` }}
              >
                {identity.fingerprint}
              </div>
              <p className="mt-3 text-[12.5px] leading-relaxed text-mid">
                This identity lives only on this machine, secured by your password and recoverable
                only with your recovery key. There is no email or server reset.
              </p>
            </div>
            <div className="mt-6 flex items-center justify-between rounded-2xl border border-edge bg-void-1 p-5">
              <div>
                <div className="text-[13.5px] font-medium text-hi">Password</div>
                <div className="mt-0.5 text-[12px] text-mid">
                  Change the password that unlocks this device.
                </div>
              </div>
              <button
                onClick={() => setPwOpen(true)}
                className="flex items-center gap-2 rounded-xl border border-edge px-4 py-2 text-[13px] text-mid transition-colors hover:border-relic/40 hover:text-hi"
              >
                <LockKeyhole size={14} />
                Reset password
              </button>
            </div>

            <VoiceSettings />
            <UpdatesCard />
            <ExperimentsCard />
          </div>
        )}

        {tab === 'blocked' && (
          <div className="mx-auto max-w-[560px] px-8 py-10">
            <h1 className="font-display text-[22px] font-bold tracking-tight">Blocked Users</h1>
            <p className="mt-1 text-[13px] text-mid">
              Blocked users&apos; messages are veiled in chat until you choose to reveal them.
              Silenced users never play the notification sound. Both apply across every Keep.
            </p>

            <BlockList
              title="Blocked"
              empty="You haven't blocked anyone."
              users={Object.values(blocked).sort((a, b) => b.at - a.at)}
              action="Unblock"
              onAction={(pubkey) => unblockUser(pubkey)}
            />
            <BlockList
              title="Silenced"
              empty="No one is silenced."
              users={Object.values(silenced).sort((a, b) => b.at - a.at)}
              action="Unsilence"
              onAction={(pubkey) => unsilenceUser(pubkey)}
            />
          </div>
        )}

        {tab === 'license' && (
          <div className="mx-auto max-w-[560px] px-8 py-10">
            <h1 className="font-display text-[22px] font-bold tracking-tight">License</h1>
            <p className="mt-1 text-[13px] text-mid">
              The terms this copy of Reliquary is licensed to you under.
            </p>
            <div className="mt-6">
              <LicenseCard />
            </div>
          </div>
        )}
      </div>

      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
      <NameStyleModal
        open={nsOpen}
        onClose={() => setNsOpen(false)}
        name={name}
        font={nameFont}
        effect={nameEffect}
        color={nameColor}
        onChange={({ font, effect, color }) => {
          setNameFont(font)
          setNameEffect(effect)
          setNameColor(color)
        }}
      />
    </div>
  )
}

function BlockList({
  title,
  empty,
  users,
  action,
  onAction
}: {
  title: string
  empty: string
  users: BlockedUser[]
  action: string
  onAction: (pubkey: string) => void
}): React.JSX.Element {
  return (
    <div className="mt-6 rounded-2xl border border-edge bg-void-1 p-5">
      <div className="text-[11px] font-semibold tracking-[0.12em] text-lo uppercase">
        {title} — {users.length}
      </div>
      {users.length === 0 ? (
        <p className="mt-3 text-[13px] text-lo">{empty}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-1.5">
          {users.map((u) => (
            <div
              key={u.pubkey}
              className="flex items-center gap-3 rounded-lg border border-edge bg-void-2 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-hi">
                  {u.username || 'Unknown user'}
                </div>
                <div className="truncate font-mono text-[10.5px] text-lo">◆ {u.fingerprint}</div>
              </div>
              <button
                onClick={() => onAction(u.pubkey)}
                className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-[12px] text-mid transition-colors hover:border-relic/40 hover:text-hi"
              >
                {action}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
