import { useEffect } from 'react'
import { DEFAULT_ACCENT } from '@/lib/relic'
import { useUi, useWorld } from '@/store'
import { TitleBar } from '@/components/TitleBar'
import { ServerRail } from '@/components/ServerRail'
import { ChannelPanel } from '@/components/ChannelPanel'
import { ChatArea } from '@/components/ChatArea'
import { MembersList } from '@/components/MembersList'
import { CommandPalette } from '@/components/CommandPalette'
import { AddServerModal } from '@/components/AddServerModal'
import { OnboardingOverlay } from '@/components/OnboardingOverlay'
import { UnlockOverlay } from '@/components/UnlockOverlay'
import { ServerSettingsModal } from '@/components/ServerSettingsModal'
import { SettingsModal } from '@/components/SettingsModal'
import { InviteModal } from '@/components/InviteModal'
import { NotificationSettingsModal } from '@/components/NotificationSettingsModal'
import { CreateEventModal } from '@/components/CreateEventModal'
import { EventsModal } from '@/components/EventsModal'
import { UserProfileOverlay } from '@/components/UserProfileOverlay'
import { UpdateBanner } from '@/components/UpdateBanner'
import { resumeWorlds } from '@/net/session'

function EmptyVault(): React.JSX.Element {
  const openAddServer = useUi((s) => s.openAddServer)
  return (
    <div className="z-10 flex min-w-0 flex-1 flex-col items-center justify-center bg-void-2/40">
      <span
        className="text-[42px] text-relic"
        style={{ textShadow: '0 0 32px rgba(139,124,246,0.8)' }}
      >
        ◆
      </span>
      <h1 className="mt-4 font-display text-[24px] font-bold tracking-tight">Your vault awaits</h1>
      <p className="mt-2 max-w-[340px] text-center text-[13.5px] leading-relaxed text-mid">
        Join a Keep with its address, a <span className="font-mono text-[12px]">relic://</span> link,
        or an invite code — or run your own.
      </p>
      <button
        onClick={openAddServer}
        className="mt-6 rounded-xl bg-relic px-6 py-2.5 font-display text-[14px] font-bold text-void-0 transition-all duration-150 hover:shadow-[0_0_28px_rgba(139,124,246,0.5)]"
      >
        Add a world
      </button>
      <p className="mt-4 font-mono text-[10.5px] text-lo">self-host your own — see keep/README.md</p>
    </div>
  )
}

export default function App(): React.JSX.Element {
  const activeServerId = useUi((s) => s.activeServerId)
  const unlockedKey = useUi((s) => s.unlockedKey)
  const identity = useUi((s) => s.identity)
  const { servers } = useWorld()
  const activeServer = servers.find((s) => s.id === activeServerId)
  // the app's accent theme follows the user's chosen accent, not the server's
  const accent = identity?.accent ?? DEFAULT_ACCENT

  // once the relic key is unlocked, reconnect to every saved keep
  useEffect(() => {
    if (unlockedKey) resumeWorlds()
  }, [unlockedKey])

  // mirror main-process auto-update events into the store (drives the title-bar
  // pill and the Settings updater row)
  useEffect(() => {
    return window.reliquary.onUpdateEvent((e) => useUi.getState().setUpdate(e))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase()
      if (e.ctrlKey && !e.shiftKey && k === 'k') {
        e.preventDefault()
        useUi.getState().togglePalette()
      } else if (e.ctrlKey && e.shiftKey && k === 'm') {
        e.preventDefault()
        useUi.getState().toggleMute()
      } else if (e.ctrlKey && e.shiftKey && k === 'd') {
        e.preventDefault()
        useUi.getState().toggleDeafen()
      } else if (e.ctrlKey && !e.shiftKey && k === ',') {
        e.preventDefault()
        useUi.getState().openSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className="ambient grain relative flex h-full flex-col bg-void-0"
      style={{ '--accent': accent } as React.CSSProperties}
    >
      <TitleBar />
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        <ServerRail />
        {activeServer ? (
          <>
            <ChannelPanel />
            <ChatArea />
            <MembersList />
          </>
        ) : (
          <EmptyVault />
        )}
      </div>
      <CommandPalette />
      <AddServerModal />
      <ServerSettingsModal />
      <InviteModal />
      <NotificationSettingsModal />
      <CreateEventModal />
      <EventsModal />
      <UserProfileOverlay />
      <SettingsModal />
      <OnboardingOverlay />
      <UnlockOverlay />
    </div>
  )
}
