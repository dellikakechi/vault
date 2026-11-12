import type { MediaItem } from '@shared/types'
import { clamp, hashString, hueOf } from './util'
import type { ManualPlacement } from './manual'

export type ArrangeMode = 'scatter' | 'grid' | 'hue' | 'similar' | 'time'

export interface Placement {
  x: number
  y: number
  w: number
  h: number
  rot: number
}

export interface ClusterFrame {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
  accent: string
}

export interface LayoutResult {
  placements: Map<string, Placement>
  clusters: ClusterFrame[]
  bounds: { w: number; h: number }
}

const BASE_GAP = 18
const SCATTER_GAP = 40
const PAD = 26
const LABEL_H = 40
const MAX_ROW = 3100
/** Empty space between the existing canvas and a newly imported batch. */
const BATCH_GAP_MIN = 300
const BATCH_GAP_TILES = 1.5
/** Once the canvas is this wide, start a new batch underneath instead. */
const BATCH_MAX_WIDTH = 4200

function tileHeight(item: MediaItem, base: number): number {
  const ar = item.width && item.height ? item.height / item.width : 0.72
  return Math.round(clamp(base * ar, base * 0.58, base * 1.6))
}

function hammingHex(a: string, b: string): number {
  let d = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) {
      d += x & 1
      x >>= 1
    }
  }
  return d
}

function masonry(items: MediaItem[], base: number, gap: number, columns: number): Map<string, Placement> {
  const out = new Map<string, Placement>()
  const heights = new Array(columns).fill(0)
  for (const item of items) {
    const w = base
    const h = tileHeight(item, base)
    let col = 0
    for (let i = 1; i < columns; i++) {
      if (heights[i] < heights[col] - 0.5) col = i
    }
    const x = col * (w + gap)
    const y = heights[col]
    out.set(item.id, { x, y, w, h, rot: 0 })
    heights[col] = y + h + gap
  }
  return out
}

function shelf(
  groups: { id: string; label: string; items: MediaItem[]; accent: string }[],
  base: number
): LayoutResult {
  const placements = new Map<string, Placement>()
  const clusters: ClusterFrame[] = []
  let cx = 0
  let cy = 0
  let rowH = 0
  const gap = BASE_GAP

  for (const group of groups) {
    const n = group.items.length
    if (!n) continue
    const widths = group.items.map(() => base)
    const height = Math.max(...group.items.map((i) => tileHeight(i, base)))
    const width = PAD * 2 + widths.reduce((a, b) => a + b, 0) + gap * (n - 1)
    const totalH = PAD * 2 + LABEL_H + height
    if (cx > 0 && cx + width > MAX_ROW) {
      cx = 0
      cy += rowH + gap * 2
      rowH = 0
    }
    let px = cx + PAD
    group.items.forEach((item, i) => {
      const h = tileHeight(item, base)
      placements.set(item.id, {
        x: px,
        y: cy + PAD + LABEL_H + (height - h),
        w: widths[i],
        h,
        rot: 0
      })
      px += widths[i] + gap
    })
    clusters.push({
      id: group.id,
      label: group.label,
      x: cx,
      y: cy,
      w: width,
      h: totalH,
      accent: group.accent
    })
    cx += width + gap * 2
    rowH = Math.max(rowH, totalH)
  }

  return { placements, clusters, bounds: { w: Math.max(cx, 1), h: cy + rowH } }
}

function clusterBySimilarity(items: MediaItem[], threshold = 13, maxSize = 6): MediaItem[][] {
  const remaining = new Set(items.map((i) => i.id))
  const byId = new Map(items.map((i) => [i.id, i]))
  const clusters: MediaItem[][] = []

  const sorted = [...items].sort((a, b) => {
    const ha = a.phash ? parseInt(a.phash.slice(0, 8), 16) : 0
    const hb = b.phash ? parseInt(b.phash.slice(0, 8), 16) : 0
    return ha - hb
  })

  for (const seed of sorted) {
    if (!remaining.has(seed.id)) continue
    const cluster: MediaItem[] = [seed]
    remaining.delete(seed.id)
    let changed = true
    while (changed && cluster.length < maxSize) {
      changed = false
      let best: MediaItem | null = null
      let bestDist = Infinity
      for (const candidate of remaining) {
        const item = byId.get(candidate)!
        if (!item.phash) continue
        for (const member of cluster) {
          if (!member.phash) continue
          const d = hammingHex(item.phash, member.phash)
          if (d <= threshold && d < bestDist) {
            bestDist = d
            best = item
          }
        }
      }
      if (best) {
        cluster.push(best)
        remaining.delete(best.id)
        changed = true
      }
    }
    clusters.push(cluster)
  }

  const singles = clusters.filter((c) => c.length === 1).flat()
  const multi = clusters.filter((c) => c.length > 1)
  if (singles.length) multi.push(singles)
  return multi
}

function dominantTag(items: MediaItem[]): string | null {
  const counts = new Map<string, number>()
  for (const item of items) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  for (const [tag, count] of counts) {
    if (count > bestCount) {
      best = tag
      bestCount = count
    }
  }
  return best
}

function dayLabel(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((startOf(today) - startOf(date)) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return `${diff} days ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function normalize(result: LayoutResult): LayoutResult {
  let minX = Infinity
  let minY = Infinity
  let maxX = 0
  let maxY = 0
  for (const p of result.placements.values()) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + p.w)
    maxY = Math.max(maxY, p.y + p.h)
  }
  if (!Number.isFinite(minX)) return result
  const dx = -minX
  const dy = -minY
  for (const p of result.placements.values()) {
    p.x += dx
    p.y += dy
  }
  for (const c of result.clusters) {
    c.x += dx
    c.y += dy
  }
  return { ...result, bounds: { w: maxX - minX, h: maxY - minY } }
}

export function layoutItems(items: MediaItem[], mode: ArrangeMode, base: number): LayoutResult {
  if (!items.length) {
    return { placements: new Map(), clusters: [], bounds: { w: 0, h: 0 } }
  }
  const columns = Math.max(2, Math.round(Math.sqrt(items.length * 1.6)))

  if (mode === 'similar') {
    const clusters = clusterBySimilarity(items)
    const groups = clusters.map((members, i) => {
      const tag = dominantTag(members)
      return {
        id: `cluster-${i}`,
        label: members.length > 1 ? (tag ? `Similar · ${tag}` : 'Similar') : tag ? `Unclustered · ${tag}` : 'Unclustered',
        items: members,
        accent: tag ? 'tag' : members.length > 1 ? 'similar' : 'plain'
      }
    })
    return normalize(shelf(groups, base))
  }

  if (mode === 'time') {
    const buckets = new Map<string, MediaItem[]>()
    const sorted = [...items].sort((a, b) => b.addedAt - a.addedAt)
    for (const item of sorted) {
      const key = dayLabel(item.addedAt)
      const arr = buckets.get(key)
      if (arr) arr.push(item)
      else buckets.set(key, [item])
    }
    const groups = [...buckets.entries()].map(([label, members], i) => ({
      id: `day-${i}`,
      label,
      items: members,
      accent: 'time'
    }))
    return normalize(shelf(groups, base))
  }

  const ordered =
    mode === 'hue'
      ? [...items].sort((a, b) => hueOf(a.color) - hueOf(b.color))
      : [...items].sort((a, b) => b.addedAt - a.addedAt)

  const gap = mode === 'scatter' ? SCATTER_GAP : BASE_GAP
  const placements = masonry(ordered, base, gap, columns)

  if (mode === 'scatter') {
    for (const item of ordered) {
      const p = placements.get(item.id)!
      const h = hashString(item.id)
      const jx = ((h % 1000) / 1000 - 0.5) * 26
      const jy = (((h >> 10) % 1000) / 1000 - 0.5) * 30
      const rot = (((h >> 20) % 1000) / 1000 - 0.5) * 2.4
      p.x += jx
      p.y += jy
      p.rot = rot
    }
  }

  return normalize({ placements, clusters: [], bounds: { w: 0, h: 0 } })
}

/**
 * Position a freshly added batch in an empty region of the free canvas.
 *
 * The existing items are measured with their manual overrides applied, then
 * the batch is laid out with the same scatter rhythm to the right of (or, for
 * very wide canvases, below) everything else. The returned entries are
 * `scatterOnly`, so the arranged modes can still reflow normally.
 */
export function placeBatch(
  existing: MediaItem[],
  batch: MediaItem[],
  base: number,
  manual: Record<string, ManualPlacement>
): Record<string, ManualPlacement> | null {
  if (!existing.length || !batch.length) return null

  const layout = layoutItems(existing, 'scatter', base)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [id, p] of layout.placements) {
    const m = manual[id]
    const x = m ? m.x : p.x
    const y = m ? m.y : p.y
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + p.w)
    maxY = Math.max(maxY, y + p.h)
  }
  if (!Number.isFinite(minX)) return null

  const columns = Math.max(1, Math.round(Math.sqrt(batch.length * 1.6)))
  const batchLayout = masonry(batch, base, SCATTER_GAP, columns)
  let batchW = 0
  for (const p of batchLayout.values()) batchW = Math.max(batchW, p.x + p.w)

  const gap = Math.max(BATCH_GAP_MIN, Math.round(base * BATCH_GAP_TILES))
  const below = maxX - minX + gap + batchW > BATCH_MAX_WIDTH
  const originX = below ? minX : maxX + gap
  const originY = below ? maxY + gap : minY

  const out: Record<string, ManualPlacement> = {}
  for (const item of batch) {
    const p = batchLayout.get(item.id)
    if (!p) continue
    const h = hashString(item.id)
    const jx = ((h % 1000) / 1000 - 0.5) * 26
    const jy = (((h >> 10) % 1000) / 1000 - 0.5) * 30
    out[item.id] = {
      x: originX + p.x + jx,
      y: originY + p.y + jy,
      scatterOnly: true
    }
  }
  return Object.keys(out).length ? out : null
}
