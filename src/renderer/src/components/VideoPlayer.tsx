import { useEffect, useRef, useState } from 'react'
import { Download, Film, Maximize, Minimize, Pause, Play, Volume2, VolumeX } from 'lucide-react'

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

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
  large,
  boxStyle
}: {
  src: string
  name: string
  downloadUrl: string
  onExpand?: () => void
  autoPlay?: boolean
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
    if (onExpand) onExpand()
    else togglePlay()
  }
  const seekTo = (clientX: number): void => {
    const bar = barRef.current
    const v = vRef.current
    if (!bar || !v || !dur) return
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
    if (document.fullscreenElement) void document.exitFullscreen()
    else void boxRef.current?.requestFullscreen().catch(() => {})
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

  const pct = dur ? (cur / dur) * 100 : 0
  const showControls = started && (hover || !playing || fs)

  const boxClass = fs
    ? 'flex h-screen w-screen items-center justify-center bg-void-0'
    : large
      ? 'w-fit max-w-full rounded-lg border border-edge'
      : 'rounded-lg border border-edge'
  const videoClass = fs
    ? 'max-h-full max-w-full object-contain'
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
        src={src}
        autoPlay={autoPlay}
        playsInline
        onClick={onSurface}
        onPlay={() => {
          setPlaying(true)
          setStarted(true)
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onVolumeChange={(e) => {
          setMuted(e.currentTarget.muted)
          setVol(e.currentTarget.volume)
        }}
        className={videoClass}
      />

      {/* center play button (paused). Clicking the circle plays; clicking the
          surface around it opens the large preview (or toggles in lightbox). */}
      {!playing && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" onClick={onSurface}>
          <button
            onClick={(e) => {
              e.stopPropagation()
              togglePlay()
            }}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-void-0/60 backdrop-blur transition hover:bg-void-0/80"
            title="Play"
          >
            <Play size={30} className="ml-1 text-hi" fill="currentColor" />
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
