import { nameColorFor } from '@/lib/nameStyle'
import { presenceColor } from '@/lib/presence'
import { useMedia } from '@/lib/useMedia'
import type { KeepMember } from '@/net/keep'
import { KeepAvatar } from './KeepAvatar'
import { StyledName } from './StyledName'

/** The floating profile card: background banner, avatar, name, status, and
 *  (when full) the about-me. Used on hover (compact) and click (full). */
export function UserCard({
  member,
  instanceId,
  locked,
  full
}: {
  member: KeepMember
  instanceId: string
  locked?: boolean
  full?: boolean
}): React.JSX.Element {
  const { src: bgUrl } = useMedia(instanceId, member.background)

  return (
    <div className="glass w-[280px] overflow-hidden rounded-2xl shadow-[0_24px_60px_-12px_rgba(0,0,0,0.8)]">
      <div
        className="h-[72px] bg-void-3"
        style={
          bgUrl
            ? { backgroundImage: `url(${bgUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : {
                background: `linear-gradient(120deg, color-mix(in srgb, ${member.accent} 50%, #0c0e14), #0c0e14)`
              }
        }
      />
      <div className="px-4 pb-4">
        <div className="-mt-8 mb-2">
          <div className="inline-block rounded-full ring-4 ring-[rgba(18,21,30,0.9)]">
            <KeepAvatar
              instanceId={instanceId}
              avatar={member.avatar}
              name={member.username}
              accent={member.accent}
              size={60}
            />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <StyledName
            name={member.username}
            color={nameColorFor(member, locked)}
            font={locked ? 'default' : member.name_font}
            effect={locked ? 'none' : member.name_effect}
            mode="always"
            className="text-[16px] font-bold"
          />
          {member.role === 'owner' && <span className="text-[11px] text-gold">♛</span>}
          <span
            className="ml-auto h-2 w-2 rounded-full"
            style={{
              background: presenceColor(member.state ?? (member.online ? 'online' : 'offline')),
              boxShadow: member.online
                ? `0 0 6px ${presenceColor(member.state ?? 'online')}`
                : undefined
            }}
          />
        </div>
        {member.status && <div className="mt-0.5 text-[12.5px] text-mid">{member.status}</div>}
        <div className="mt-1 font-mono text-[10px] text-lo">◆ {member.fingerprint}</div>
        {full && member.about && (
          <div className="mt-3 border-t border-edge pt-3">
            <div className="mb-1 text-[10px] font-semibold tracking-[0.12em] text-lo uppercase">
              About me
            </div>
            <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-hi/90 select-text">
              {member.about}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
