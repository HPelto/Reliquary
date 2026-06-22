import { useEffect, useRef, useState } from 'react'
import { Download, Film, Maximize, Minimize, Pause, Play, Volume2, VolumeX } from 'lucide-react'

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

// Remembered playback position per source so the timeline persists across view
// modes (inline ↔ preview) and re-opens. Cleared naturally when the app reloads.
const playbackPos = new Map<string, number>()

/** Themed, fully custom video player (no native chrome).
 *  - Paused: a center play button; clicking it plays inline. Clicking the
 *    surface elsewhere calls onExpand (open large preview) when provided,
 *    otherwise toggles play.
 *  - Playing: custom control bar (scrub / play / volume / time / fullscreen) and
 *    a hover top bar with the name + download.
 *  - `large` switches from a fixed inline box to a fit-to-viewport preview. */
export function VideoPlayer({
  src,
  name,
  downloadUrl,
  onExpand,
  autoPlay,
  startAt,
  large,
  boxStyle
}: {
  src: string
  name: string
  downloadUrl: string
  /** Open the large preview. Receives the current time + whether it was playing
   *  so the preview can continue seamlessly instead of starting a second copy. */
  onExpand?: (time: number, playing: boolean) => void
  autoPlay?: boolean
  startAt?: number
  large?: boolean
  boxStyle?: React.CSSProperties
}): React.JSX.Element {
  const vRef = useRef<HTMLVideoElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [muted, setMuted] = useState(false)
  const [vol, setVol] = useState(1)
  const [fs, setFs] = useState(false)
  const [hover, setHover] = useState(false)

  useEffect(() => {
    const onFs = (): void => setFs(document.fullscreenElement === boxRef.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const togglePlay = (): void => {
    const v = vRef.current
    if (!v) return
    if (v.paused) {
      void v.play()
      setStarted(true)
    } else {
      v.pause()
    }
  }
  const onSurface = (): void => {
    const v = vRef.current
    if (onExpand) {
      // hand off the latest known position + state, then stop here so only one
      // copy plays. playbackPos is kept current by whichever view is active.
      const t = playbackPos.get(src) ?? v?.currentTime ?? 0
      onExpand(t, v ? !v.paused : false)
      v?.pause()
    } else {
      togglePlay()
    }
  }
  const seekTo = (clientX: number): void => {
    const bar = barRef.current
    const v = vRef.current
    if (!bar || !v || !dur || !isFinite(dur)) return
    const r = bar.getBoundingClientRect()
    const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    v.currentTime = pct * dur
    setCur(v.currentTime)
  }
  const startScrub = (e: React.MouseEvent): void => {
    e.stopPropagation()
    seekTo(e.clientX)
    const move = (ev: MouseEvent): void => seekTo(ev.clientX)
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const toggleFs = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      boxRef.current
        ?.requestFullscreen()
        .catch((err) => console.error('[video] fullscreen request failed:', err))
    }
  }
  const toggleMute = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const v = vRef.current
    if (!v) return
    v.muted = !v.muted
    setMuted(v.muted)
  }
  const changeVol = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const v = vRef.current
    if (!v) return
    const nv = Number(e.target.value)
    v.volume = nv
    v.muted = nv === 0
    setVol(nv)
    setMuted(nv === 0)
  }

  const pct = dur && isFinite(dur) ? Math.min(100, (cur / dur) * 100) : 0
  const showControls = started && (hover || !playing || fs)

  // Initial position via a media fragment (#t=) so the browser starts there and
  // the HTML autoPlay attribute can resume it — programmatic play() after async
  // loadedmetadata gets blocked by the autoplay policy (gesture expired).
  const initialStart = useRef(
    startAt && startAt > 0 ? startAt : (playbackPos.get(src) ?? 0)
  ).current
  const playSrc = initialStart > 0 ? `${src}#t=${initialStart}` : src

  const boxClass = fs
    ? 'h-screen w-screen bg-void-0'
    : large
      ? 'w-fit max-w-full rounded-lg border border-edge'
      : 'rounded-lg border border-edge'
  // fs: h-full/w-full (not max-*) so a small-resolution video scales UP to fill;
  // object-contain keeps the aspect (fills matching screens, letterboxes others).
  const videoClass = fs
    ? 'h-full w-full object-contain'
    : large
      ? 'block max-h-[82vh] max-w-full object-contain'
      : 'block h-full w-full object-contain'

  return (
    <div
      ref={boxRef}
      style={fs || large ? undefined : boxStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`group/vp relative overflow-hidden bg-void-0 ${boxClass}`}
    >
      <video
        ref={vRef}
        src={playSrc}
        autoPlay={autoPlay}
        playsInline
        onClick={onSurface}
        onPlay={() => {
          setPlaying(true)
          setStarted(true)
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime
          setCur(t)
          playbackPos.set(src, t)
        }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          setDur(v.duration)
          setCur(v.currentTime) // already at the #t= position
        }}
        onDurationChange={(e) => setDur(e.currentTarget.duration)}
        onProgress={(e) => setDur(e.currentTarget.duration)}
        onVolumeChange={(e) => {
          setMuted(e.currentTarget.muted)
          setVol(e.currentTarget.volume)
        }}
        className={videoClass}
      />

      {/* center play/pause button. Shown when paused, or on hover while playing
          (so pausing in the small inline view is an easy big target). Clicking
          the circle toggles play; clicking the surface around it opens the large
          preview (inline) or toggles play (lightbox). */}
      {(!playing || hover) && (
        <div className="absolute inset-0 z-[5] flex items-center justify-center" onClick={onSurface}>
          <button
            onClick={(e) => {
              e.stopPropagation()
              togglePlay()
            }}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-void-0/55 text-hi backdrop-blur transition hover:bg-void-0/80"
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? (
              <Pause size={28} fill="currentColor" />
            ) : (
              <Play size={30} className="ml-1" fill="currentColor" />
            )}
          </button>
        </div>
      )}

      {/* top chrome: name + download (hover, once started) */}
      {started && (
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-void-0/85 to-transparent px-3 py-2 transition-opacity ${
            hover ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <Film size={12} className="shrink-0 text-relic" />
          <span className="truncate text-[11.5px] text-hi">{name}</span>
          <a
            href={downloadUrl}
            download={name}
            onClick={(e) => e.stopPropagation()}
            className="pointer-events-auto ml-auto shrink-0 text-mid transition-colors hover:text-hi"
            title="Download"
          >
            <Download size={14} />
          </a>
        </div>
      )}

      {/* custom control bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1.5 bg-gradient-to-t from-void-0/90 to-transparent px-3 pb-2.5 pt-7 transition-opacity ${
          showControls ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div
          ref={barRef}
          onMouseDown={startScrub}
          className="group/bar relative h-1.5 cursor-pointer rounded-full bg-hi/20"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]"
            style={{ width: `${pct}%` }}
          />
          <div
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 transition group-hover/bar:opacity-100"
            style={{ left: `${pct}%` }}
          >
            <span className="block h-3 w-3 rounded-full bg-[var(--accent)] shadow" />
          </div>
        </div>
        <div className="flex items-center gap-3 text-hi">
          <button
            onClick={(e) => {
              e.stopPropagation()
              togglePlay()
            }}
            title={playing ? 'Pause' : 'Play'}
            className="transition-colors hover:text-[var(--accent)]"
          >
            {playing ? <Pause size={16} /> : <Play size={16} fill="currentColor" />}
          </button>
          <div className="group/vol flex items-center gap-1.5">
            <button
              onClick={toggleMute}
              title={muted ? 'Unmute' : 'Mute'}
              className="transition-colors hover:text-[var(--accent)]"
            >
              {muted || vol === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : vol}
              onChange={changeVol}
              onClick={(e) => e.stopPropagation()}
              className="h-1 w-0 accent-[var(--accent)] opacity-0 transition-all group-hover/vol:w-16 group-hover/vol:opacity-100"
            />
          </div>
          <span className="font-mono text-[11px] text-mid">
            {fmt(cur)} / {fmt(dur)}
          </span>
          <button
            onClick={toggleFs}
            title={fs ? 'Exit full screen' : 'Full screen'}
            className="ml-auto transition-colors hover:text-[var(--accent)]"
          >
            {fs ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
        </div>
      </div>
    </div>
  )
}
