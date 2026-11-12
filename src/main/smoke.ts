import { BrowserWindow, app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// A tiny PNG writer so the smoke run can create a realistic demo library with
// no external assets or network access.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

class Raster {
  w: number
  h: number
  data: Buffer

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.data = Buffer.alloc(w * h * 3)
  }

  set(x: number, y: number, c: [number, number, number], alpha = 1): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 3
    if (alpha >= 1) {
      this.data[i] = c[0]
      this.data[i + 1] = c[1]
      this.data[i + 2] = c[2]
    } else {
      this.data[i] = this.data[i] * (1 - alpha) + c[0] * alpha
      this.data[i + 1] = this.data[i + 1] * (1 - alpha) + c[1] * alpha
      this.data[i + 2] = this.data[i + 2] * (1 - alpha) + c[2] * alpha
    }
  }

  rect(x: number, y: number, w: number, h: number, c: [number, number, number], alpha = 1): void {
    for (let yy = Math.max(0, y | 0); yy < Math.min(this.h, (y + h) | 0); yy++) {
      for (let xx = Math.max(0, x | 0); xx < Math.min(this.w, (x + w) | 0); xx++) {
        this.set(xx, yy, c, alpha)
      }
    }
  }

  circle(cx: number, cy: number, r: number, c: [number, number, number], alpha = 1): void {
    const r2 = r * r
    for (let y = Math.max(0, (cy - r) | 0); y < Math.min(this.h, (cy + r) | 0); y++) {
      for (let x = Math.max(0, (cx - r) | 0); x < Math.min(this.w, (cx + r) | 0); x++) {
        const dx = x - cx
        const dy = y - cy
        const d2 = dx * dx + dy * dy
        if (d2 <= r2) {
          const edge = 1 - Math.max(0, (Math.sqrt(d2) - r * 0.92) / (r * 0.08))
          this.set(x, y, c, alpha * Math.min(1, Math.max(0, edge)))
        }
      }
    }
  }

  gradient(c1: [number, number, number], c2: [number, number, number], angle = 0): void {
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const t = Math.min(1, Math.max(0, ((x / this.w) * cos + (y / this.h) * sin + 1) / 2))
        this.set(x, y, [
          c1[0] + (c2[0] - c1[0]) * t,
          c1[1] + (c2[1] - c1[1]) * t,
          c1[2] + (c2[2] - c1[2]) * t
        ])
      }
    }
  }

  noise(amount: number, seed: number): void {
    let s = seed
    for (let i = 0; i < this.data.length; i += 3) {
      s = (s * 1664525 + 1013904223) >>> 0
      const n = ((s >>> 16) & 0xff) / 255 - 0.5
      const v = n * amount
      this.data[i] = Math.max(0, Math.min(255, this.data[i] + v))
      this.data[i + 1] = Math.max(0, Math.min(255, this.data[i + 1] + v))
      this.data[i + 2] = Math.max(0, Math.min(255, this.data[i + 2] + v))
    }
  }

  png(): Buffer {
    const stride = this.w * 3
    const raw = Buffer.alloc((stride + 1) * this.h)
    for (let y = 0; y < this.h; y++) {
      raw[y * (stride + 1)] = 0
      this.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.w, 0)
    ihdr.writeUInt32BE(this.h, 4)
    ihdr[8] = 8
    ihdr[9] = 2
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw, { level: 8 })),
      pngChunk('IEND', Buffer.alloc(0))
    ])
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hh < 60) [r, g, b] = [c, x, 0]
  else if (hh < 120) [r, g, b] = [x, c, 0]
  else if (hh < 180) [r, g, b] = [0, c, x]
  else if (hh < 240) [r, g, b] = [0, x, c]
  else if (hh < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

const SEGMENTS: Record<string, string[]> = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '1': ['b', 'c'],
  '2': ['a', 'b', 'g', 'e', 'd'],
  '3': ['a', 'b', 'g', 'c', 'd'],
  '4': ['f', 'g', 'b', 'c'],
  '5': ['a', 'f', 'g', 'c', 'd'],
  '6': ['a', 'f', 'g', 'e', 'c', 'd'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  '9': ['a', 'b', 'c', 'd', 'f', 'g']
}

function drawDigit(r: Raster, digit: string, x: number, y: number, size: number, color: [number, number, number]): void {
  const segs = SEGMENTS[digit] ?? []
  const t = Math.max(2, size * 0.13)
  const w = size * 0.62
  const map: Record<string, [number, number, number, number]> = {
    a: [x, y, w, t],
    b: [x + w - t, y, t, size / 2],
    c: [x + w - t, y + size / 2, t, size / 2],
    d: [x, y + size - t, w, t],
    e: [x, y + size / 2, t, size / 2],
    f: [x, y, t, size / 2],
    g: [x, y + size / 2 - t / 2, w, t]
  }
  for (const s of segs) {
    const [sx, sy, sw, sh] = map[s]
    r.rect(sx, sy, sw, sh, color)
  }
}

function artwork(seed: number, w: number, h: number, variant: number): Raster {
  const rnd = mulberry32(seed * 7919 + variant * 104729)
  const r = new Raster(w, h)
  const baseHue = (seed * 47) % 360
  const c1 = hsl(baseHue, 0.35, 0.16)
  const c2 = hsl(baseHue + 45, 0.55, 0.42)
  r.gradient(c1, c2, (variant % 4) * 0.7)

  const blobs = 3 + Math.floor(rnd() * 4)
  for (let i = 0; i < blobs; i++) {
    const hue = baseHue + rnd() * 120 - 60
    const col = hsl(hue, 0.6 + rnd() * 0.3, 0.45 + rnd() * 0.3)
    r.circle(rnd() * w, rnd() * h, (0.12 + rnd() * 0.35) * Math.min(w, h), col, 0.25 + rnd() * 0.4)
  }

  if (variant % 3 === 0) {
    const bands = 4 + Math.floor(rnd() * 5)
    for (let i = 0; i < bands; i++) {
      const y = rnd() * h
      r.rect(0, y, w, 1 + rnd() * 14, hsl(baseHue + 180, 0.5, 0.7), 0.08 + rnd() * 0.12)
    }
  } else if (variant % 3 === 1) {
    const cx = w * (0.3 + rnd() * 0.4)
    r.rect(cx - 3, 0, 6, h, hsl(baseHue + 200, 0.2, 0.9), 0.22)
    r.circle(cx, h * 0.62, Math.min(w, h) * 0.18, hsl(baseHue + 20, 0.85, 0.6), 0.75)
  } else {
    for (let i = 0; i < 22; i++) {
      const x = rnd() * w
      const y = rnd() * h
      const s = 4 + rnd() * 26
      r.rect(x, y, s, s, hsl(baseHue + 90 + rnd() * 60, 0.7, 0.75), 0.1 + rnd() * 0.3)
    }
  }

  r.noise(9, seed * 31 + variant)
  return r
}

/** Slight zoom + centre crop, the kind of edit a near-duplicate usually has. */
function zoomCrop(src: Raster, scale: number): Raster {
  const out = new Raster(src.w, src.h)
  const cx = src.w / 2
  const cy = src.h / 2
  for (let y = 0; y < out.h; y++) {
    const sy = Math.min(src.h - 1, Math.max(0, Math.round(cy + (y - out.h / 2) / scale)))
    for (let x = 0; x < out.w; x++) {
      const sx = Math.min(src.w - 1, Math.max(0, Math.round(cx + (x - out.w / 2) / scale)))
      const si = (sy * src.w + sx) * 3
      const di = (y * out.w + x) * 3
      out.data[di] = src.data[si]
      out.data[di + 1] = src.data[si + 1]
      out.data[di + 2] = src.data[si + 2]
    }
  }
  return out
}

function comicPage(seed: number, page: number, pages: number, w = 760, h = 1080): Raster {
  const r = new Raster(w, h)
  r.rect(0, 0, w, h, [242, 238, 229])
  const rnd = mulberry32(seed * 13 + page * 977)
  const hue = (seed * 61 + page * 37) % 360

  r.rect(0, 0, w, 64, hsl(hue, 0.5, 0.2))
  for (let i = 0; i < 3; i++) {
    const px = 42 + i * ((w - 84) / 3)
    r.rect(px, 96, (w - 84) / 3 - 22, 300 + rnd() * 80, hsl(hue + i * 40, 0.45, 0.62), 1)
  }
  r.rect(42, 440, w - 84, 210, hsl(hue + 120, 0.4, 0.3), 1)
  for (let i = 0; i < 5; i++) {
    r.rect(60, 470 + i * 32, (w - 140) * (0.45 + rnd() * 0.5), 9, [240, 236, 226], 0.85)
  }
  r.rect(42, 680, (w - 84) / 2 - 12, 280, hsl(hue + 200, 0.35, 0.55), 1)
  r.rect(42 + (w - 84) / 2 + 12, 680, (w - 84) / 2 - 12, 280, hsl(hue + 260, 0.35, 0.45), 1)
  for (let i = 0; i < 6; i++) {
    r.rect(60, 1000 + 0, 0, 0, [0, 0, 0], 0)
  }

  // Page number
  const label = String(page + 1)
  const size = 44
  let x = w - 60 - label.length * (size * 0.72)
  for (const ch of label) {
    drawDigit(r, ch, x, h - 84, size, [40, 40, 44])
    x += size * 0.72
  }
  // Page ticks
  for (let i = 0; i < pages; i++) {
    r.rect(42 + i * 18, h - 30, 10, 4, i === page ? [40, 40, 44] : [200, 195, 185])
  }
  r.noise(4, seed + page)
  return r
}

// ---------------------------------------------------------------------------
// A minimal GIF89a writer, so the smoke library also exercises the GIF path.
// ---------------------------------------------------------------------------

const GIF_PALETTE = (() => {
  const palette = Buffer.alloc(768)
  for (let i = 0; i < 256; i++) {
    const r = (i >> 5) & 7
    const g = (i >> 2) & 7
    const b = i & 3
    palette[i * 3] = Math.round((r * 255) / 7)
    palette[i * 3 + 1] = Math.round((g * 255) / 7)
    palette[i * 3 + 2] = Math.round((b * 255) / 3)
  }
  return palette
})()

function indexedPixels(r: Raster): Uint8Array {
  const out = new Uint8Array(r.w * r.h)
  for (let i = 0, p = 0; i < r.data.length; i += 3, p++) {
    out[p] = ((r.data[i] >> 5) << 5) | ((r.data[i + 1] >> 5) << 2) | (r.data[i + 2] >> 6)
  }
  return out
}

function lzwEncode(indices: Uint8Array, minCodeSize = 8): Buffer {
  const clear = 1 << minCodeSize
  const end = clear + 1
  let next = end + 1
  let codeSize = minCodeSize + 1
  let dict = new Map<number, number>()
  const bytes: number[] = []
  let bitBuf = 0
  let bitCount = 0

  const emit = (code: number): void => {
    bitBuf |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) {
      bytes.push(bitBuf & 0xff)
      bitBuf >>>= 8
      bitCount -= 8
    }
  }

  emit(clear)
  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]
    const key = (prefix << 8) | k
    const found = dict.get(key)
    if (found !== undefined) {
      prefix = found
      continue
    }
    emit(prefix)
    if (next < 4096) {
      dict.set(key, next++)
      // The encoder runs one entry ahead of the decoder, so it widens one
      // code later than the decoder's `next === 1 << codeSize` check.
      if (next > 1 << codeSize && codeSize < 12) codeSize++
    } else {
      emit(clear)
      dict = new Map()
      next = end + 1
      codeSize = minCodeSize + 1
    }
    prefix = k
  }
  emit(prefix)
  emit(end)
  if (bitCount > 0) bytes.push(bitBuf & 0xff)
  return Buffer.from(bytes)
}

function subBlocks(data: Buffer): Buffer {
  const parts: Buffer[] = []
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255)
    parts.push(Buffer.from([chunk.length]), chunk)
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

function encodeGif(frames: Raster[], delayCs = 8): Buffer {
  const width = frames[0].w
  const height = frames[0].h
  const parts: Buffer[] = [Buffer.from('GIF89a', 'ascii')]
  const screen = Buffer.alloc(7)
  screen.writeUInt16LE(width, 0)
  screen.writeUInt16LE(height, 2)
  screen[4] = 0xf7 // global palette, 8-bit
  parts.push(screen, GIF_PALETTE)
  parts.push(
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'ascii'),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00])
  )

  for (const frame of frames) {
    parts.push(
      Buffer.from([0x21, 0xf9, 0x04, 0x04, delayCs & 0xff, (delayCs >> 8) & 0xff, 0x00, 0x00])
    )
    const desc = Buffer.alloc(10)
    desc[0] = 0x2c
    desc.writeUInt16LE(0, 1)
    desc.writeUInt16LE(0, 3)
    desc.writeUInt16LE(width, 5)
    desc.writeUInt16LE(height, 7)
    parts.push(desc, Buffer.from([8]), subBlocks(lzwEncode(indexedPixels(frame))))
  }

  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

function gifFrames(seed: number): Raster[] {
  const base = artwork(seed, 480, 300, 2)
  const frames: Raster[] = []
  for (let i = 0; i < 10; i++) {
    const frame = new Raster(base.w, base.h)
    base.data.copy(frame.data)
    const t = i / 10
    const x = 80 + t * 320
    const y = 150 + Math.sin(t * Math.PI * 2) * 74
    frame.circle(x, y, 52, [255, 255, 255], 0.9)
    frame.circle(x, y, 34, hsl(seed * 61 + i * 22, 0.85, 0.6), 1)
    frame.circle(x + 150, 300 - y, 26, [16, 16, 20], 0.35)
    frame.noise(4, seed + i)
    frames.push(frame)
  }
  return frames
}

// ---------------------------------------------------------------------------

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Native full-screen transitions are animated; poll instead of guessing. */
async function waitForFullScreen(
  win: BrowserWindow,
  expected: boolean,
  timeout = 5000
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (win.isFullScreen() === expected) return true
    await wait(100)
  }
  return win.isFullScreen() === expected
}

async function shot(win: BrowserWindow, name: string): Promise<void> {
  const dir = path.join(app.getPath('temp'), 'vault-shots')
  await fs.mkdir(dir, { recursive: true })
  const image = await win.webContents.capturePage()
  const file = path.join(dir, `${name}.png`)
  await fs.writeFile(file, image.toPNG())
  console.log(`[shot] ${file}`)
}

async function seedFiles(): Promise<{ images: string[]; comics: string[] }> {
  const dir = path.join(app.getPath('temp'), 'vault-smoke-seed')
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })

  const names = [
    'harbor lights',
    'dune ridge',
    'portrait study',
    'neon alley',
    'forest floor',
    'studio still life',
    'mountain dusk',
    'street rain',
    'abstract bloom',
    'canyon haze',
    'harbor crane',
    'dune shadow',
    'portrait profile',
    'neon signage',
    'forest canopy',
    'studio figure',
    'mountain lake',
    'street crossing',
    'abstract field',
    'canyon wall',
    'harbor fog',
    'dune grass',
    'portrait hands',
    'neon window',
    'forest path',
    'studio light'
  ]

  const images: string[] = []
  for (let i = 0; i < names.length; i++) {
    const portrait = i % 4 === 1
    const w = portrait ? 760 : 1040
    const h = portrait ? 1040 : 720
    const raster = artwork(i + 3, w, h, i % 4)
    const file = path.join(dir, `${names[i]} ${String(i + 1).padStart(2, '0')}.png`)
    await fs.writeFile(file, raster.png())
    images.push(file)
  }

  // Near-duplicates: same artwork, subtly edited, to exercise similarity search.
  for (const [n, idx] of [0, 4, 8].entries()) {
    const src = images[idx]
    let raster = artwork(idx + 3, 1040, 720, idx % 4)
    if (n === 0) {
      // A slight zoom/crop moves the perceptual hash further than a colour
      // tweak, exercising the variation path rather than the exact-match one.
      raster = zoomCrop(raster, 1.18)
    } else {
      raster.rect(0, 0, 1040, 720, [255, 255, 255], 0.04)
    }
    const file = path.join(dir, `copy of ${path.basename(src, '.png')}.png`)
    await fs.writeFile(file, raster.png())
    images.push(file)
  }

  // An animated GIF exercises the GIF import path and live tile playback.
  const gifFile = path.join(dir, 'orbit study.gif')
  await fs.writeFile(gifFile, encodeGif(gifFrames(23)))
  images.push(gifFile)

  const comics: string[] = []
  const comicNames = ['The Long Quiet', 'Signal & Noise']
  for (let c = 0; c < comicNames.length; c++) {
    const cdir = path.join(dir, comicNames[c])
    await fs.mkdir(cdir, { recursive: true })
    const pages = 6
    for (let p = 0; p < pages; p++) {
      const raster = comicPage(c + 11, p, pages)
      await fs.writeFile(path.join(cdir, `page ${String(p + 1).padStart(2, '0')}.png`), raster.png())
    }
    comics.push(cdir)
  }

  return { images, comics }
}

export async function runSmoke(win: BrowserWindow): Promise<void> {
  try {
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()))
    }
    for (let i = 0; i < 150; i++) {
      const ready = await win.webContents.executeJavaScript('!!window.__vault')
      if (ready) break
      await wait(100)
    }
    const ready = await win.webContents.executeJavaScript('!!window.__vault')
    if (!ready) throw new Error('Renderer smoke hooks never appeared')

    const { images, comics } = await seedFiles()
    console.log(`[seed] ${images.length} images, ${comics.length} comics`)

    await win.webContents.executeJavaScript(
      `window.__vault.importPaths(${JSON.stringify([...images, ...comics])})`
    )
    await wait(1200)
    await win.webContents.executeJavaScript('window.__vault.settle(600)')
    await shot(win, '01-inbox')

    // Selection + tag rail
    await win.webContents.executeJavaScript('window.__vault.selectFirst(5)')
    await wait(700)
    await shot(win, '02-inbox-selection')
    await win.webContents.executeJavaScript('window.__vault.clearSelection()')

    // Explicit inbox/AI membership: tagging must not clear the inbox, and
    // items can be sent into or out of either area by hand.
    const beforeMembership = await win.webContents.executeJavaScript('window.__vault.state()')
    const tagCheck = await win.webContents.executeJavaScript('window.__vault.tagFirstInbox()')
    const afterTag = await win.webContents.executeJavaScript('window.__vault.state()')
    const sentToAI = await win.webContents.executeJavaScript('window.__vault.uiSendToAI(4)')
    const removedInbox = await win.webContents.executeJavaScript(
      'window.__vault.uiRemoveFromInbox(2)'
    )
    const bulkAI = await win.webContents.executeJavaScript('window.__vault.uiBulkToAI(2)')
    const bulkInbox = await win.webContents.executeJavaScript('window.__vault.uiBulkToInbox(2)')
    await win.webContents.executeJavaScript('window.__vault.clearSelection()')
    const reopenedImage = await win.webContents.executeJavaScript(
      'window.__vault.sendImageToInbox()'
    )
    const preview = reopenedImage
      ? await win.webContents.executeJavaScript(
          `window.__vault.openInboxTile(${JSON.stringify(reopenedImage)})`
        )
      : null
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')

    // Exercise the real pointer path too: pointer capture during drag can
    // swallow the synthetic dblclick that the JS-only check above triggers.
    let realPreview = null
    if (reopenedImage) {
      await wait(350)
      const rect = await win.webContents.executeJavaScript(
        `window.__vault.tileRect(${JSON.stringify(reopenedImage)})`
      )
      if (rect) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y })
        for (let i = 0; i < 2; i++) {
          win.webContents.sendInputEvent({
            type: 'mouseDown',
            x: rect.x,
            y: rect.y,
            button: 'left',
            clickCount: i + 1
          })
          win.webContents.sendInputEvent({
            type: 'mouseUp',
            x: rect.x,
            y: rect.y,
            button: 'left',
            clickCount: i + 1
          })
        }
        await wait(800)
        realPreview = await win.webContents.executeJavaScript('window.__vault.previewState()')
      }
    }
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')
    console.log(
      '[membership]',
      JSON.stringify({
        beforeMembership,
        tagCheck,
        afterTag,
        sentToAI,
        removedInbox,
        bulkAI,
        bulkInbox,
        preview,
        realPreview
      })
    )

    // Bulk "clear all tags" from the inbox selection dock.
    const clearTags = await win.webContents.executeJavaScript('window.__vault.clearTagsCheck()')
    console.log('[clear-tags]', JSON.stringify(clearTags))

    // A missing original file must fall back to the thumbnail, not a blank panel.
    const missingItem = await win.webContents.executeJavaScript(
      'window.__vault.missingPreviewItem()'
    )
    let missingPreview: Record<string, unknown> | null = null
    if (missingItem) {
      const abs = path.join(app.getPath('temp'), 'vault-smoke-lib', missingItem.file)
      const bak = `${abs}.smoke-bak`
      try {
        await fs.rename(abs, bak)
        const preview = await win.webContents.executeJavaScript(
          `window.__vault.openInboxTile(${JSON.stringify(missingItem.id)})`
        )
        const note = await win.webContents.executeJavaScript(
          '!!document.querySelector(".detail-preview-note")'
        )
        missingPreview = { ...preview, note }
      } finally {
        await fs.rename(bak, abs).catch(() => {})
      }
    }
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')
    console.log('[missing-preview]', JSON.stringify(missingPreview))

    // Re-importing a file that is already in the library must not delete the
    // library's own copy, and an item taken out of the inbox must come back.
    const reimportSource = images[0]
    const reimportTitle = path
      .basename(reimportSource, path.extname(reimportSource))
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const reimportTarget = await win.webContents.executeJavaScript(
      `window.__vault.itemByTitle(${JSON.stringify(reimportTitle)})`
    )
    let reimport: Record<string, unknown> | null = null
    let repair: Record<string, unknown> | null = null
    if (reimportTarget) {
      const mediaRoot = path.join(app.getPath('temp'), 'vault-smoke-lib')
      const mediaFile = path.join(mediaRoot, reimportTarget.file)
      const exists = (p: string): Promise<boolean> =>
        fs.stat(p).then(() => true).catch(() => false)

      await win.webContents.executeJavaScript(
        `window.__vault.setInbox(${JSON.stringify(reimportTarget.id)}, false)`
      )
      const before = await exists(mediaFile)
      const result = await win.webContents.executeJavaScript(
        `window.__vault.importPaths(${JSON.stringify([reimportSource])})`
      )
      const after = await exists(mediaFile)
      const item = await win.webContents.executeJavaScript(
        `window.__vault.itemByTitle(${JSON.stringify(reimportTitle)})`
      )
      reimport = { before, after, result, item }

      // Now the hard case: the original file is gone, but the metadata is not.
      const bak = `${mediaFile}.repair-bak`
      await win.webContents.executeJavaScript(
        `window.__vault.setInbox(${JSON.stringify(reimportTarget.id)}, false)`
      )
      await fs.rename(mediaFile, bak)
      const repaired = await win.webContents.executeJavaScript(
        `window.__vault.importPaths(${JSON.stringify([reimportSource])})`
      )
      const fileBack = await exists(mediaFile)
      const repairedItem = await win.webContents.executeJavaScript(
        `window.__vault.itemByTitle(${JSON.stringify(reimportTitle)})`
      )
      const repairedTarget = repairedItem
        ? await exists(path.join(mediaRoot, repairedItem.file))
        : false
      // A third import, now that the item is healthy and in the inbox, should
      // be skipped without touching the file on disk.
      const skipped = await win.webContents.executeJavaScript(
        `window.__vault.importPaths(${JSON.stringify([reimportSource])})`
      )
      const stillThere = await exists(mediaFile)
      await fs.unlink(bak).catch(() => {})
      repair = {
        result: repaired,
        fileBack,
        item: repairedItem,
        targetExists: repairedTarget,
        skipped,
        stillThere
      }
    }
    console.log('[reimport]', JSON.stringify({ reimport, repair }))

    // Tag a subset so the library and local AI have training data.
    await win.webContents.executeJavaScript('window.__vault.demoTagging()')
    await wait(600)

    await win.webContents.executeJavaScript('window.__vault.go("library")')
    await win.webContents.executeJavaScript('window.__vault.settle(900)')
    await shot(win, '03-library')
    const tagManagerButton = await win.webContents.executeJavaScript(
      'window.__vault.uiTagManagerButton()'
    )
    console.log('[tag-manager-button]', JSON.stringify(tagManagerButton))
    if (!tagManagerButton?.ok) {
      throw new Error(
        `Tag manager button is not permanently visible and large enough: ${JSON.stringify(tagManagerButton)}`
      )
    }

    // Comic detail
    await win.webContents.executeJavaScript('window.__vault.openFirstComic()')
    await wait(1100)
    await shot(win, '04-comic-detail')
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')

    // Videos
    await win.webContents.executeJavaScript('window.__vault.makeDemoVideos()')
    await wait(2500)
    await win.webContents.executeJavaScript('window.__vault.openFirstVideoTool()')
    await wait(2200)
    await shot(win, '05-video-frame-picker')
    const videoLoop = await win.webContents.executeJavaScript('window.__vault.videoLoopState()')
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')
    const hoverLoop = await win.webContents.executeJavaScript('window.__vault.hoverVideoLoop()')
    console.log('[video-loop]', JSON.stringify({ videoLoop, hoverLoop }))
    if (!videoLoop.detail.loop || videoLoop.detail.preload !== 'auto' || !videoLoop.picker.loop) {
      throw new Error(`Video playback does not loop automatically: ${JSON.stringify(videoLoop)}`)
    }
    if (!hoverLoop.ok || !hoverLoop.handoff || !hoverLoop.stillPlaying) {
      throw new Error(`Smooth video loop did not hand off: ${JSON.stringify(hoverLoop)}`)
    }
    await shot(win, '05b-video-loop')
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')
    await wait(300)

    // Videos can also use an uploaded image instead of a captured frame.
    const customThumb = await win.webContents.executeJavaScript(
      'window.__vault.uiVideoThumbUpload()'
    )
    await wait(500)
    await shot(win, '05c-video-custom-thumb')
    console.log('[video-thumb]', JSON.stringify(customThumb))
    if (!customThumb?.ok) {
      throw new Error(`Uploaded video thumbnail failed: ${JSON.stringify(customThumb)}`)
    }
    if (!customThumb.buttonLabel.toLowerCase().includes('upload')) {
      throw new Error(`Video picker has no upload control: ${JSON.stringify(customThumb)}`)
    }
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')

    await win.webContents.executeJavaScript('window.__vault.go("duplicates")')
    await wait(1400)
    await shot(win, '06-duplicates')
    const dupeSummary = await win.webContents.executeJavaScript('window.__vault.dupeInfo()')
    const dupeControls = await win.webContents.executeJavaScript('window.__vault.uiDupeControls()')
    const keepMultiple = await win.webContents.executeJavaScript('window.__vault.uiDupeHighlight()')
    await wait(500)
    await shot(win, '06b-duplicates-keep')
    const dupeResolve = await win.webContents.executeJavaScript('window.__vault.uiDupeResolve()')

    // "Compare" opens the comic reader over a duplicate group without adding a
    // virtual item to the library.
    const itemsBeforeCompare = (await win.webContents.executeJavaScript(
      'window.__vault.state()'
    )) as { items: number }
    const firstGroupItems = (await win.webContents.executeJavaScript(
      `document.querySelector('.dupe-group')?.querySelectorAll('.dupe-card').length ?? 0`
    )) as number
    const compareButtons = (await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-action="dupe-compare"]').length`
    )) as number
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-action="dupe-compare"]')?.click()`
    )
    await wait(1100)
    const compareOpen = (await win.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.reader-bar')
      if (!bar) return { open: false }
      return {
        open: true,
        title: bar.querySelector('.title')?.textContent ?? '',
        sub: bar.querySelector('.reader-sub')?.textContent ?? '',
        counter: bar.querySelector('.mono')?.textContent ?? '',
        pages: document.querySelectorAll('.reader-strip button').length
      }
    })()`)) as {
      open: boolean
      title: string
      sub: string
      counter: string
      pages: number
    }
    const compareFullScreen = win.isFullScreen()
    await shot(win, '06c-dupe-compare')
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.reader-strip button')[1]?.click()`
    )
    await wait(300)
    const compareSecond = (await win.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.reader-bar')
      return {
        sub: bar?.querySelector('.reader-sub')?.textContent ?? '',
        counter: bar?.querySelector('.mono')?.textContent ?? ''
      }
    })()`)) as { sub: string; counter: string }
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-action="reader-close"]')?.click()`
    )
    const compareRestored = await waitForFullScreen(win, false)
    const compareClosed = await win.webContents.executeJavaScript('window.__vault.state()')
    const itemsAfterCompare = compareClosed.items as number
    console.log(
      '[compare]',
      JSON.stringify({
        firstGroupItems,
        compareButtons,
        compareOpen,
        compareFullScreen,
        compareSecond,
        itemsBeforeCompare: itemsBeforeCompare.items,
        itemsAfterCompare
      })
    )
    if (!compareOpen.open) throw new Error('Compare reader did not open')
    if (compareButtons < 1) throw new Error('No Compare button on duplicate groups')
    if (compareOpen.pages !== firstGroupItems) {
      throw new Error(`Compare shows ${compareOpen.pages} pages for ${firstGroupItems} duplicates`)
    }
    if (!compareOpen.counter.startsWith('1 /')) {
      throw new Error(`Compare counter did not start at 1: ${compareOpen.counter}`)
    }
    if (compareSecond.counter !== `2 / ${firstGroupItems}`) {
      throw new Error(`Compare did not page to the second copy: ${compareSecond.counter}`)
    }
    if (!compareFullScreen) throw new Error('Compare did not hide the window chrome')
    if (!compareRestored || win.isFullScreen()) {
      throw new Error('Compare left the window full screen')
    }
    if (compareClosed.compare) throw new Error('Compare reader did not close')
    if (itemsAfterCompare !== itemsBeforeCompare.items) {
      throw new Error('Compare added an item to the library')
    }

    console.log(
      '[dupes]',
      JSON.stringify({ dupeSummary, dupeControls, keepMultiple, dupeResolve })
    )
    if (!dupeSummary.groups) throw new Error('Duplicate scan found nothing to resolve')
    if (dupeControls.keepOne !== 0 || dupeControls.keepAll !== 0 || dupeControls.bulkBar !== 0) {
      throw new Error(`Duplicate view still offers alternate resolution paths: ${JSON.stringify(dupeControls)}`)
    }
    if (dupeControls.resolve < 1) throw new Error('Duplicate groups have no Resolve action')
    if (dupeControls.resolveDisabled !== 0) {
      throw new Error(
        `Resolve must stay clickable even when every copy is kept: ${JSON.stringify(dupeControls)}`
      )
    }
    if (!keepMultiple?.ok) {
      throw new Error(`Duplicate card keep/drop toggle failed: ${JSON.stringify(keepMultiple)}`)
    }
    if (!keepMultiple.keepRing || !keepMultiple.dropRing) {
      throw new Error(`Duplicate highlights are missing: ${JSON.stringify(keepMultiple)}`)
    }
    if (keepMultiple.keepRing === keepMultiple.dropRing) {
      throw new Error(`Duplicate keep and drop highlights are identical: ${JSON.stringify(keepMultiple)}`)
    }
    if (!dupeResolve.ok || !dupeResolve.dialog || !dupeResolve.cancelled) {
      throw new Error(`Duplicate Resolve flow failed: ${JSON.stringify(dupeResolve)}`)
    }

    // Image sets: create one from the inbox and one from the library through
    // the real selection actions, then read the result exactly like a comic.
    type SetCreated = {
      id: string
      kind: string
      title: string
      file: string
      coverIndex: number
      pages: number
      pageFiles: string[]
      pageBytes: number[]
      bytes: number
      inbox: boolean
      tags: string[]
      sha256: string | null
      phash: string | null
    }
    type SetResult = {
      ok: boolean
      stage: string
      surface?: string
      action?: string
      ids?: string[]
      before?: number
      after?: number
      view?: string
      typeFilter?: string
      filter?: { present: boolean; active: boolean; text: string }
      expectedTags?: string[]
      tagsOk?: boolean
      selected?: string[]
      created?: SetCreated | null
      sources?: { id: string; file: string; bytes: number; inbox: boolean }[]
      sourceInbox?: boolean[]
    }

    await win.webContents.executeJavaScript('window.__vault.go("library")')
    await wait(400)
    const bulkOne = await win.webContents.executeJavaScript('window.__vault.uiBulkBarOne()')
    const cardZones = await win.webContents.executeJavaScript('window.__vault.uiCardZones()')
    console.log('[library-ui]', JSON.stringify({ bulkOne, cardZones }))
    if (!bulkOne?.ok) {
      throw new Error(`Library bulk bar does not appear for one selected item: ${JSON.stringify(bulkOne)}`)
    }
    if (!cardZones?.ok) {
      throw new Error(
        `Library thumbnail/body click zones are wrong: ${JSON.stringify(cardZones)}`
      )
    }
    await win.webContents.executeJavaScript('window.__vault.go("library")')

    const setFromInbox = (await win.webContents.executeJavaScript(
      'window.__vault.uiCreateSet("inbox", true)'
    )) as SetResult
    await wait(900)
    await shot(win, '06d-image-set-created')
    const setRead = setFromInbox?.created
      ? await win.webContents.executeJavaScript(`window.__vault.uiReadSet(${JSON.stringify(setFromInbox.created.id)})`)
      : null
    const setReaderFullScreen = win.isFullScreen()
    await shot(win, '06e-image-set-reader')
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')
    const setReaderRestored = await waitForFullScreen(win, false)
    const setFromLibrary = (await win.webContents.executeJavaScript(
      'window.__vault.uiCreateSet("library", true)'
    )) as SetResult
    await wait(700)
    await shot(win, '06f-image-set-library')

    const smokeRoot = path.join(app.getPath('temp'), 'vault-smoke-lib')
    let setDisk: {
      prefix: boolean
      pages: { rel: string; exists: boolean; bytes: number }[]
      originals: { file: string; exists: boolean; bytes: number }[]
      originalsIntact: boolean
    } | null = null
    if (setFromLibrary?.created) {
      const created = setFromLibrary.created
      const pages = await Promise.all(
        created.pageFiles.map(async (rel) => {
          try {
            const stat = await fs.stat(path.join(smokeRoot, rel))
            return { rel, exists: true, bytes: stat.size }
          } catch {
            return { rel, exists: false, bytes: 0 }
          }
        })
      )
      const originals = await Promise.all(
        (setFromLibrary.sources ?? []).map(async (source) => {
          const abs = path.isAbsolute(source.file)
            ? source.file
            : path.join(smokeRoot, source.file)
          try {
            const stat = await fs.stat(abs)
            return { file: source.file, exists: true, bytes: stat.size }
          } catch {
            return { file: source.file, exists: false, bytes: 0 }
          }
        })
      )
      setDisk = {
        prefix: created.pageFiles.every((rel) => rel.startsWith(`media/sets/${created.id}/`)),
        pages,
        originals,
        originalsIntact: originals.every(
          (entry, index) =>
            entry.exists && entry.bytes === (setFromLibrary.sources?.[index]?.bytes ?? -1)
        )
      }
    }

    console.log(
      '[image-set]',
      JSON.stringify({ setFromInbox, setRead, setReaderFullScreen, setReaderRestored, setFromLibrary, setDisk })
    )
    if (!setFromInbox?.ok || !setFromInbox.created) {
      throw new Error(`Inbox image-set action failed: ${JSON.stringify(setFromInbox)}`)
    }
    if (!setRead?.ok || setRead.pages !== 2 || setRead.first !== '1 / 2' || setRead.second !== '2 / 2') {
      throw new Error(`Image set reader did not page like a comic: ${JSON.stringify(setRead)}`)
    }
    if (!setReaderFullScreen || !setReaderRestored || win.isFullScreen()) {
      throw new Error('Image set reader did not enter and restore full screen')
    }
    if (!setFromInbox.filter?.present || !setFromInbox.filter.active) {
      throw new Error(`Library has no active Image sets filter: ${JSON.stringify(setFromInbox)}`)
    }
    if (setFromInbox.created.kind !== 'set' || setFromInbox.created.coverIndex !== 0) {
      throw new Error(`Created item is not a paged set: ${JSON.stringify(setFromInbox.created)}`)
    }
    if (setFromInbox.created.inbox || (setFromInbox.sourceInbox ?? []).some((value) => !value)) {
      throw new Error(`Set creation changed inbox membership: ${JSON.stringify(setFromInbox)}`)
    }
    if (!setFromInbox.tagsOk || !(setFromInbox.expectedTags?.length ?? 0) || !setFromInbox.created.tags.length) {
      throw new Error(`Inbox image set did not inherit its sources' tags: ${JSON.stringify(setFromInbox)}`)
    }
    if (!setFromLibrary?.ok || !setFromLibrary.created) {
      throw new Error(`Library image-set action failed: ${JSON.stringify(setFromLibrary)}`)
    }
    if ((setFromLibrary.after ?? 0) !== (setFromLibrary.before ?? 0) + 1) {
      throw new Error(`Image set was not added to the library: ${JSON.stringify(setFromLibrary)}`)
    }
    if (setFromLibrary.created.pages !== 2 || setFromLibrary.created.inbox) {
      throw new Error(`Library image set has wrong shape: ${JSON.stringify(setFromLibrary.created)}`)
    }
    if (!setFromLibrary.tagsOk || !setFromLibrary.created.tags.length) {
      throw new Error(`Library image set did not inherit its sources' tags: ${JSON.stringify(setFromLibrary)}`)
    }
    if (setFromLibrary.created.sha256 || setFromLibrary.created.phash) {
      throw new Error('Image sets must not inherit duplicate hashes from their sources')
    }
    if (!setDisk?.prefix || setDisk.pages.length !== 2 || !setDisk.pages.every((page) => page.exists && page.bytes > 0)) {
      throw new Error(`Image set pages were not stored in their own directory: ${JSON.stringify(setDisk)}`)
    }
    if (!setDisk.originalsIntact) {
      throw new Error(`Creating an image set damaged the originals: ${JSON.stringify(setDisk)}`)
    }

    await win.webContents.executeJavaScript('window.__vault.go("ai")')
    await wait(400)
    const aiSeed = await win.webContents.executeJavaScript('window.__vault.sendUntaggedToAI()')
    const aiRun = await win.webContents.executeJavaScript('window.__vault.runAI()')
    await wait(1600)
    const aiEvaluation = await win.webContents.executeJavaScript(
      'window.__vault.aiEvaluate(120)'
    )
    const aiFeedback = await win.webContents.executeJavaScript(
      'window.__vault.aiRejectFeedback()'
    )
    console.log('[ai-evaluate]', JSON.stringify({ aiSeed, aiEvaluation, aiFeedback }))
    await shot(win, '07-ai-review')
    const aiBeforeRemove = await win.webContents.executeJavaScript('window.__vault.state()')
    const aiRemoved = await win.webContents.executeJavaScript('window.__vault.uiRemoveFromAI()')
    const aiAfterRemove = await win.webContents.executeJavaScript('window.__vault.state()')
    console.log(
      '[ai-membership]',
      JSON.stringify({ aiRun, aiBeforeRemove, aiRemoved, aiAfterRemove })
    )

    // Bulk clear the whole AI page. Items and tags must survive.
    const aiRemovedAll = await win.webContents.executeJavaScript(
      'window.__vault.uiRemoveAllFromAI()'
    )
    const aiAfterRemoveAll = await win.webContents.executeJavaScript('window.__vault.state()')
    console.log(
      '[ai-remove-all]',
      JSON.stringify({ aiRemovedAll, aiAfterRemoveAll })
    )

    await win.webContents.executeJavaScript('window.__vault.go("settings")')
    await wait(700)
    const aiEvalUi = await win.webContents.executeJavaScript('window.__vault.uiAiEvaluate()')
    console.log('[ai-eval-ui]', JSON.stringify(aiEvalUi))
    await wait(300)
    await shot(win, '08-settings')
    await win.webContents.executeJavaScript(
      '(() => { const el = document.querySelector(".settings-scroll"); if (el) el.scrollTop = el.scrollHeight; return !!el })()'
    )
    await wait(350)
    await shot(win, '08b-ai-accuracy')

    // Comic reader and cover picker. The reader owns the screen: the window
    // chrome (including the native close button) must be hidden, and its own X
    // in the top-right must respond to a real mouse click.
    await win.webContents.executeJavaScript('window.__vault.openComicReader()')
    await wait(1300)
    const readerOpen = (await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-action="reader-close"]')
      const bar = document.querySelector('.reader-bar')
      if (!button || !bar) return { present: false }
      const r = button.getBoundingClientRect()
      return {
        present: true,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        right: Math.round(r.right),
        barWidth: Math.round(bar.getBoundingClientRect().width)
      }
    })()`)) as {
      present: boolean
      x?: number
      y?: number
      right?: number
      barWidth?: number
    }
    const readerFullScreen = win.isFullScreen()
    await shot(win, '09-comic-reader')
    if (readerOpen.present && readerOpen.x !== undefined && readerOpen.y !== undefined) {
      const { x, y } = readerOpen
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    }
    const readerRestored = await waitForFullScreen(win, false)
    const readerAfter = await win.webContents.executeJavaScript('window.__vault.state()')
    const readerFullScreenAfter = win.isFullScreen()
    console.log(
      '[reader]',
      JSON.stringify({
        readerOpen,
        readerFullScreen,
        closed: !readerAfter.reader,
        restored: readerRestored,
        fullScreenAfter: readerFullScreenAfter
      })
    )
    if (!readerOpen.present) throw new Error('Reader close button is missing')
    if (!readerFullScreen) throw new Error('Reader did not hide the window chrome')
    if (readerAfter.reader) throw new Error('Reader X did not respond to a real click')
    if (!readerRestored || readerFullScreenAfter) {
      throw new Error('Window stayed full screen after closing the reader')
    }

    // Full-screen viewer for images and GIFs (videos use the native control).
    await win.webContents.executeJavaScript('window.__vault.setSearch("")')
    await win.webContents.executeJavaScript('window.__vault.openFirstImage()')
    await wait(600)
    const imageDetail = (await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('[data-action="detail-fullscreen"]')
      return b ? { present: true, title: b.getAttribute('title') } : { present: false }
    })()`)) as { present: boolean; title?: string }
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-action="detail-fullscreen"]')?.click()`
    )
    await wait(1000)
    const viewerOpen = (await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-action="viewer-close"]')
      if (!button) return { present: false }
      const r = button.getBoundingClientRect()
      return { present: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)) as { present: boolean; x?: number; y?: number }
    const viewerFullScreen = win.isFullScreen()
    await shot(win, '18-image-viewer')

    // Arrow keys walk the filtered library order, wrapping at the ends.
    const viewerBefore = (await win.webContents.executeJavaScript(
      'window.__vault.viewerInfo()'
    )) as {
      id: string
      file: string
      index: number
      queue: string[]
      counter: string
    }
    let viewerAfterRight: { id: string; file: string; index: number; counter: string } | null = null
    let viewerAfterLeft: { id: string; file: string; index: number; counter: string } | null = null
    if (viewerBefore.queue.length > 1) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
      await wait(350)
      viewerAfterRight = await win.webContents.executeJavaScript('window.__vault.viewerInfo()')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' })
      await wait(350)
      viewerAfterLeft = await win.webContents.executeJavaScript('window.__vault.viewerInfo()')
    }
    console.log(
      '[viewer-nav]',
      JSON.stringify({
        before: viewerBefore,
        afterRight: viewerAfterRight,
        afterLeft: viewerAfterLeft
      })
    )
    if (viewerBefore.queue.length < 2) {
      throw new Error('Viewer queue only has one image; cannot test arrow cycling')
    }
    if (viewerBefore.index < 0) throw new Error('Open image is not in the viewer queue')
    if (viewerBefore.counter !== `${viewerBefore.index + 1} / ${viewerBefore.queue.length}`) {
      throw new Error(`Viewer counter does not match its queue position: ${viewerBefore.counter}`)
    }
    if (!viewerAfterRight || !viewerAfterLeft) {
      throw new Error('Viewer did not report its state after the arrow keys')
    }
    const expectedRight =
      viewerBefore.queue[(viewerBefore.index + 1) % viewerBefore.queue.length]
    if (viewerAfterRight.id !== expectedRight) {
      throw new Error(`ArrowRight did not advance in filter order: ${JSON.stringify(viewerAfterRight)}`)
    }
    if (viewerAfterRight.file === viewerBefore.file) {
      throw new Error('ArrowRight did not change the displayed image')
    }
    if (
      viewerAfterRight.counter !==
      `${viewerAfterRight.index + 1} / ${viewerBefore.queue.length}`
    ) {
      throw new Error(`Viewer counter did not follow ArrowRight: ${viewerAfterRight.counter}`)
    }
    if (viewerAfterLeft.id !== viewerBefore.id) {
      throw new Error('ArrowLeft did not return to the previous image')
    }

    if (viewerOpen.present && viewerOpen.x !== undefined && viewerOpen.y !== undefined) {
      const { x, y } = viewerOpen
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    }
    const viewerRestored = await waitForFullScreen(win, false)
    const viewerAfter = await win.webContents.executeJavaScript('window.__vault.state()')
    const viewerFullScreenAfter = win.isFullScreen()
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')
    await wait(300)
    await win.webContents.executeJavaScript('window.__vault.openFirstGif()')
    await wait(600)
    const gifFullscreenButton = (await win.webContents.executeJavaScript(
      `!!document.querySelector('[data-action="detail-fullscreen"]')`
    )) as boolean
    console.log(
      '[viewer]',
      JSON.stringify({
        imageDetail,
        viewerOpen,
        viewerFullScreen,
        closed: !viewerAfter.viewer,
        restored: viewerRestored,
        fullScreenAfter: viewerFullScreenAfter,
        gifFullscreenButton
      })
    )
    if (!imageDetail.present) throw new Error('No full-screen button on the image preview')
    if (!viewerOpen.present) throw new Error('Image viewer did not open')
    if (!viewerFullScreen) throw new Error('Image viewer did not hide the window chrome')
    if (viewerAfter.viewer) throw new Error('Image viewer X did not respond to a real click')
    if (!viewerRestored || viewerFullScreenAfter) {
      throw new Error('Window stayed full screen after closing the viewer')
    }
    if (!gifFullscreenButton) throw new Error('No full-screen button on the GIF preview')

    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')
    await win.webContents.executeJavaScript('window.__vault.openCoverPicker()')
    await wait(1200)
    await shot(win, '10-cover-picker')
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')

    // Tag management and combined tag search.
    await win.webContents.executeJavaScript('window.__vault.go("library")')
    await win.webContents.executeJavaScript('window.__vault.openTagManager()')
    await wait(800)
    await shot(win, '11-tag-manager')

    const renamed = await win.webContents.executeJavaScript('window.__vault.renameTag("harbor", "waterfront")')
    const searchAnd = await win.webContents.executeJavaScript(
      'window.__vault.searchStats("#waterfront #moody")'
    )
    const searchNot = await win.webContents.executeJavaScript(
      'window.__vault.searchStats("#waterfront !moody")'
    )
    const searchOld = await win.webContents.executeJavaScript('window.__vault.searchStats("#harbor")')
    console.log(
      '[search]',
      JSON.stringify({ renamed, searchAnd, searchNot, searchOld }, null, 0)
    )
    await win.webContents.executeJavaScript('window.__vault.setSearch("#waterfront #moody")')
    await win.webContents.executeJavaScript('window.__vault.closeTagManager()')
    await wait(800)
    await shot(win, '12-tag-search')

    // Search suggestion popover.
    await win.webContents.executeJavaScript('window.__vault.setSearch("")')
    win.focus()
    await wait(250)
    const focused = await win.webContents.executeJavaScript(
      '(() => { const input = document.querySelector(".titlebar-search input"); input?.focus(); return { active: document.activeElement === input } })()'
    )
    await wait(500)
    const popOpen = await win.webContents.executeJavaScript('!!document.querySelector(".search-pop")')
    console.log('[search-pop]', JSON.stringify({ focused, popOpen }))
    await shot(win, '13-search-suggestions')
    await win.webContents.executeJavaScript(
      'document.querySelector(".titlebar-search input")?.blur()'
    )

    // Combine tags by clicking the suggestion flags.
    await win.webContents.executeJavaScript('window.__vault.setSearch("#waterfront ")')
    win.focus()
    await wait(250)
    await win.webContents.executeJavaScript(
      'document.querySelector(".titlebar-search input")?.focus()'
    )
    await wait(250)
    const pickOne = await win.webContents.executeJavaScript(
      'window.__vault.uiPickSearchTag("moody")'
    )
    await wait(250)
    const pickTwo = await win.webContents.executeJavaScript(
      'window.__vault.uiPickSearchTag("abstract")'
    )
    await wait(250)
    const pickNot = await win.webContents.executeJavaScript(
      'window.__vault.uiPickSearchTag("forest", true)'
    )
    console.log('[search-pick]', JSON.stringify({ pickOne, pickTwo, pickNot }))
    await win.webContents.executeJavaScript('window.__vault.setSearch("")')
    await win.webContents.executeJavaScript(
      'document.querySelector(".titlebar-search input")?.blur()'
    )

    // Exercise the real rename and delete controls in the manager.
    await win.webContents.executeJavaScript('window.__vault.openTagManager()')
    await wait(400)
    const uiRenamed = await win.webContents.executeJavaScript(
      'window.__vault.uiRenameTag("moody", "texture")'
    )
    const uiDeleted = await win.webContents.executeJavaScript(
      'window.__vault.uiDeleteTag("texture")'
    )
    const afterDelete = await win.webContents.executeJavaScript('window.__vault.state()')
    console.log(
      '[ui-tags]',
      JSON.stringify({ uiRenamed, uiDeleted, tags: afterDelete.tags, search: afterDelete.search })
    )

    // Tag categories: nested create, assign, reparent, rename and delete.
    const categoryCreated = await win.webContents.executeJavaScript(
      'window.__vault.uiCreateCategory("Palette")'
    )
    const childCreated = await win.webContents.executeJavaScript(
      'window.__vault.uiCreateCategory("Warm", "Palette")'
    )
    const categoryAssigned = await win.webContents.executeJavaScript(
      'window.__vault.uiAssignCategory("waterfront", "Warm")'
    )
    const parentAssigned = await win.webContents.executeJavaScript(
      'window.__vault.uiAssignCategory("abstract", "Palette")'
    )
    const categoriesAfterAssign = await win.webContents.executeJavaScript(
      'window.__vault.categoryState()'
    )
    const categoriesOnDisk = await win.webContents.executeJavaScript(
      'window.__vault.categoryDiskState()'
    )
    const sidebarCategories = await win.webContents.executeJavaScript(
      'window.__vault.sidebarCategoryState()'
    )
    const categoryTree = await win.webContents.executeJavaScript(
      'window.__vault.categoryTree()'
    )

    // Category rows collapse their own tags and every nested category. The tag
    // manager and the library sidebar expose the same toggle.
    type CollapseState = {
      name: string
      collapsed: boolean
      tags: string[]
      children: boolean
    }
    type CollapseToggle = {
      ok: boolean
      collapsed?: boolean
      tags?: string[]
      children?: boolean
      groups?: string[]
      expanded?: boolean
    }
    // Categories start collapsed. Expanding a parent reveals (still collapsed)
    // children; each child toggles independently.
    const managerDefaultState = (await win.webContents.executeJavaScript(
      'window.__vault.categoryCollapseState()'
    )) as CollapseState[]
    const managerParentExpand = (await win.webContents.executeJavaScript(
      'window.__vault.uiToggleCategoryCollapse("Palette")'
    )) as CollapseToggle
    const managerAfterParentExpand = (await win.webContents.executeJavaScript(
      'window.__vault.categoryCollapseState()'
    )) as CollapseState[]
    const managerChildExpand = (await win.webContents.executeJavaScript(
      'window.__vault.uiToggleCategoryCollapse("Warm")'
    )) as CollapseToggle
    const managerAfterChildExpand = (await win.webContents.executeJavaScript(
      'window.__vault.categoryCollapseState()'
    )) as CollapseState[]
    const managerChildCollapse = (await win.webContents.executeJavaScript(
      'window.__vault.uiToggleCategoryCollapse("Warm")'
    )) as CollapseToggle
    const managerAfterChildCollapse = (await win.webContents.executeJavaScript(
      'window.__vault.categoryCollapseState()'
    )) as CollapseState[]
    const managerParentCollapse = (await win.webContents.executeJavaScript(
      'window.__vault.uiToggleCategoryCollapse("Palette")'
    )) as CollapseToggle
    const managerAfterParentCollapse = (await win.webContents.executeJavaScript(
      'window.__vault.categoryCollapseState()'
    )) as CollapseState[]

    // Filtering tags opens the tree; clearing the filter closes it again.
    const managerFilterOn = (await win.webContents.executeJavaScript(
      'window.__vault.uiFilterTagInput("manager", "waterfront")'
    )) as { ok: boolean }
    const managerFilteredState = (await win.webContents.executeJavaScript(
      'window.__vault.categoryCollapseState()'
    )) as CollapseState[]
    const managerFilterOff = (await win.webContents.executeJavaScript(
      'window.__vault.uiFilterTagInput("manager", "")'
    )) as { ok: boolean }
    const managerFilterClearedState = (await win.webContents.executeJavaScript(
      'window.__vault.categoryCollapseState()'
    )) as CollapseState[]

    // Same behaviour in the library sidebar.
    const sidebarDefaultState = (await win.webContents.executeJavaScript(
      'window.__vault.sidebarCollapseState()'
    )) as CollapseState[]
    const sidebarParentExpand = (await win.webContents.executeJavaScript(
      'window.__vault.uiToggleSidebarCollapse("Palette")'
    )) as CollapseToggle
    const sidebarAfterParentExpand = (await win.webContents.executeJavaScript(
      'window.__vault.sidebarCollapseState()'
    )) as CollapseState[]
    const sidebarChildExpand = (await win.webContents.executeJavaScript(
      'window.__vault.uiToggleSidebarCollapse("Warm")'
    )) as CollapseToggle
    const sidebarAfterChildExpand = (await win.webContents.executeJavaScript(
      'window.__vault.sidebarCollapseState()'
    )) as CollapseState[]
    const sidebarChildCollapse = (await win.webContents.executeJavaScript(
      'window.__vault.uiToggleSidebarCollapse("Warm")'
    )) as CollapseToggle
    const sidebarParentCollapse = (await win.webContents.executeJavaScript(
      'window.__vault.uiToggleSidebarCollapse("Palette")'
    )) as CollapseToggle
    const sidebarAfterParentCollapse = (await win.webContents.executeJavaScript(
      'window.__vault.sidebarCollapseState()'
    )) as CollapseState[]
    const sidebarFilterOn = (await win.webContents.executeJavaScript(
      'window.__vault.uiFilterTagInput("sidebar", "waterfront")'
    )) as { ok: boolean }
    const sidebarFilteredState = (await win.webContents.executeJavaScript(
      'window.__vault.sidebarCollapseState()'
    )) as CollapseState[]
    const sidebarFilterOff = (await win.webContents.executeJavaScript(
      'window.__vault.uiFilterTagInput("sidebar", "")'
    )) as { ok: boolean }
    const sidebarFilterClearedState = (await win.webContents.executeJavaScript(
      'window.__vault.sidebarCollapseState()'
    )) as CollapseState[]
    await wait(200)
    console.log(
      '[category-collapse]',
      JSON.stringify({
        managerDefaultState,
        managerParentExpand,
        managerAfterParentExpand,
        managerChildExpand,
        managerAfterChildExpand,
        managerChildCollapse,
        managerAfterChildCollapse,
        managerParentCollapse,
        managerAfterParentCollapse,
        managerFilterOn,
        managerFilteredState,
        managerFilterOff,
        managerFilterClearedState,
        sidebarDefaultState,
        sidebarParentExpand,
        sidebarAfterParentExpand,
        sidebarChildExpand,
        sidebarAfterChildExpand,
        sidebarChildCollapse,
        sidebarParentCollapse,
        sidebarAfterParentCollapse,
        sidebarFilterOn,
        sidebarFilteredState,
        sidebarFilterOff,
        sidebarFilterClearedState
      })
    )
    const managerDefaultPalette = managerDefaultState.find((g) => g.name === 'Palette')
    if (
      !managerDefaultPalette ||
      !managerDefaultPalette.collapsed ||
      managerDefaultPalette.tags.length
    ) {
      throw new Error('Tag categories are not collapsed by default')
    }
    if (managerDefaultState.some((group) => !group.collapsed)) {
      throw new Error('A tag category was expanded before any user action')
    }
    if (managerParentExpand.collapsed || !managerParentExpand.tags?.length) {
      throw new Error('Tag manager did not expand the parent category')
    }
    if (!managerParentExpand.children || !managerParentExpand.groups?.includes('Warm')) {
      throw new Error('Expanded parent did not reveal its nested category')
    }
    const warmAfterParentExpand = managerAfterParentExpand.find((g) => g.name === 'Warm')
    if (!warmAfterParentExpand || !warmAfterParentExpand.collapsed) {
      throw new Error('Nested category should stay collapsed when its parent expands')
    }
    if (!managerChildExpand.expanded || !managerChildExpand.tags?.length) {
      throw new Error('Tag manager did not expand a nested category')
    }
    const paletteWhileChildExpanded = managerAfterChildExpand.find((g) => g.name === 'Palette')
    if (!paletteWhileChildExpanded || paletteWhileChildExpanded.collapsed) {
      throw new Error('Expanding a nested category collapsed its parent')
    }
    if (!managerChildCollapse.collapsed || managerChildCollapse.tags?.length) {
      throw new Error('Tag manager did not collapse a nested category')
    }
    const paletteWhileChildCollapsed = managerAfterChildCollapse.find((g) => g.name === 'Palette')
    if (
      !paletteWhileChildCollapsed ||
      paletteWhileChildCollapsed.collapsed ||
      !paletteWhileChildCollapsed.tags.length
    ) {
      throw new Error('Collapsing a nested category also collapsed its parent')
    }
    if (!managerParentCollapse.collapsed || managerParentCollapse.tags?.length) {
      throw new Error('Tag manager did not collapse the parent category')
    }
    if (managerParentCollapse.children || managerParentCollapse.groups?.includes('Warm')) {
      throw new Error('Collapsed parent still shows its nested category')
    }
    if (managerAfterParentCollapse.some((group) => !group.collapsed)) {
      throw new Error('Some tag categories stayed expanded')
    }
    if (!managerFilterOn.ok || !managerFilterOff.ok) {
      throw new Error('Could not drive the tag filter inputs')
    }
    const warmWhileFiltering = managerFilteredState.find((g) => g.name === 'Warm')
    const paletteWhileFiltering = managerFilteredState.find((g) => g.name === 'Palette')
    if (!warmWhileFiltering || warmWhileFiltering.collapsed) {
      throw new Error('Filtering tags did not expand the matching nested category')
    }
    if (!paletteWhileFiltering || paletteWhileFiltering.collapsed) {
      throw new Error('Filtering tags did not expand the parent category')
    }
    if (!warmWhileFiltering.tags.includes('waterfront')) {
      throw new Error('Filtered category did not show the matching tag')
    }
    if (managerFilterClearedState.some((group) => !group.collapsed)) {
      throw new Error('Clearing the tag filter did not contract the categories')
    }

    if (!sidebarDefaultState.length) throw new Error('Library sidebar has no tag categories')
    if (sidebarDefaultState.some((group) => !group.collapsed)) {
      throw new Error('Library sidebar categories are not collapsed by default')
    }
    if (!sidebarParentExpand.expanded || !sidebarParentExpand.tags?.length) {
      throw new Error('Library sidebar did not expand the parent category')
    }
    const warmAfterSidebarExpand = sidebarAfterParentExpand.find((g) => g.name === 'Warm')
    if (!warmAfterSidebarExpand || !warmAfterSidebarExpand.collapsed) {
      throw new Error('Library sidebar nested category should stay collapsed')
    }
    if (!sidebarChildExpand.expanded || !sidebarChildExpand.tags?.length) {
      throw new Error('Library sidebar did not expand a nested category')
    }
    const paletteAfterSidebarChild = sidebarAfterChildExpand.find((g) => g.name === 'Palette')
    if (!paletteAfterSidebarChild || paletteAfterSidebarChild.collapsed) {
      throw new Error('Expanding a nested category collapsed its sidebar parent')
    }
    if (!sidebarChildCollapse.collapsed || sidebarChildCollapse.tags?.length) {
      throw new Error('Library sidebar did not collapse a nested category')
    }
    if (!sidebarParentCollapse.collapsed || sidebarAfterParentCollapse.some((g) => !g.collapsed)) {
      throw new Error('Library sidebar did not collapse the parent category')
    }
    if (!sidebarFilterOn.ok || !sidebarFilterOff.ok) {
      throw new Error('Could not drive the sidebar tag filter')
    }
    const warmSidebarFiltered = sidebarFilteredState.find((g) => g.name === 'Warm')
    if (!warmSidebarFiltered || warmSidebarFiltered.collapsed) {
      throw new Error('Sidebar tag filter did not expand matching categories')
    }
    if (!warmSidebarFiltered.tags.includes('waterfront')) {
      throw new Error('Sidebar filtered category did not show the matching tag')
    }
    if (sidebarFilterClearedState.some((group) => !group.collapsed)) {
      throw new Error('Clearing the sidebar tag filter did not contract the categories')
    }

    await wait(400)
    await shot(win, '15-tag-categories')

    // A parent must never be movable inside its own child.
    const cycleCheck = await win.webContents.executeJavaScript(
      'window.__vault.categoryCycleCheck("Palette", "Warm")'
    )
    // Move the child to the top level, then back under its parent.
    const movedOut = await win.webContents.executeJavaScript(
      'window.__vault.uiMoveCategory("Warm", null)'
    )
    const movedBack = await win.webContents.executeJavaScript(
      'window.__vault.uiMoveCategory("Warm", "Palette")'
    )
    const categoryRenamed = await win.webContents.executeJavaScript(
      'window.__vault.uiRenameCategory("Palette", "Scenery")'
    )
    const categoriesAfterRename = await win.webContents.executeJavaScript(
      'window.__vault.categoryState()'
    )
    const categoryDeleted = await win.webContents.executeJavaScript(
      'window.__vault.uiDeleteCategory("Scenery")'
    )
    const categoriesAfterDelete = await win.webContents.executeJavaScript(
      'window.__vault.categoryState()'
    )
    const categoriesDeletedOnDisk = await win.webContents.executeJavaScript(
      'window.__vault.categoryDiskState()'
    )
    const sidebarAfterDelete = await win.webContents.executeJavaScript(
      'window.__vault.sidebarCategoryState()'
    )
    console.log(
      '[categories]',
      JSON.stringify({
        categoryCreated,
        childCreated,
        categoryAssigned,
        parentAssigned,
        categoriesAfterAssign,
        categoriesOnDisk,
        sidebarCategories,
        categoryTree,
        cycleCheck,
        movedOut,
        movedBack,
        categoryRenamed,
        categoriesAfterRename,
        categoryDeleted,
        categoriesAfterDelete,
        categoriesDeletedOnDisk,
        sidebarAfterDelete
      })
    )

    // New import batches should occupy their own region of the free canvas.
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')
    await win.webContents.executeJavaScript('window.__vault.setSearch("")')
    await win.webContents.executeJavaScript('window.__vault.go("inbox")')
    await wait(1400)

    // The inbox tag rail collapses and expands the same way, and its own tag
    // search opens categories while it is active.
    const railDefaultState = (await win.webContents.executeJavaScript(
      'window.__vault.tagRailCollapseState()'
    )) as CollapseState[]
    const railExpand = (await win.webContents.executeJavaScript(
      'window.__vault.uiToggleTagRailCollapse("Warm")'
    )) as CollapseToggle
    const railCollapse = (await win.webContents.executeJavaScript(
      'window.__vault.uiToggleTagRailCollapse("Warm")'
    )) as CollapseToggle
    const railFilterOn = (await win.webContents.executeJavaScript(
      'window.__vault.uiFilterTagInput("rail", "water")'
    )) as { ok: boolean }
    const railFilteredState = (await win.webContents.executeJavaScript(
      'window.__vault.tagRailCollapseState()'
    )) as CollapseState[]
    const railFilterOff = (await win.webContents.executeJavaScript(
      'window.__vault.uiFilterTagInput("rail", "")'
    )) as { ok: boolean }
    const railFilterClearedState = (await win.webContents.executeJavaScript(
      'window.__vault.tagRailCollapseState()'
    )) as CollapseState[]
    await wait(200)
    console.log(
      '[rail-collapse]',
      JSON.stringify({
        railDefaultState,
        railExpand,
        railCollapse,
        railFilterOn,
        railFilteredState,
        railFilterOff,
        railFilterClearedState
      })
    )
    if (!railDefaultState.length) throw new Error('Inbox tag rail has no categories')
    if (railDefaultState.some((group) => !group.collapsed)) {
      throw new Error('Inbox tag categories are not collapsed by default')
    }
    if (!railExpand.expanded || !railExpand.tags?.includes('waterfront')) {
      throw new Error('Inbox tag rail did not expand the category')
    }
    if (!railCollapse.collapsed || railCollapse.tags?.length) {
      throw new Error('Inbox tag rail did not collapse the category')
    }
    if (!railFilterOn.ok || !railFilterOff.ok) {
      throw new Error('Could not drive the inbox tag search')
    }
    const warmRailFiltered = railFilteredState.find((g) => g.name === 'Warm')
    if (!warmRailFiltered || warmRailFiltered.collapsed) {
      throw new Error('Inbox tag search did not expand matching categories')
    }
    if (!warmRailFiltered.tags.includes('waterfront')) {
      throw new Error('Inbox tag search did not reveal the matching tag')
    }
    if (railFilterClearedState.some((group) => !group.collapsed)) {
      throw new Error('Clearing the inbox tag search did not contract the categories')
    }

    await win.webContents.executeJavaScript(
      'document.querySelector("button[title=\\"Fit to view\\"]")?.click()'
    )
    await wait(700)
    await shot(win, '14-batch-separation')
    const batch = await win.webContents.executeJavaScript('window.__vault.batchSeparation()')
    const batchReveal = await win.webContents.executeJavaScript('window.__vault.batchReveal()')
    console.log('[batch]', JSON.stringify({ batch, batchReveal }))

    // Lossless WebP conversion: real button, pixel equality, lossless marker,
    // GIF preservation, progress dock and repeat-run exclusion. Kick it off
    // without awaiting so the progress dock can be captured while it runs.
    const conversionPromise = win.webContents.executeJavaScript(
      'window.__vault.conversionCheck()'
    )
    await wait(2200)
    await shot(win, '16-conversion-progress')
    const conversion = await conversionPromise
    console.log('[convert]', JSON.stringify(conversion))
    if (!conversion?.ok) {
      throw new Error(`Conversion check did not run: ${JSON.stringify(conversion)}`)
    }
    if (conversion.first.converted !== 7 || conversion.first.failed !== 0) {
      throw new Error(`Unexpected conversion counts: ${JSON.stringify(conversion.first)}`)
    }
    if (conversion.first.skipped < 1) {
      throw new Error(`GIF was not skipped: ${JSON.stringify(conversion.first)}`)
    }
    if (!conversion.image?.flag || !conversion.image.same) {
      throw new Error(`Image pixels or flag changed: ${JSON.stringify(conversion.image)}`)
    }
    if (!conversion.comic?.allPages || !conversion.comic.same) {
      throw new Error(`Comic pages were not converted losslessly: ${JSON.stringify(conversion.comic)}`)
    }
    if (!conversion.lossless) {
      throw new Error('Converted file is not a VP8L lossless WebP')
    }
    if (!conversion.oldFilesGone) {
      throw new Error('Original files were not moved out of media/')
    }
    if (
      conversion.gif &&
      (conversion.gif.flag || !String(conversion.gif.file).toLowerCase().endsWith('.gif'))
    ) {
      throw new Error(`GIF was modified: ${JSON.stringify(conversion.gif)}`)
    }
    if (!String(conversion.dockText).includes('left')) {
      throw new Error(`Conversion progress dock did not show remaining count: ${conversion.dockText}`)
    }
    if (!conversion.second || conversion.second.converted !== 0) {
      throw new Error(`Second run was not a no-op: ${JSON.stringify(conversion.second)}`)
    }

    // The internal flags must survive a reload, and the originals must be in trash.
    const convertRoot = path.join(app.getPath('temp'), 'vault-smoke-lib')
    const onDisk = JSON.parse(
      await fs.readFile(path.join(convertRoot, 'library.json'), 'utf8')
    ) as {
      items: Record<string, { convertedToWebp?: boolean; pages?: { convertedToWebp?: boolean }[] }>
    }
    const diskImage = onDisk.items[conversion.image.id]
    const diskComic = onDisk.items[conversion.comic.id]
    const diskFlags = {
      image: !!diskImage?.convertedToWebp,
      comic: !!diskComic?.convertedToWebp,
      pages: !!diskComic?.pages?.length && diskComic.pages.every((page) => !!page.convertedToWebp)
    }
    const trashFiles = await fs.readdir(path.join(convertRoot, 'trash'))
    console.log('[convert-disk]', JSON.stringify({ diskFlags, trashFiles: trashFiles.length }))
    if (!diskFlags.image || !diskFlags.comic || !diskFlags.pages) {
      throw new Error(`Conversion flags did not persist: ${JSON.stringify(diskFlags)}`)
    }
    if (!trashFiles.some((name) => name.toLowerCase().endsWith('.png'))) {
      throw new Error('Original files were not moved to trash')
    }

    // Emptying the trash from Settings deletes only trash files, never media.
    const mediaBefore = (await fs.readdir(path.join(convertRoot, 'media'))).length
    await win.webContents.executeJavaScript('window.__vault.closeOverlays()')
    await win.webContents.executeJavaScript('window.__vault.go("settings")')
    await wait(900)
    const trashUI = (await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-action="empty-trash"]')
      return button ? { present: true, disabled: button.disabled, text: button.textContent?.trim() } : { present: false }
    })()`)) as { present: boolean; disabled?: boolean; text?: string }
    await shot(win, '17-trash-settings')
    const trashBeforePurge = await fs.readdir(path.join(convertRoot, 'trash'))
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-action="empty-trash"]')?.click()`
    )
    await wait(300)
    const confirmLabel = (await win.webContents.executeJavaScript(
      `document.querySelector('.modal .modal-foot .btn-danger')?.textContent?.trim() ?? ''`
    )) as string
    await win.webContents.executeJavaScript(
      `document.querySelector('.modal .modal-foot .btn-danger')?.click()`
    )
    await wait(800)
    const trashAfterPurge = await fs.readdir(path.join(convertRoot, 'trash'))
    const mediaAfter = (await fs.readdir(path.join(convertRoot, 'media'))).length
    const trashState = (await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-action="empty-trash"]')
      return button ? { disabled: button.disabled } : null
    })()`)) as { disabled: boolean } | null
    console.log(
      '[trash]',
      JSON.stringify({
        trashUI,
        confirmLabel,
        before: trashBeforePurge.length,
        after: trashAfterPurge.length,
        mediaBefore,
        mediaAfter,
        trashState
      })
    )
    if (!trashUI.present || trashUI.disabled) {
      throw new Error(`Empty-trash button missing or disabled: ${JSON.stringify(trashUI)}`)
    }
    if (trashBeforePurge.length === 0) {
      throw new Error('Trash was empty before the purge check')
    }
    if (confirmLabel !== 'Delete forever') {
      throw new Error(`Unexpected confirm label: ${confirmLabel}`)
    }
    if (trashAfterPurge.length !== 0) {
      throw new Error(`Trash was not emptied: ${trashAfterPurge.join(', ')}`)
    }
    if (mediaAfter !== mediaBefore) {
      throw new Error(`Emptying trash changed media/ (${mediaBefore} -> ${mediaAfter})`)
    }
    if (!trashState?.disabled) {
      throw new Error('Empty-trash button did not disable itself')
    }

    console.log('[smoke] complete')
    app.exit(0)
  } catch (err) {
    console.error('[smoke] failed', err)
    app.exit(1)
  }
}
