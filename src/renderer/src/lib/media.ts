/**
 * All image/video analysis happens in the renderer using Chromium's decoders.
 * That keeps the app free of native modules while still giving us thumbnails,
 * perceptual hashes and colour histograms.
 */

export interface Analysis {
  width: number
  height: number
  thumb: Blob
  phash: string
  hist: number[]
  color: [number, number, number]
}

const HASH_SIZE = 32

export async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not read file (${res.status})`)
  const blob = await res.blob()
  return await createImageBitmap(blob)
}

export async function probeImageDims(url: string): Promise<{ width: number; height: number }> {
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  if (!img.complete) {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Image failed to decode'))
    })
  } else if (!img.naturalWidth) {
    await img.decode().catch(() => {})
  }
  return { width: img.naturalWidth, height: img.naturalHeight }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.86): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encode failed'))), 'image/webp', quality)
  })
}

export async function makeThumbBlob(
  source: CanvasImageSource,
  sw: number,
  sh: number,
  max = 720
): Promise<Blob> {
  const scale = Math.min(1, max / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, w, h)
  return await canvasToBlob(canvas)
}

const COS: Float64Array = (() => {
  const table = new Float64Array(HASH_SIZE * HASH_SIZE)
  for (let u = 0; u < HASH_SIZE; u++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      table[u * HASH_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * HASH_SIZE))
    }
  }
  return table
})()

function bitsToHex(bits: string): string {
  let out = ''
  for (let i = 0; i < 64; i += 4) {
    out += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16)
  }
  return out
}

function phashFrom(gray: Float64Array): string {
  const coeffs: number[] = []
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      if (u === 0 && v === 0) continue
      let sum = 0
      for (let y = 0; y < HASH_SIZE; y++) {
        const row = v * HASH_SIZE + y
        const cy = COS[row]
        for (let x = 0; x < HASH_SIZE; x++) {
          sum += gray[y * HASH_SIZE + x] * COS[u * HASH_SIZE + x] * cy
        }
      }
      coeffs.push(sum)
    }
  }
  const sorted = [...coeffs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  let bits = ''
  for (const c of coeffs) bits += c > median ? '1' : '0'
  return bitsToHex(bits.padEnd(64, '0'))
}

function histogramFrom(data: Uint8ClampedArray): {
  hist: number[]
  color: [number, number, number]
} {
  const bins = new Float64Array(48)
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    const rr = data[i]
    const gg = data[i + 1]
    const bb = data[i + 2]
    r += rr
    g += gg
    b += bb
    n++
    const max = Math.max(rr, gg, bb)
    const min = Math.min(rr, gg, bb)
    const v = max / 255
    const s = max === 0 ? 0 : (max - min) / max
    let h = 0
    const d = max - min
    if (d !== 0) {
      if (max === rr) h = ((gg - bb) / d) % 6
      else if (max === gg) h = (bb - rr) / d + 2
      else h = (rr - gg) / d + 4
      h = (h * 60 + 360) % 360
    }
    const hi = Math.min(15, Math.floor(h / 22.5))
    const vi = Math.min(2, Math.floor(v * 3))
    bins[hi * 3 + vi] += 0.02 + s * v
  }
  let norm = 0
  for (let i = 0; i < bins.length; i++) norm += bins[i] * bins[i]
  norm = Math.sqrt(norm) || 1
  const hist = Array.from(bins, (v) => v / norm)
  return {
    hist,
    color: n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0]
  }
}

export async function analyzeBitmap(bitmap: ImageBitmap): Promise<Analysis> {
  const { width, height } = bitmap
  const thumb = await makeThumbBlob(bitmap, width, height)

  const small = document.createElement('canvas')
  small.width = HASH_SIZE
  small.height = HASH_SIZE
  const ctx = small.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, HASH_SIZE, HASH_SIZE)
  const data = ctx.getImageData(0, 0, HASH_SIZE, HASH_SIZE).data

  const gray = new Float64Array(HASH_SIZE * HASH_SIZE)
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  const { hist, color } = histogramFrom(data)
  return { width, height, thumb, phash: phashFrom(gray), hist, color }
}

export async function analyzeImageUrl(url: string): Promise<Analysis> {
  const bitmap = await loadBitmap(url)
  try {
    return await analyzeBitmap(bitmap)
  } finally {
    bitmap.close()
  }
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

function once(target: EventTarget, event: string, timeout = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(event, handler)
      reject(new Error(`Timed out waiting for ${event}`))
    }, timeout)
    const handler = (): void => {
      clearTimeout(timer)
      target.removeEventListener(event, handler)
      resolve()
    }
    target.addEventListener(event, handler, { once: true })
  })
}

export function createVideo(url: string): HTMLVideoElement {
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  video.src = url
  return video
}

export async function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  if (!Number.isFinite(seconds)) return
  const target = Math.max(0, Math.min(seconds, Math.max(0, (video.duration || 0) - 0.05)))
  if (Math.abs(video.currentTime - target) < 0.001) return
  const done = once(video, 'seeked', 8000)
  video.currentTime = target
  await done
}

export async function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration
  try {
    await seekTo(video, 1e6)
    const d = video.duration
    video.currentTime = 0
    return Number.isFinite(d) ? d : 0
  } catch {
    return 0
  }
}

export async function probeVideo(url: string): Promise<{
  width: number
  height: number
  durationMs: number
  thumb: Blob | null
  phash?: string
  hist?: number[]
  color?: [number, number, number]
}> {
  const video = createVideo(url)
  try {
    await once(video, 'loadedmetadata')
    const duration = await resolveDuration(video)
    const seekTime = Math.min(1.2, Math.max(0.1, duration * 0.15))
    await seekTo(video, seekTime)
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) throw new Error('Video has no decodable frames')
    const frame = document.createElement('canvas')
    frame.width = width
    frame.height = height
    const ctx = frame.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.drawImage(video, 0, 0, width, height)
    const thumb = await makeThumbBlob(frame, width, height)

    const small = document.createElement('canvas')
    small.width = HASH_SIZE
    small.height = HASH_SIZE
    const sctx = small.getContext('2d', { willReadFrequently: true })!
    sctx.drawImage(video, 0, 0, HASH_SIZE, HASH_SIZE)
    const data = sctx.getImageData(0, 0, HASH_SIZE, HASH_SIZE).data
    const gray = new Float64Array(HASH_SIZE * HASH_SIZE)
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    }
    const { hist, color } = histogramFrom(data)

    return {
      width,
      height,
      durationMs: Math.round(duration * 1000),
      thumb,
      phash: phashFrom(gray),
      hist,
      color
    }
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

export function drawVideoFrame(video: HTMLVideoElement, maxWidth = 1280): HTMLCanvasElement {
  const vw = video.videoWidth || 1280
  const vh = video.videoHeight || 720
  const scale = Math.min(1, maxWidth / vw)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(vw * scale))
  canvas.height = Math.max(1, Math.round(vh * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas
}

export async function captureVideoFrame(video: HTMLVideoElement, maxWidth = 1280): Promise<ArrayBuffer> {
  const canvas = drawVideoFrame(video, maxWidth)
  const blob = await canvasToBlob(canvas, 0.9)
  return await blob.arrayBuffer()
}

export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return await blob.arrayBuffer()
}

/** Decode any media URL and re-encode a fresh thumbnail from it. */
export async function thumbBufferFromUrl(url: string, max = 1000): Promise<ArrayBuffer> {
  const bitmap = await loadBitmap(url)
  try {
    const blob = await makeThumbBlob(bitmap, bitmap.width, bitmap.height, max)
    return await blob.arrayBuffer()
  } finally {
    bitmap.close()
  }
}

export function onceEvent(target: EventTarget, event: string, timeout = 20000): Promise<void> {
  return once(target, event, timeout)
}
