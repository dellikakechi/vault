import { fileUrl } from '@shared/api'
import type { MediaItem } from '@shared/types'
import { useStore } from '../store'

export interface ConversionTask {
  id: string
  pageIndex: number | null
  file: string
}

export interface ConversionSummary {
  converted: number
  failed: number
  skipped: number
  already: number
  linked: number
  errors: string[]
}

interface QueueInfo {
  tasks: ConversionTask[]
  skipped: number
  already: number
  linked: number
}

const EMPTY_SUMMARY: ConversionSummary = {
  converted: 0,
  failed: 0,
  skipped: 0,
  already: 0,
  linked: 0,
  errors: []
}

let last: { seq: number; summary: ConversionSummary } = { seq: 0, summary: EMPTY_SUMMARY }

export function lastConversion(): { seq: number; summary: ConversionSummary } {
  return last
}

function baseName(file: string): string {
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] || file
}

function extension(file: string): string {
  const name = baseName(file).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot)
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[at + i] ?? 0)
  return out
}

function readU32BE(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
  )
}

function readU32LE(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
  )
}

/**
 * Animated files must never be flattened to a single frame. GIFs are skipped
 * by kind before this runs; this also catches animated PNG and WebP pages.
 */
function isAnimated(bytes: ArrayBuffer, file: string): boolean {
  const ext = extension(file)
  const data = new Uint8Array(bytes)
  if (ext === '.gif') return true
  if (ext === '.png') {
    let offset = 8
    while (offset + 12 <= data.length) {
      const length = readU32BE(data, offset)
      const type = ascii(data, offset + 4, 4)
      if (type === 'acTL') return true
      if (type === 'IDAT' || type === 'IEND') break
      offset += 12 + length
      if (length > data.length) break
    }
  }
  if (ext === '.webp') {
    let offset = 12
    while (offset + 8 <= data.length) {
      const type = ascii(data, offset, 4)
      const length = readU32LE(data, offset + 4)
      if (type === 'ANIM') return true
      if (type === 'ANMF') break
      offset += 8 + length + (length & 1)
    }
  }
  if (ext === '.avif') {
    // The `avis` brand marks an AVIF image sequence (animated AVIF).
    const head = data.subarray(0, Math.min(data.length, 64))
    for (let index = 0; index + 4 <= head.length; index++) {
      if (ascii(head, index, 4) === 'avis') return true
    }
  }
  return false
}

function buildQueue(ids: string[], items: Record<string, MediaItem>): QueueInfo {
  const info: QueueInfo = { tasks: [], skipped: 0, already: 0, linked: 0 }
  for (const id of new Set(ids)) {
    const item = items[id]
    if (!item) continue
    if (item.linked) {
      info.linked++
      continue
    }
    if (item.kind === 'video' || item.kind === 'gif') {
      info.skipped++
      continue
    }
    if (item.kind === 'comic' || item.kind === 'set') {
      const pages = item.pages ?? []
      for (let index = 0; index < pages.length; index++) {
        const page = pages[index]
        if (page.convertedToWebp) {
          info.already++
        } else if (extension(page.file) === '.gif') {
          info.skipped++
        } else {
          info.tasks.push({ id, pageIndex: index, file: page.file })
        }
      }
      continue
    }
    if (item.convertedToWebp) {
      info.already++
      continue
    }
    if (extension(item.file) === '.gif') {
      info.skipped++
      continue
    }
    info.tasks.push({ id, pageIndex: null, file: item.file })
  }
  return info
}

// ---------------------------------------------------------------------------
// Encoder worker. Falls back to the main thread if the worker cannot start.
// ---------------------------------------------------------------------------

let worker: Worker | null = null
let workerBroken = false
let workerSeq = 0
const pending = new Map<number, { resolve: (data: ArrayBuffer) => void; reject: (err: Error) => void }>()

function stopWorker(error: Error): void {
  for (const entry of pending.values()) entry.reject(error)
  pending.clear()
  workerBroken = true
  worker?.terminate()
  worker = null
}

function ensureWorker(): Worker | null {
  if (workerBroken) return null
  if (worker) return worker
  try {
    const created = new Worker(new URL('./webpWorker.ts', import.meta.url), { type: 'module' })
    created.onmessage = (event: MessageEvent<{ id: number; data?: ArrayBuffer; error?: string }>) => {
      const message = event.data
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) {
        entry.reject(new Error(message.error))
        stopWorker(new Error(message.error))
      } else if (message.data) {
        entry.resolve(message.data)
      } else {
        entry.reject(new Error('Encoder returned no data'))
      }
    }
    created.onerror = (event) => {
      stopWorker(new Error(event.message || 'WebP encoder worker failed'))
    }
    worker = created
    return created
  } catch {
    workerBroken = true
    return null
  }
}

function encodeInWorker(instance: Worker, image: ImageData): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const id = ++workerSeq
    pending.set(id, { resolve, reject })
    instance.postMessage(
      { id, width: image.width, height: image.height, data: image.data.buffer },
      [image.data.buffer]
    )
  })
}

async function encodeImage(image: ImageData): Promise<ArrayBuffer> {
  const instance = ensureWorker()
  if (instance) {
    try {
      return await encodeInWorker(instance, image)
    } catch (err) {
      // Once the buffer is transferred it cannot be reused. Let the caller
      // record this image as failed; later images use the main-thread fallback.
      if (image.data.buffer.byteLength === 0) throw err
    }
  }
  const { encodeLossless } = await import('./webpEncoder')
  return await encodeLossless(image)
}

// ---------------------------------------------------------------------------

async function convertOne(task: ConversionTask): Promise<'converted' | 'animated' | 'missing'> {
  const response = await fetch(fileUrl(task.file))
  if (!response.ok) throw new Error(`Could not read file (${response.status})`)
  const blob = await response.blob()
  const bytes = await blob.arrayBuffer()
  if (isAnimated(bytes, task.file)) return 'animated'

  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  try {
    const width = bitmap.width
    const height = bitmap.height
    if (!width || !height) throw new Error('Image has no pixels')
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas unavailable')
    // Drawing into a plain sRGB canvas bakes EXIF orientation and any colour
    // profile into the pixels, so stripping metadata cannot change the result.
    ctx.drawImage(bitmap, 0, 0)
    const pixels = ctx.getImageData(0, 0, width, height)
    const encoded = await encodeImage(pixels)
    const updated = await window.vault.convertImage(task.id, task.pageIndex, encoded, width, height)
    if (!updated) return 'missing'
    useStore.getState().mergeItems([updated])
    return 'converted'
  } finally {
    bitmap.close()
  }
}

function finish(summary: ConversionSummary): ConversionSummary {
  last = { seq: last.seq + 1, summary }
  return summary
}

/**
 * Convert every eligible image and comic page in `ids`. Already-converted
 * images are skipped, so running the same selection twice does no work.
 */
export async function runConversion(ids: string[]): Promise<ConversionSummary | null> {
  const store = useStore.getState()
  if (store.convertState) {
    store.toast('A conversion is already running', 'info')
    return null
  }
  const lib = store.lib
  if (!lib) return null

  const queue = buildQueue(ids, lib.items)
  if (!queue.tasks.length) {
    const summary = finish({
      ...EMPTY_SUMMARY,
      skipped: queue.skipped,
      already: queue.already,
      linked: queue.linked
    })
    if (queue.linked) {
      store.toast(
        `${queue.linked} linked item${queue.linked === 1 ? '' : 's'} skipped — files outside the library are never modified`,
        'info'
      )
    } else if (queue.already) {
      store.toast('Those images are already lossless WebP', 'info')
    } else if (queue.skipped) {
      store.toast('Nothing to convert — GIFs and videos are left as-is', 'info')
    } else {
      store.toast('Nothing to convert', 'info')
    }
    return summary
  }

  let converted = 0
  let failed = 0
  let skipped = queue.skipped
  const errors: string[] = []
  const setProgress = (done: number, label: string): void => {
    useStore.getState().setConvertState({
      total: queue.tasks.length,
      done,
      failed,
      skipped,
      label
    })
  }

  setProgress(0, baseName(queue.tasks[0].file))
  try {
    for (let index = 0; index < queue.tasks.length; index++) {
      const task = queue.tasks[index]
      const item = useStore.getState().lib?.items[task.id]
      const alreadyGone = !item
      const alreadyDone =
        !!item &&
        (task.pageIndex === null
          ? !!item.convertedToWebp
          : !!item.pages?.[task.pageIndex]?.convertedToWebp)
      if (alreadyGone || alreadyDone) {
        skipped++
        setProgress(index + 1, baseName(task.file))
        continue
      }

      setProgress(index, baseName(task.file))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      try {
        const result = await convertOne(task)
        if (result === 'converted') converted++
        else skipped++
      } catch (err) {
        failed++
        errors.push(`${baseName(task.file)}: ${err instanceof Error ? err.message : String(err)}`)
      }
      setProgress(index + 1, baseName(task.file))
    }
  } finally {
    useStore.getState().setConvertState(null)
  }

  const summary = finish({ converted, failed, skipped, already: queue.already, linked: queue.linked, errors })
  const noun = converted === 1 ? 'image' : 'images'
  if (converted) {
    const notes: string[] = []
    if (failed) notes.push(`${failed} failed`)
    if (skipped) notes.push(`${skipped} skipped`)
    if (queue.linked) notes.push(`${queue.linked} linked left alone`)
    useStore
      .getState()
      .toast(
        `Converted ${converted} ${noun} to lossless WebP${notes.length ? ` · ${notes.join(' · ')}` : ''}`,
        failed ? 'info' : 'success'
      )
  } else if (failed) {
    useStore.getState().toast(`Conversion failed — ${errors[0] ?? 'unknown error'}`, 'error')
  } else if (queue.linked) {
    useStore.getState().toast(
      `${queue.linked} linked item${queue.linked === 1 ? '' : 's'} skipped — files outside the library are never modified`,
      'info'
    )
  } else {
    useStore.getState().toast('Nothing to convert', 'info')
  }
  return summary
}
