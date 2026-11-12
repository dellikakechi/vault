import { stagingUrl } from '@shared/api'
import type { ImportResult, ProcessedImport, ScanEntry } from '@shared/types'
import {
  analyzeBitmap,
  blobToArrayBuffer,
  loadBitmap,
  probeImageDims,
  probeVideo
} from './media'

export interface ImportProgress {
  total: number
  done: number
  label: string
  phase: 'reading' | 'saving'
}

function titleFromName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled'
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

async function processImage(entry: ScanEntry): Promise<ProcessedImport> {
  const bitmap = await loadBitmap(stagingUrl(entry.path))
  try {
    const analysis = await analyzeBitmap(bitmap)
    return {
      path: entry.path,
      kind: entry.kind,
      title: titleFromName(entry.name),
      width: analysis.width,
      height: analysis.height,
      bytes: entry.bytes,
      thumb: await blobToArrayBuffer(analysis.thumb),
      phash: analysis.phash,
      hist: analysis.hist,
      color: analysis.color
    }
  } finally {
    bitmap.close()
  }
}

async function processVideo(entry: ScanEntry): Promise<ProcessedImport> {
  const probe = await probeVideo(stagingUrl(entry.path))
  return {
    path: entry.path,
    kind: 'video',
    title: titleFromName(entry.name),
    width: probe.width,
    height: probe.height,
    bytes: entry.bytes,
    durationMs: probe.durationMs,
    thumb: probe.thumb ? await blobToArrayBuffer(probe.thumb) : undefined,
    thumbTimeMs: Math.min(1200, Math.round(probe.durationMs * 0.15)),
    phash: probe.phash,
    hist: probe.hist,
    color: probe.color
  }
}

async function processComic(entry: ScanEntry): Promise<ProcessedImport> {
  const images = entry.images ?? []
  const pages = await mapPool(images, 6, async (img) => {
    try {
      const dims = await probeImageDims(stagingUrl(img.path))
      return { path: img.path, width: dims.width, height: dims.height, bytes: img.bytes }
    } catch {
      return { path: img.path, width: 0, height: 0, bytes: img.bytes }
    }
  })
  const cover = images[0]
  const bitmap = await loadBitmap(stagingUrl(cover.path))
  try {
    const analysis = await analyzeBitmap(bitmap)
    return {
      path: entry.path,
      kind: 'comic',
      title: titleFromName(entry.name),
      width: analysis.width,
      height: analysis.height,
      bytes: entry.bytes,
      thumb: await blobToArrayBuffer(analysis.thumb),
      phash: analysis.phash,
      hist: analysis.hist,
      color: analysis.color,
      pages,
      coverIndex: 0
    }
  } finally {
    bitmap.close()
  }
}

export async function importPaths(
  paths: string[],
  onProgress?: (p: ImportProgress) => void
): Promise<ImportResult> {
  const entries = await window.vault.scan(paths)
  const total = entries.length
  let done = 0
  const processed: (ProcessedImport | null)[] = new Array(entries.length).fill(null)
  const failures: { path: string; error: string }[] = []

  let cursor = 0
  const workers = Array.from({ length: Math.min(3, Math.max(1, entries.length)) }, async () => {
    while (cursor < entries.length) {
      const index = cursor++
      const entry = entries[index]
      onProgress?.({ total, done, label: entry.name, phase: 'reading' })
      try {
        if (entry.kind === 'comic' && entry.images?.length) {
          processed[index] = await processComic(entry)
        } else if (entry.kind === 'video') {
          processed[index] = await processVideo(entry)
        } else {
          processed[index] = await processImage(entry)
        }
      } catch (err) {
        failures.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) })
      }
      done++
      onProgress?.({ total, done, label: entry.name, phase: 'reading' })
    }
  })
  await Promise.all(workers)

  const ready = processed.filter((entry): entry is ProcessedImport => !!entry)
  onProgress?.({ total, done, label: 'Saving to library', phase: 'saving' })
  const result = await window.vault.commitImport(ready)
  return { ...result, failed: [...failures, ...result.failed] }
}
