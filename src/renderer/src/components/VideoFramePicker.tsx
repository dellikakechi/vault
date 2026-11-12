import { useEffect, useRef, useState } from 'react'
import { fileUrl } from '@shared/api'
import { useItem, useStore } from '../store'
import { Modal } from './ui'
import { Icon } from './Icon'
import {
  captureVideoFrame,
  createVideo,
  drawVideoFrame,
  onceEvent,
  resolveDuration,
  seekTo,
  thumbBufferFromUrl
} from '../lib/media'
import { clamp, cx, formatTimecode } from '../lib/util'

export function VideoFramePicker(): React.JSX.Element | null {
  const id = useStore((s) => s.videoToolId)
  const item = useItem(id)
  const close = useStore((s) => s.setVideoTool)
  const patchItem = useStore((s) => s.patchItem)
  const toast = useStore((s) => s.toast)

  const videoRef = useRef<HTMLVideoElement>(null)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [frames, setFrames] = useState<{ t: number; url: string }[]>([])
  const [capturing, setCapturing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [sheetBusy, setSheetBusy] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)
  const tokenRef = useRef(0)

  useEffect(() => {
    const v = videoRef.current
    if (!v || !item) return
    const current = item
    const token = ++tokenRef.current
    setFrames([])
    setSheetBusy(false)
    setPlaying(false)

    async function init(): Promise<void> {
      if (!v) return
      if (v.readyState < 1) await onceEvent(v, 'loadedmetadata').catch(() => {})
      if (token !== tokenRef.current) return
      const d = await resolveDuration(v)
      if (token !== tokenRef.current) return
      setDuration(d)
      const start = clamp((current.thumbTimeMs ?? 0) / 1000, 0, Math.max(0, d - 0.05))
      await seekTo(v, start).catch(() => {})
      if (token !== tokenRef.current) return
      setTime(start)
      void buildSheet(d, token)
    }

    async function buildSheet(d: number, token: number): Promise<void> {
      if (!item || d <= 0) return
      setSheetBusy(true)
      const probe = createVideo(fileUrl(item.file))
      try {
        if (probe.readyState < 1) await onceEvent(probe, 'loadedmetadata', 15000)
        const count = 12
        const out: { t: number; url: string }[] = []
        for (let i = 0; i < count; i++) {
          if (token !== tokenRef.current) return
          // Nudge off zero: the first decoded frame is often still black.
          const t = Math.min(d - 0.06, Math.max(0.04, (d * i) / (count - 1)))
          await seekTo(probe, t)
          const canvas = drawVideoFrame(probe, 340)
          out.push({ t, url: canvas.toDataURL('image/jpeg', 0.7) })
          setFrames([...out])
        }
      } catch {
        /* contact sheet is best-effort */
      } finally {
        probe.removeAttribute('src')
        probe.load()
        if (token === tokenRef.current) setSheetBusy(false)
      }
    }

    void init()
    return () => {
      tokenRef.current++
    }
  }, [item?.id])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      const v = videoRef.current
      if (v) setTime(v.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  function seek(next: number): void {
    const v = videoRef.current
    if (!v) return
    v.pause()
    setPlaying(false)
    const t = clamp(next, 0, Math.max(0, duration - 0.01))
    v.currentTime = t
    setTime(t)
  }

  function togglePlay(): void {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      void v.play()
      setPlaying(true)
    } else {
      v.pause()
      setPlaying(false)
    }
  }

  async function capture(): Promise<void> {
    const v = videoRef.current
    if (!v || !item) return
    setCapturing(true)
    try {
      const buf = await captureVideoFrame(v)
      const updated = await window.vault.setThumb(item.id, buf, {
        thumbTimeMs: Math.round(v.currentTime * 1000)
      })
      if (updated) patchItem(updated)
      toast('Video thumbnail updated', 'success')
      close(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not capture frame', 'error')
    } finally {
      setCapturing(false)
    }
  }

  async function uploadThumb(file: File | undefined): Promise<void> {
    if (!file || !item) return
    setUploading(true)
    const url = URL.createObjectURL(file)
    try {
      // Re-encode whatever the user picked to WebP, matching the thumbnail cache.
      const buf = await thumbBufferFromUrl(url)
      const updated = await window.vault.setThumb(item.id, buf, { custom: true })
      if (updated) patchItem(updated)
      toast('Custom thumbnail set', 'success')
      close(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not use that image', 'error')
    } finally {
      URL.revokeObjectURL(url)
      setUploading(false)
      if (uploadRef.current) uploadRef.current.value = ''
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON') return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        seek(time - (e.shiftKey ? 1 : 1 / 30))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        seek(time + (e.shiftKey ? 1 : 1 / 30))
      } else if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void capture()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!item) return null

  const progress = duration ? (time / duration) * 100 : 0

  return (
    <Modal
      className="wide"
      title="Choose a thumbnail"
      subtitle={item.title}
      onClose={() => close(null)}
      footer={
        <>
          <span className="kbd-hint">
            <kbd>←</kbd>
            <kbd>→</kbd> step frame · <kbd>Shift</kbd> 1s · <kbd>Space</kbd> play ·{' '}
            <kbd>Enter</kbd> use frame
          </span>
          <div className="grow" />
          <input
            ref={uploadRef}
            type="file"
            accept="image/*"
            hidden
            data-action="video-thumb-upload-input"
            onChange={(e) => void uploadThumb(e.target.files?.[0])}
          />
          <button
            className="btn btn-ghost"
            data-action="video-thumb-upload"
            onClick={() => uploadRef.current?.click()}
            disabled={uploading || capturing}
            title="Use an image from disk instead of a video frame"
          >
            <Icon name="image" size={14} />
            {uploading ? 'Saving…' : 'Upload image'}
          </button>
          <button className="btn btn-ghost" onClick={() => close(null)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void capture()} disabled={capturing || uploading}>
            <Icon name="check" size={14} />
            {capturing ? 'Saving…' : 'Use this frame'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="frame-tool">
          <div className="frame-stage">
            <video
              ref={videoRef}
              src={fileUrl(item.file)}
              crossOrigin="anonymous"
              preload="auto"
              muted
              loop
              onClick={togglePlay}
            />
          </div>

          <div className="frame-side">
            <div className="timeline">
              <input
                type="range"
                min={0}
                max={Math.max(0.1, duration)}
                step={0.01}
                value={time}
                style={{ ['--progress' as string]: `${progress}%` }}
                onChange={(e) => seek(Number(e.target.value))}
              />
              <div className="timeline-row">
                <button className="btn btn-icon btn-sm" onClick={() => seek(time - 1)} title="Back 1s">
                  <Icon name="stepBack" size={13} />
                </button>
                <button className="btn btn-icon btn-sm" onClick={togglePlay} title="Play/pause">
                  <Icon name={playing ? 'pause' : 'play'} size={13} />
                </button>
                <button className="btn btn-icon btn-sm" onClick={() => seek(time + 1)} title="Forward 1s">
                  <Icon name="stepForward" size={13} />
                </button>
                <div className="grow" style={{ flex: 1 }} />
                <span className="timecode">
                  {formatTimecode(time)} <span className="total">/ {formatTimecode(duration)}</span>
                </span>
              </div>
            </div>

            <div>
              <div className="eyebrow" style={{ marginBottom: 7 }}>
                Contact sheet {sheetBusy ? '· reading…' : ''}
              </div>
              <div className="frame-sheet">
                {frames.map((f, i) => (
                  <button
                    key={i}
                    className={cx(Math.abs(f.t - time) < 0.05 && 'is-active')}
                    onClick={() => seek(f.t)}
                  >
                    <img src={f.url} alt="" />
                    <span>{formatTimecode(f.t)}</span>
                  </button>
                ))}
                {!frames.length
                  ? Array.from({ length: 9 }).map((_, i) => (
                      <button key={i} disabled style={{ opacity: 0.3 }} />
                    ))
                  : null}
              </div>
            </div>

            <div className="ai-note">
              <Icon name="frame" />
              <span>
                Scrubbing is frame-accurate. Use the arrow keys to nudge one frame at a time until
                the expression is exactly right.
              </span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
