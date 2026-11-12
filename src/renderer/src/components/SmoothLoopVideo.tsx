import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveDuration } from '../lib/media'

/**
 * A short, seamless loop for muted previews.
 *
 * Chromium's native `loop` attribute can leave a visible gap at the end of a
 * short clip while it seeks back to the start. This component keeps two
 * preloaded video elements and crossfades to the second one just before the
 * first reaches the end, so the rhythm never pauses.
 */
const FADE_MS = 90
const RESET_DELAY = FADE_MS + 40

interface SmoothLoopVideoProps {
  src: string
  poster?: string
  /** Where the first pass should begin, in seconds. Subsequent loops start at 0. */
  startAt?: number
}

export function SmoothLoopVideo({
  src,
  poster,
  startAt = 0
}: SmoothLoopVideoProps): React.JSX.Element {
  const aRef = useRef<HTMLVideoElement>(null)
  const bRef = useRef<HTMLVideoElement>(null)
  const [active, setActive] = useState(0)
  const activeRef = useRef(0)
  const switching = useRef(false)
  const started = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Some containers (notably WebM written by MediaRecorder) report
   * `duration === Infinity` while playing. Resolve it once from the hidden
   * standby buffer so the hand-off still happens at the right time.
   */
  const durationRef = useRef(0)

  const rememberDuration = useCallback((video: HTMLVideoElement): void => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      durationRef.current = video.duration
    }
  }, [])

  const resolveLoopDuration = useCallback(
    (video: HTMLVideoElement): void => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        durationRef.current = video.duration
        return
      }
      void resolveDuration(video).then((duration) => {
        if (duration > 0) durationRef.current = duration
        if (activeRef.current === 1) return
        try {
          video.currentTime = 0
        } catch {
          // The buffer is reset on the next hand-off anyway.
        }
      })
    },
    []
  )

  const element = useCallback(
    (index: number): HTMLVideoElement | null => (index === 0 ? aRef.current : bRef.current),
    []
  )

  /** Move to the thumbnail timestamp on the very first pass only. */
  const applyStart = useCallback(
    (video: HTMLVideoElement): void => {
      if (started.current || !Number.isFinite(video.duration) || video.duration <= 0) return
      started.current = true
      if (startAt <= 0) return
      try {
        video.currentTime = Math.min(startAt, Math.max(0, video.duration - 0.05))
      } catch {
        // Seeking before the media is ready just falls back to the beginning.
      }
    },
    [startAt]
  )

  const switchToNext = useCallback(
    (fromIndex?: number) => {
      if (switching.current) return
      const from = activeRef.current
      // A stale `ended` event from the outgoing buffer must not bounce playback
      // back to it after the hand-off has already happened.
      if (fromIndex !== undefined && fromIndex !== from) return
      const to = from === 0 ? 1 : 0
      const next = element(to)
      if (!next) return
      switching.current = true
      // The standby buffer is already primed at zero, so it can start playing
      // straight away while the outgoing buffer fades out.
      try {
        next.currentTime = 0
      } catch {
        // A video that has not loaded yet will pick up from zero anyway.
      }
      const playing = next.play()
      if (playing) playing.catch(() => undefined)
      activeRef.current = to
      setActive(to)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        const previous = element(from)
        if (previous) {
          previous.pause()
          try {
            previous.currentTime = 0
          } catch {
            // Ignore seek failures while the element is being recycled.
          }
        }
        switching.current = false
      }, RESET_DELAY)
    },
    [element]
  )

  useEffect(() => {
    let stopped = false
    let handle: ReturnType<typeof setTimeout> | null = null
    const tick = (): void => {
      const video = element(activeRef.current)
      if (video && !switching.current && !video.paused) {
        const duration =
          durationRef.current > 0
            ? durationRef.current
            : Number.isFinite(video.duration) && video.duration > 0
              ? video.duration
              : 0
        if (duration > 0) {
          // Keep the overlap proportional for very short clips, and at about
          // five percent of a normal clip.
          const lead = Math.min(0.09, Math.max(0.03, duration * 0.05))
          if (video.currentTime >= duration - lead) switchToNext()
        }
      }
      if (!stopped) handle = setTimeout(tick, 30)
    }
    handle = setTimeout(tick, 30)
    return () => {
      stopped = true
      if (handle) clearTimeout(handle)
    }
  }, [element, switchToNext])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  useEffect(() => {
    durationRef.current = 0
    started.current = false
    switching.current = false
    activeRef.current = 0
    setActive(0)
  }, [src])

  useEffect(() => {
    const video = element(active)
    if (!video) return
    applyStart(video)
    const playing = video.play()
    if (playing) playing.catch(() => undefined)
  }, [active, applyStart, element])

  const styleFor = (index: number): React.CSSProperties => ({
    opacity: active === index ? 1 : 0,
    transition: `opacity ${FADE_MS}ms linear`
  })

  return (
    <>
      <video
        ref={aRef}
        className="smooth-loop-video"
        data-smooth-loop="a"
        src={src}
        poster={poster}
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        style={styleFor(0)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          rememberDuration(v)
          applyStart(v)
          const playing = v.play()
          if (playing) playing.catch(() => undefined)
        }}
        onDurationChange={(e) => rememberDuration(e.currentTarget)}
        onEnded={() => switchToNext(0)}
      />
      <video
        ref={bRef}
        className="smooth-loop-video"
        data-smooth-loop="b"
        src={src}
        poster={poster}
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        style={styleFor(1)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          v.pause()
          try {
            v.currentTime = 0
          } catch {
            // Ignore until metadata is fully ready.
          }
          resolveLoopDuration(v)
        }}
        onDurationChange={(e) => rememberDuration(e.currentTarget)}
        onEnded={() => switchToNext(1)}
      />
    </>
  )
}
