import type { MediaItem, ViewId } from '@shared/types'
import { fileUrl, thumbUrl } from '@shared/api'
import { useStore } from './store'
import { blobToArrayBuffer } from './lib/media'
import { runImport } from './lib/importRunner'
import { lastConversion, runConversion } from './lib/convertRunner'
import { itemMatchesQuery, parseQuery } from './lib/search'
import { layoutItems } from './lib/arrange'

/**
 * Test harness hooks. Only installed when the app was launched with `--smoke`,
 * so they are never reachable in a normal session.
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor<T>(read: () => T | null, timeout = 2500): Promise<T | null> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = read()
    if (value) return value
    await wait(50)
  }
  return null
}

function tagRow(name: string): HTMLElement | null {
  const rows = [...document.querySelectorAll<HTMLElement>('.tag-manager-row')]
  return rows.find((row) => row.querySelector('.name')?.textContent?.trim() === name) ?? null
}

/**
 * Tag categories are collapsed by default, so the smoke helpers that drive
 * individual tag rows (rename, delete, assign) have to open the tree first.
 * Nested categories only exist in the DOM once their parent is open, hence
 * the loop.
 */
async function expandTagManagerCategories(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const caret = document.querySelector<HTMLElement>(
      '.tag-manager-caret[aria-expanded="false"]'
    )
    if (!caret) break
    caret.click()
    await wait(120)
  }
}

/** Return the manager to its default, fully collapsed state. */
async function collapseTagManagerCategories(): Promise<void> {
  // Collapse deepest groups first so their parents still have a caret when
  // their turn comes.
  for (let i = 0; i < 12; i += 1) {
    const carets = [
      ...document.querySelectorAll<HTMLElement>('.tag-manager-caret[aria-expanded="true"]')
    ]
    const caret = carets.at(-1)
    if (!caret) break
    caret.click()
    await wait(120)
  }
}

function categoryGroup(name: string): HTMLElement | null {
  const groups = [...document.querySelectorAll<HTMLElement>('.tag-manager-group')]
  return (
    groups.find(
      (group) => group.querySelector('.tag-manager-group-name')?.textContent?.trim() === name
    ) ?? null
  )
}

function directTagRows(group: HTMLElement | null): HTMLElement[] {
  if (!group) return []
  const wrap = [...group.children].find((child) =>
    child.classList.contains('tag-manager-tags')
  )
  return wrap ? [...wrap.querySelectorAll<HTMLElement>('.tag-manager-row')] : []
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function inboxIds(): string[] {
  const lib = useStore.getState().lib
  if (!lib) return []
  return Object.values(lib.items)
    .filter((item) => item.inbox)
    .map((item) => item.id)
}

function aiQueueIds(): string[] {
  const lib = useStore.getState().lib
  if (!lib) return []
  return Object.values(lib.items)
    .filter((item) => item.aiQueue)
    .map((item) => item.id)
}

function membershipCounts(): { inbox: number; aiQueue: number; tagged: number; items: number } {
  const lib = useStore.getState().lib
  const items = lib ? Object.values(lib.items) : []
  return {
    inbox: items.filter((item) => item.inbox).length,
    aiQueue: items.filter((item) => item.aiQueue).length,
    tagged: items.filter((item) => item.tags.length > 0).length,
    items: items.length
  }
}

/**
 * Report what the detail panel is currently showing, including whether the
 * preview image decoded. A blank preview after opening a tile is the bug this
 * guards against.
 */
function previewState(): {
  ok: boolean
  detailId: string | null
  kind?: string
  file?: string
  src: string | null
  naturalWidth: number
  complete: boolean
} {
  const detailId = useStore.getState().detailId
  const item = detailId ? useStore.getState().lib?.items[detailId] : null
  const img = document.querySelector<HTMLImageElement>('.detail-preview img')
  return {
    ok: !!img && img.complete && img.naturalWidth > 0,
    detailId,
    kind: item?.kind,
    file: item?.file,
    src: img?.getAttribute('src') ?? null,
    naturalWidth: img?.naturalWidth ?? 0,
    complete: img?.complete ?? false
  }
}

function videoState(video: HTMLVideoElement | null): {
  present: boolean
  loop: boolean
  preload: string
  muted: boolean
  playing: boolean
  ended: boolean
  duration: number
} {
  if (!video) {
    return { present: false, loop: false, preload: '', muted: false, playing: false, ended: false, duration: 0 }
  }
  return {
    present: true,
    loop: video.loop,
    preload: video.preload,
    muted: video.muted,
    playing: !video.paused && !video.ended,
    ended: video.ended,
    duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : 0
  }
}

function loopBufferState(video: HTMLVideoElement): {
  label: string
  opacity: number
  paused: boolean
  ended: boolean
  preload: string
  muted: boolean
  currentTime: number
  duration: number
  readyState: number
} {
  return {
    label: video.dataset.smoothLoop ?? '',
    opacity: Number(getComputedStyle(video).opacity),
    paused: video.paused,
    ended: video.ended,
    preload: video.preload,
    muted: video.muted,
    currentTime: Number(video.currentTime.toFixed(2)),
    duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : 0,
    readyState: video.readyState
  }
}

function dupeInfo(): {
  groups: number
  items: number
  identical: number
  variation: number
  mixed: number
  keeps: number
  deletes: number
  distances: number[]
  groupsDetail: { kind: string; items: string[] }[]
} {
  const groups = useStore.getState().dupes ?? []
  let items = 0
  let identical = 0
  let variation = 0
  let mixed = 0
  let keeps = 0
  let deletes = 0
  const distances: number[] = []
  const groupsDetail: { kind: string; items: string[] }[] = []
  for (const g of groups) {
    items += g.items.length
    if (g.kind === 'identical') identical++
    else if (g.kind === 'variation') variation++
    else mixed++
    groupsDetail.push({
      kind: g.kind,
      items: g.items.map((e) => `${e.item.kind} · ${e.item.title.slice(0, 22)} · d${e.distance}`)
    })
    for (const e of g.items) {
      distances.push(e.distance)
      if (e.suggested === 'keep') keeps++
      else deletes++
    }
  }
  distances.sort((a, b) => a - b)
  return {
    groups: groups.length,
    items,
    identical,
    variation,
    mixed,
    keeps,
    deletes,
    distances,
    groupsDetail
  }
}

/**
 * Measure the free-canvas gap between auto-placed import batches and every
 * other inbox item. Used by the smoke run to prove batches land apart.
 */
function batchSeparation(): {
  batch: number
  existing: number
  gapX: number
  gapY: number
  overlap: boolean
  ok: boolean
} | null {
  const lib = useStore.getState().lib
  if (!lib) return null
  const manual = useStore.getState().manual
  const inbox = Object.values(lib.items).filter((item) => item.inbox)
  const batchIds = Object.keys(manual).filter(
    (id) => manual[id].scatterOnly && lib.items[id]?.inbox
  )
  const batchSet = new Set(batchIds)
  const layout = layoutItems(inbox, 'scatter', lib.settings.tileSize || 210)
  type Box = { x: number; y: number; w: number; h: number }
  const boxes = (items: MediaItem[]): Box[] =>
    items
      .map((item) => {
        const p = layout.placements.get(item.id)
        if (!p) return null
        const m = manual[item.id]
        return { x: m?.x ?? p.x, y: m?.y ?? p.y, w: p.w, h: p.h }
      })
      .filter((b): b is Box => !!b)
  const batch = boxes(inbox.filter((item) => batchSet.has(item.id)))
  const rest = boxes(inbox.filter((item) => !batchSet.has(item.id)))
  if (!batch.length || !rest.length) {
    return {
      batch: batch.length,
      existing: rest.length,
      gapX: 0,
      gapY: 0,
      overlap: false,
      ok: false
    }
  }
  const maxX = Math.max(...rest.map((b) => b.x + b.w))
  const maxY = Math.max(...rest.map((b) => b.y + b.h))
  const minX = Math.min(...batch.map((b) => b.x))
  const minY = Math.min(...batch.map((b) => b.y))
  const gapX = Math.round(minX - maxX)
  const gapY = Math.round(minY - maxY)
  const overlap = rest.some((a) =>
    batch.some(
      (b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
    )
  )
  return {
    batch: batch.length,
    existing: rest.length,
    gapX,
    gapY,
    overlap,
    ok: !overlap && (gapX >= 120 || gapY >= 120)
  }
}

function findItem(predicate: (item: import('@shared/types').MediaItem) => boolean): string | null {
  const lib = useStore.getState().lib
  if (!lib) return null
  const item = Object.values(lib.items).find(predicate)
  return item?.id ?? null
}

const TAG_WORDS = [
  'harbor',
  'dune',
  'portrait',
  'neon',
  'forest',
  'studio',
  'mountain',
  'street',
  'abstract',
  'canyon'
]

async function demoTagging(): Promise<number> {
  const lib = useStore.getState().lib
  if (!lib) return 0
  const items = Object.values(lib.items).filter((item) => item.kind !== 'comic')

  // Build title-based groups, then hold one item per group back as an
  // untagged review case. That mirrors real use: a tag has examples, and a
  // new item with a similar name still needs confirming.
  const groups = new Map<string, string[]>()
  const moody: string[] = []
  items.forEach((item, index) => {
    if (index % 4 === 0) moody.push(item.id)
    const title = item.title.toLowerCase()
    const word = TAG_WORDS.find((w) => title.includes(w))
    if (!word) return
    const list = groups.get(word) ?? []
    list.push(item.id)
    groups.set(word, list)
  })

  let trained = 0
  for (const [tag, ids] of groups) {
    const train = ids.slice(0, -1)
    if (!train.length) continue
    await window.vault.applyTags(train, [tag], [])
    trained++
  }
  // A second, overlapping tag gives the smoke run something to exercise
  // multi-tag AND filters and exclusions with.
  if (moody.length) await window.vault.applyTags(moody, ['moody'], [])

  const fresh = await window.vault.getLibrary()
  useStore.setState({ lib: fresh })
  return trained
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  t: number,
  hue: number,
  label: string
): void {
  const grad = ctx.createLinearGradient(0, 0, width, height)
  grad.addColorStop(0, `hsl(${hue} 55% 12%)`)
  grad.addColorStop(0.55, `hsl(${hue + 28} 62% 34%)`)
  grad.addColorStop(1, `hsl(${hue + 70} 70% 58%)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, width, height)

  for (let i = 0; i < 5; i++) {
    const phase = t * Math.PI * 2 + i * 1.1
    const x = width * (0.5 + 0.34 * Math.sin(phase))
    const y = height * (0.5 + 0.3 * Math.cos(phase * 1.2))
    const r = height * (0.1 + i * 0.035)
    ctx.beginPath()
    ctx.fillStyle = `hsla(${hue + i * 34} 80% 65% / ${0.1 + i * 0.035})`
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  // Sweeping highlight so scrubbing visibly changes every frame.
  const sweep = ((t * 1.6) % 1) * width
  const beam = ctx.createLinearGradient(sweep - 160, 0, sweep + 160, 0)
  beam.addColorStop(0, 'rgba(255,255,255,0)')
  beam.addColorStop(0.5, 'rgba(255,255,255,0.16)')
  beam.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = beam
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = 'rgba(8,8,10,0.6)'
  ctx.fillRect(0, height - 112, width, 112)
  ctx.fillStyle = '#f2f2f6'
  ctx.font = '600 34px "Segoe UI", system-ui, sans-serif'
  ctx.fillText(label, 44, height - 56)
  ctx.fillStyle = 'rgba(242,242,246,0.6)'
  ctx.font = '500 20px "Cascadia Mono", ui-monospace, monospace'
  ctx.fillText(`${t.toFixed(2)}s`, 44, height - 26)

  ctx.strokeStyle = 'rgba(255,255,255,0.22)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(44, height - 96)
  ctx.lineTo(44 + (width - 88) * Math.min(1, t), height - 96)
  ctx.stroke()
}

async function recordClip(label: string, hue: number, durationMs: number): Promise<ArrayBuffer> {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')

  const stream = canvas.captureStream(30)

  let audioCtx: AudioContext | null = null
  try {
    audioCtx = new AudioContext()
    await audioCtx.resume().catch(() => {})
    const dest = audioCtx.createMediaStreamDestination()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = 140 + hue * 0.6
    gain.gain.value = 0.035
    osc.connect(gain)
    gain.connect(dest)
    osc.start()
    for (const track of dest.stream.getAudioTracks()) stream.addTrack(track)
  } catch {
    audioCtx = null
  }

  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  const mime = candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond: 2_600_000
    })
  } catch {
    recorder = new MediaRecorder(stream)
  }

  const chunks: BlobPart[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data)
  }
  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }))
  })

  recorder.start(120)
  const start = performance.now()

  await new Promise<void>((resolve) => {
    const frame = (): void => {
      const elapsed = performance.now() - start
      const t = Math.min(1, elapsed / durationMs)
      drawClip(ctx, canvas.width, canvas.height, t, hue, label)
      if (t < 1) requestAnimationFrame(frame)
      else resolve()
    }
    frame()
  })

  recorder.stop()
  const blob = await stopped
  stream.getTracks().forEach((track) => track.stop())
  if (audioCtx) void audioCtx.close().catch(() => {})
  return blobToArrayBuffer(blob)
}

async function makeDemoVideos(): Promise<string[]> {
  const clips = [
    { name: 'harbor drift', label: 'Harbor drift', hue: 192 },
    { name: 'studio warm loop', label: 'Studio warm loop', hue: 38 }
  ]
  const files: string[] = []
  for (const clip of clips) {
    const buffer = await recordClip(clip.label, clip.hue, 2400)
    const file = await window.vault.writeTemp(`${clip.name}.webm`, buffer)
    files.push(file)
  }
  await runImport(files)
  return files
}

/** Put an untagged item with a strong title match into the AI queue. */
async function sendUntaggedToAI(): Promise<{
  ok: boolean
  id?: string
  title?: string
  tag?: string
  inbox?: number
  aiQueue?: number
  tagged?: number
  items?: number
}> {
  const lib = useStore.getState().lib
  if (!lib) return { ok: false }
  const names = lib.tags.map((tag) => tag.name)
  const candidate = Object.values(lib.items).find(
    (item) =>
      item.kind !== 'comic' &&
      !item.aiQueue &&
      item.tags.length === 0 &&
      names.some((tag) => item.title.toLowerCase().includes(tag))
  )
  if (!candidate) return { ok: false, ...membershipCounts() }
  await useStore.getState().setMembership([candidate.id], { aiQueue: true })
  return {
    ok: true,
    id: candidate.id,
    title: candidate.title,
    tag: names.find((tag) => candidate.title.toLowerCase().includes(tag)),
    ...membershipCounts()
  }
}

async function runAI(): Promise<number> {  const store = useStore.getState()
  const lib = store.lib
  if (!lib) return 0
  if (!lib.settings.ai.enabled) {
    await store.updateSettings({ ai: { ...lib.settings.ai, enabled: true } })
  }
  const ids = aiQueueIds()
  if (!ids.length) return 0
  const ai = useStore.getState().lib?.settings.ai
  if (!ai) return 0
  const useModel = ai.provider === 'openai' && !!ai.apiKey
  const results = await window.vault.aiSuggest(ids, useModel)
  const fresh = await window.vault.getLibrary()
  useStore.setState({ lib: fresh })
  return results.filter((r) => r.suggestions.length).length
}

/** Reject an item's suggestions, then re-run the tagger to prove the negative sticks. */
async function aiRejectFeedback(): Promise<{
  ok: boolean
  itemId?: string
  rejected?: string[]
  remembered?: string[]
  resuggested?: string[]
  stillSuggested?: string[]
}> {
  const lib = useStore.getState().lib
  if (!lib) return { ok: false }
  const target = Object.values(lib.items).find((item) => item.ai?.length && item.aiQueue)
  if (!target?.ai?.length) return { ok: false }
  const rejected = target.ai.map((suggestion) => suggestion.tag)
  await window.vault.aiReject([target.id])
  await window.vault.aiSuggest([target.id], false)
  const fresh = await window.vault.getLibrary()
  useStore.setState({ lib: fresh })
  const item = fresh.items[target.id]
  const remembered = item?.rejectedTags ?? []
  const stillSuggested = (item?.ai ?? [])
    .map((suggestion) => suggestion.tag)
    .filter((tag) => rejected.includes(tag))
  return {
    ok: rejected.every((tag) => remembered.includes(tag)) && stillSuggested.length === 0,
    itemId: target.id,
    rejected,
    remembered,
    resuggested: (item?.ai ?? []).map((suggestion) => suggestion.tag),
    stillSuggested
  }
}

interface PixelSignature {
  ok: boolean
  size: string
  hash: string
  error?: string
}

/** Hash the pixels the app would actually display, after orientation/colour. */
async function pixelSignature(rel: string): Promise<PixelSignature> {
  try {
    const response = await fetch(fileUrl(rel))
    if (!response.ok) return { ok: false, size: '', hash: '', error: `HTTP ${response.status}` }
    const bitmap = await createImageBitmap(await response.blob(), {
      imageOrientation: 'from-image'
    })
    try {
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { ok: false, size: '', hash: '', error: 'Canvas unavailable' }
      ctx.drawImage(bitmap, 0, 0)
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
      let hash = 2166136261
      for (let i = 0; i < data.length; i += 4) {
        hash = Math.imul(hash ^ data[i], 16777619)
        hash = Math.imul(hash ^ data[i + 1], 16777619)
        hash = Math.imul(hash ^ data[i + 2], 16777619)
        hash = Math.imul(hash ^ data[i + 3], 16777619)
      }
      return {
        ok: true,
        size: `${bitmap.width}x${bitmap.height}`,
        hash: (hash >>> 0).toString(16)
      }
    } finally {
      bitmap.close()
    }
  } catch (err) {
    return {
      ok: false,
      size: '',
      hash: '',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Exercise the real bulk-bar button: convert one image and one comic (plus a
 * GIF that must be skipped), compare decoded pixels before/after, verify the
 * lossless VP8L marker and prove a second run does no work.
 */
async function conversionCheck(): Promise<Record<string, unknown>> {
  const lib = useStore.getState().lib
  if (!lib) return { ok: false, stage: 'library' }
  const items = Object.values(lib.items)
  const image = items.find(
    (item) => item.kind === 'image' && !item.linked && !item.convertedToWebp
  )
  const comic = items.find(
    (item) =>
      item.kind === 'comic' &&
      !item.linked &&
      !item.convertedToWebp &&
      !!item.pages?.length
  )
  const gif = items.find((item) => item.kind === 'gif' && !item.linked)
  if (!image || !comic) return { ok: false, stage: 'targets' }

  const ids = [image.id, comic.id, ...(gif ? [gif.id] : [])]
  const imageBefore = await pixelSignature(image.file)
  const comicBefore = await pixelSignature(comic.pages![0].file)

  const seqBefore = lastConversion().seq
  const store = useStore.getState()
  store.setView('library')
  store.select(ids, 'replace')
  await wait(350)
  const button = document.querySelector<HTMLButtonElement>('[data-action="bulk-convert"]')
  if (!button) return { ok: false, stage: 'button' }
  button.click()

  const dock = await waitFor(() => document.querySelector<HTMLElement>('.convert-dock'))
  const dockText = dock?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  const firstRun = await waitFor(
    () => (lastConversion().seq > seqBefore ? lastConversion() : null),
    120000
  )
  if (!firstRun) {
    return {
      ok: false,
      stage: 'timeout',
      dockText,
      convertState: useStore.getState().convertState
    }
  }

  const fresh = await window.vault.getLibrary()
  useStore.setState({ lib: fresh })
  const imageAfterItem = fresh.items[image.id]
  const comicAfter = fresh.items[comic.id]
  const gifAfter = gif ? fresh.items[gif.id] : null
  const imageAfter = imageAfterItem
    ? await pixelSignature(imageAfterItem.file)
    : { ok: false, size: '', hash: '' }
  const comicAfterSignature = comicAfter?.pages?.[0]
    ? await pixelSignature(comicAfter.pages[0].file)
    : { ok: false, size: '', hash: '' }
  const oldImageGone = !(await fetch(fileUrl(image.file))).ok
  const oldComicGone = !(await fetch(fileUrl(comic.pages![0].file))).ok

  let lossless = false
  if (imageAfterItem) {
    const bytes = await (await fetch(fileUrl(imageAfterItem.file))).arrayBuffer()
    const view = new DataView(bytes)
    let offset = 12
    while (offset + 8 <= bytes.byteLength) {
      const type = String.fromCharCode(
        ...new Uint8Array(bytes, offset, 4)
      )
      if (type === 'VP8L') {
        lossless = true
        break
      }
      const length = view.getUint32(offset + 4, true)
      const next = offset + 8 + length + (length & 1)
      if (next <= offset || next > bytes.byteLength) break
      offset = next
    }
  }

  // The same selection must now be a no-op.
  const seqSecond = lastConversion().seq
  useStore.getState().select(ids, 'replace')
  await wait(250)
  document.querySelector<HTMLButtonElement>('[data-action="bulk-convert"]')?.click()
  const secondRun = await waitFor(
    () => (lastConversion().seq > seqSecond ? lastConversion() : null),
    30000
  )

  const imageSame =
    imageBefore.ok &&
    imageAfter.ok &&
    imageBefore.hash === imageAfter.hash &&
    imageBefore.size === imageAfter.size
  const comicSame =
    comicBefore.ok &&
    comicAfterSignature.ok &&
    comicBefore.hash === comicAfterSignature.hash &&
    comicBefore.size === comicAfterSignature.size

  return {
    ok: true,
    first: firstRun.summary,
    second: secondRun?.summary ?? null,
    dockText,
    image: imageAfterItem
      ? {
          id: image.id,
          file: imageAfterItem.file,
          flag: !!imageAfterItem.convertedToWebp,
          before: imageBefore,
          after: imageAfter,
          same: imageSame
        }
      : null,
    comic: comicAfter
      ? {
          id: comic.id,
          file: comicAfter.file,
          flag: !!comicAfter.convertedToWebp,
          allPages:
            !!comicAfter.pages?.length &&
            comicAfter.pages.every(
              (page) => !!page.convertedToWebp && page.file.toLowerCase().endsWith('.webp')
            ),
          pages: (comicAfter.pages ?? []).map((page) => ({
            file: page.file,
            flag: !!page.convertedToWebp
          })),
          before: comicBefore,
          after: comicAfterSignature,
          same: comicSame
        }
      : null,
    gif: gifAfter
      ? { id: gif?.id, file: gifAfter.file, flag: !!gifAfter.convertedToWebp }
      : null,
    oldFilesGone: oldImageGone && oldComicGone,
    lossless
  }
}

export function installSmokeHooks(): void {
  if (!window.vault?.smoke) return

  const hooks = {
    importPaths: async (paths: string[]) => {
      const result = await runImport(paths)
      return result
        ? {
            added: result.added.length,
            restored: result.restored.length,
            skipped: result.skipped,
            failed: result.failed.length,
            addedIds: result.added.map((item) => item.id),
            restoredIds: result.restored.map((item) => item.id)
          }
        : null
    },
    settle: (ms = 300) => wait(ms),
    go: (view: ViewId) => {
      useStore.getState().setView(view)
    },
    itemByTitle: (title: string) => {
      const lib = useStore.getState().lib
      const item = Object.values(lib?.items ?? {}).find((i) => i.title === title)
      return item ? { id: item.id, file: item.file, inbox: !!item.inbox } : null
    },
    setInbox: async (id: string, inbox: boolean) => {
      await useStore.getState().setMembership([id], { inbox })
      const item = useStore.getState().lib?.items[id]
      return { id, inbox: !!item?.inbox }
    },
    selectFirst: (count = 1) => {
      const ids = inboxIds().slice(0, Math.max(0, count))
      useStore.getState().setView('inbox')
      useStore.getState().select(ids, 'replace')
      return ids.length
    },
    clearSelection: () => {
      useStore.getState().clearSelection()
    },
    demoTagging,
    openFirstComic: () => {
      const id = findItem((item) => item.kind === 'comic')
      if (!id) return false
      useStore.getState().setView('library')
      useStore.getState().setDetail(id)
      return true
    },
    openFirstImage: () => {
      const id = findItem((item) => item.kind === 'image')
      if (!id) return false
      useStore.getState().setView('library')
      useStore.getState().setDetail(id)
      return true
    },
    openFirstGif: () => {
      const id = findItem((item) => item.kind === 'gif')
      if (!id) return false
      useStore.getState().setView('library')
      useStore.getState().setDetail(id)
      return true
    },
    viewerInfo: () => {
      const store = useStore.getState()
      const lib = store.lib
      if (!store.viewerId || !lib) return null
      const item = lib.items[store.viewerId]
      const queue = store.viewOrder
        .map((id) => lib.items[id])
        .filter((candidate) => !!candidate && (candidate.kind === 'image' || candidate.kind === 'gif'))
      return {
        id: store.viewerId,
        file: item?.file ?? '',
        index: queue.findIndex((candidate) => candidate.id === store.viewerId),
        queue: queue.map((candidate) => candidate.id),
        counter: document.querySelector('.viewer-bar .mono')?.textContent?.trim() ?? ''
      }
    },
    openComicReader: () => {
      const id = findItem((item) => item.kind === 'comic')
      if (!id) return false
      useStore.getState().setView('library')
      useStore.getState().setDetail(id)
      useStore.getState().setReader(id)
      return true
    },
    openCoverPicker: () => {
      const id = findItem((item) => item.kind === 'comic')
      if (!id) return false
      useStore.getState().setView('library')
      useStore.getState().setDetail(id)
      useStore.getState().setCoverTool(id)
      return true
    },
    makeDemoVideos,
    openFirstVideoTool: () => {
      const id = findItem((item) => item.kind === 'video')
      if (!id) return false
      useStore.getState().setView('library')
      useStore.getState().setDetail(id)
      useStore.getState().setVideoTool(id)
      return true
    },
    videoLoopState: () => {
      const detail = document.querySelector<HTMLVideoElement>('.detail-preview video')
      const picker = document.querySelector<HTMLVideoElement>('.frame-stage video')
      return { detail: videoState(detail), picker: videoState(picker) }
    },
    /**
     * Hover an inbox video and watch the hand-off between the two preview
     * buffers. A 2.4s demo clip should complete a full pass and continue on the
     * standby buffer without a seek/ended gap.
     */
    hoverVideoLoop: async () => {
      const store = useStore.getState()
      store.setView('inbox')
      await wait(500)
      const target = findItem((item) => item.kind === 'video' && !!item.inbox)
      if (!target) return { ok: false, stage: 'id' as const }
      useStore.getState().placeInboxBatch([target])
      await wait(700)
      let tile = document.querySelector<HTMLElement>(`.tile[data-id="${target}"]`)
      if (!tile) {
        document.querySelector<HTMLButtonElement>('button[title="Fit to view"]')?.click()
        await wait(700)
        tile = document.querySelector<HTMLElement>(`.tile[data-id="${target}"]`)
      }
      const media = tile?.querySelector<HTMLElement>('.tile-media')
      if (!tile || !media) return { ok: false, stage: 'tile' as const }

      media.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
      const before = await waitFor(() => {
        const buffers = [...tile!.querySelectorAll<HTMLVideoElement>('video[data-smooth-loop]')]
        return buffers.length === 2 ? buffers.map(loopBufferState) : null
      })
      if (!before) {
        media.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
        return { ok: false, stage: 'buffers' as const }
      }
      const initial = before.slice().sort((a, b) => b.opacity - a.opacity)[0]
      const handoff = await waitFor(() => {
        const buffers = [...tile!.querySelectorAll<HTMLVideoElement>('video[data-smooth-loop]')]
        if (buffers.length !== 2) return null
        const active = buffers.map(loopBufferState).sort((a, b) => b.opacity - a.opacity)[0]
        return active && active.label !== initial.label ? active : null
      }, 8000)
      await wait(180)
      const after = [...tile.querySelectorAll<HTMLVideoElement>('video[data-smooth-loop]')].map(
        loopBufferState
      )
      const activeAfter =
        after.length === 2 ? after.slice().sort((a, b) => b.opacity - a.opacity)[0] : null
      return {
        ok: !!handoff && !!activeAfter,
        buffers: before.length,
        before,
        after,
        activeBefore: initial.label,
        activeAfter: activeAfter?.label ?? null,
        handoff: !!handoff,
        stillPlaying:
          !!activeAfter &&
          !activeAfter.paused &&
          !activeAfter.ended &&
          activeAfter.currentTime < activeAfter.duration
      }
    },
    /**
     * Open a video's thumbnail picker and drive the hidden upload input with a
     * generated PNG. The saved thumbnail must be re-encoded to WebP and the
     * poster-frame time must be cleared.
     */
    uiVideoThumbUpload: async () => {
      const id = findItem((item) => item.kind === 'video')
      if (!id) return { ok: false, stage: 'target' as const }
      const store = useStore.getState()
      store.setView('library')
      store.setDetail(id)
      store.setVideoTool(id)
      await wait(500)
      const input = document.querySelector<HTMLInputElement>(
        '[data-action="video-thumb-upload-input"]'
      )
      const button = document.querySelector<HTMLButtonElement>('[data-action="video-thumb-upload"]')
      if (!input || !button) return { ok: false, stage: 'input' as const }
      const buttonLabel = button.textContent?.trim() ?? ''
      const canvas = document.createElement('canvas')
      canvas.width = 96
      canvas.height = 64
      const ctx = canvas.getContext('2d')
      if (!ctx) return { ok: false, stage: 'canvas' as const }
      ctx.fillStyle = '#e040b0'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#101018'
      ctx.fillRect(12, 12, 30, 40)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((value) => resolve(value), 'image/png')
      )
      if (!blob) return { ok: false, stage: 'blob' as const }
      const file = new File([blob], 'custom-thumb.png', { type: 'image/png' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      const updated = await waitFor(() => {
        const item = useStore.getState().lib?.items[id]
        return item?.thumbCustom ? item : null
      })
      let isWebp = false
      if (updated) {
        const response = await fetch(thumbUrl(updated))
        const bytes = new Uint8Array(await response.arrayBuffer())
        isWebp =
          String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
          String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
      }
      return {
        ok: !!updated && isWebp && updated.thumbTimeMs === undefined,
        stage: 'done' as const,
        id,
        thumbCustom: !!updated?.thumbCustom,
        thumbTimeMs: updated?.thumbTimeMs,
        thumbVersion: updated?.thumbVersion,
        isWebp,
        buttonLabel
      }
    },
    closeOverlays: () => {
      const store = useStore.getState()
      store.setReader(null)
      store.setViewer(null)
      store.setCompareGroup(null)
      store.setVideoTool(null)
      store.setCoverTool(null)
      store.setDetail(null)
      store.setTagManagerOpen(false)
      store.closeConfirm()
    },
    /** The library bulk bar must appear even for a single selected item. */
    uiBulkBarOne: async () => {
      const lib = useStore.getState().lib
      if (!lib) return null
      const target = Object.values(lib.items).find(
        (item) => item.kind === 'image' || item.kind === 'gif'
      )
      if (!target) return { ok: false, stage: 'target' as const }
      useStore.getState().setView('library')
      useStore.getState().setTypeFilter('all')
      useStore.getState().clearSelection()
      await wait(350)
      useStore.getState().select([target.id], 'replace')
      await wait(350)
      const bar = document.querySelector<HTMLElement>('.bulk-bar')
      const text = (bar?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const result = {
        ok: !!bar && text.includes('1 selected'),
        present: !!bar,
        text,
        selected: useStore.getState().selected.size
      }
      useStore.getState().clearSelection()
      return result
    },
    /** Thumbnail click previews; the card body click selects. */
    uiCardZones: async () => {
      useStore.getState().setView('library')
      useStore.getState().setTypeFilter('all')
      useStore.getState().clearSelection()
      useStore.getState().setDetail(null)
      await wait(500)
      const card = document.querySelector<HTMLElement>('.library .card')
      const id = card?.dataset.id ?? null
      const thumb = card?.querySelector<HTMLElement>('.card-thumb')
      if (!card || !id || !thumb) return { ok: false, stage: 'card' as const }
      thumb.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wait(350)
      const afterThumb = {
        detail: useStore.getState().detailId,
        selected: useStore.getState().selected.size
      }
      useStore.getState().setDetail(null)
      useStore.getState().clearSelection()
      await wait(400)
      const body = document.querySelector<HTMLElement>(
        `.library .card[data-id="${id}"] .card-body`
      )
      if (!body) return { ok: false, stage: 'body' as const, afterThumb }
      body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wait(350)
      const afterBody = {
        detail: useStore.getState().detailId,
        selected: [...useStore.getState().selected]
      }
      const result = {
        ok:
          afterThumb.detail === id &&
          afterThumb.selected === 0 &&
          afterBody.detail === null &&
          afterBody.selected.length === 1 &&
          afterBody.selected[0] === id,
        id,
        afterThumb,
        afterBody
      }
      useStore.getState().clearSelection()
      return result
    },
    /** Select two images and use the real create-set button on a given surface. */
    uiCreateSet: async (surface: 'inbox' | 'library', tagSources = false) => {
      const store = useStore.getState()
      const lib = store.lib
      if (!lib) return null
      const still = (item: MediaItem): boolean => item.kind === 'image' || item.kind === 'gif'
      let pool = Object.values(lib.items).filter(
        (item) => still(item) && (surface === 'inbox' ? !!item.inbox : !item.inbox)
      )
      if (pool.length < 2) pool = Object.values(lib.items).filter(still)
      if (pool.length < 2) return { ok: false, stage: 'targets' as const, count: pool.length }
      const sources = pool.slice(0, 2)
      const ids = sources.map((item) => item.id)

      // Give each source a different tag so the set's combined tag list is
      // observable no matter what the seed data happened to carry.
      if (tagSources) {
        const names = useStore.getState().lib?.tags.map((tag) => tag.name) ?? []
        if (names.length >= 2) {
          await useStore.getState().applyTags([ids[0]], [names[0]])
          await useStore.getState().applyTags([ids[1]], [names[1]])
        } else if (names.length === 1) {
          await useStore.getState().applyTags(ids, [names[0]])
        }
        await wait(250)
      }
      const currentLib = useStore.getState().lib ?? lib
      const expectedTags = [
        ...new Set(ids.flatMap((id) => currentLib.items[id]?.tags ?? []))
      ].sort()

      const existingSets = new Set(
        Object.values(currentLib.items)
          .filter((item) => item.kind === 'set')
          .map((item) => item.id)
      )
      const action = surface === 'inbox' ? 'inbox-create-set' : 'bulk-create-set'
      useStore.getState().setView(surface)
      useStore.getState().select(ids, 'replace')
      await wait(400)
      const button = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
      if (!button) return { ok: false, stage: 'button' as const }
      if (button.disabled) return { ok: false, stage: 'disabled' as const }
      const before = Object.keys(currentLib.items).length
      button.click()
      const created = await waitFor(() => {
        const items = Object.values(useStore.getState().lib?.items ?? {})
        return items.find(
          (item) => item.kind === 'set' && !existingSets.has(item.id) && !ids.includes(item.id)
        ) ?? null
      }, 5000)
      await wait(350)
      const state = useStore.getState()
      const filterButton = document.querySelector<HTMLElement>('[data-filter="set"]')
      const filter = filterButton
        ? {
            present: true,
            active: filterButton.classList.contains('is-active'),
            text: filterButton.textContent?.trim() ?? ''
          }
        : { present: false, active: false, text: '' }
      const sourceInbox = sources.map((item) => !!item.inbox)
      const tagsOk =
        !!created &&
        created.tags.length === expectedTags.length &&
        created.tags.every((tag, index) => tag === expectedTags[index])
      if (created) useStore.getState().setTypeFilter('all')
      return {
        ok:
          !!created &&
          state.view === 'library' &&
          state.typeFilter === 'set' &&
          filter.present &&
          filter.active &&
          state.selected.has(created.id) &&
          (created.pages?.length ?? 0) >= 2 &&
          tagsOk,
        stage: 'done' as const,
        surface,
        action,
        ids,
        before,
        after: Object.keys(state.lib?.items ?? {}).length,
        view: state.view,
        typeFilter: state.typeFilter,
        filter,
        expectedTags,
        tagsOk,
        selected: [...state.selected],
        created: created
          ? {
              id: created.id,
              kind: created.kind,
              title: created.title,
              file: created.file,
              coverIndex: created.coverIndex,
              pages: created.pages?.length ?? 0,
              pageFiles: created.pages?.map((page) => page.file) ?? [],
              pageBytes: created.pages?.map((page) => page.bytes) ?? [],
              bytes: created.bytes,
              inbox: !!created.inbox,
              tags: created.tags,
              sha256: created.sha256 ?? null,
              phash: created.phash ?? null
            }
          : null,
        sources: sources.map((item) => ({ id: item.id, file: item.file, bytes: item.bytes, inbox: !!item.inbox })),
        sourceInbox
      }
    },
    /** Open an image set in the same reader used by comics and page through it. */
    uiReadSet: async (id: string) => {
      useStore.getState().setReader(id)
      await wait(900)
      const bar = document.querySelector('.reader-bar')
      const pages = document.querySelectorAll('.reader-strip button').length
      const first = bar?.querySelector('.mono')?.textContent?.trim() ?? ''
      const title = bar?.querySelector('.title')?.textContent ?? ''
      document.querySelectorAll<HTMLElement>('.reader-strip button')[1]?.click()
      await wait(300)
      const second = document.querySelector('.reader-bar .mono')?.textContent?.trim() ?? ''
      return {
        ok: !!bar && pages >= 2 && first.startsWith('1 /') && second.startsWith('2 /'),
        open: !!bar,
        title,
        pages,
        first,
        second
      }
    },
    setSearch: (q: string) => {
      useStore.getState().setSearch(q)
    },
    openTagManager: () => {
      useStore.getState().setTagManagerOpen(true)
    },
    closeTagManager: () => {
      useStore.getState().setTagManagerOpen(false)
    },
    renameTag: async (name: string, next: string) => {
      const tag = useStore.getState().lib?.tags.find((t) => t.name === name)
      if (!tag) return false
      return useStore.getState().renameTag(tag.id, next)
    },
    deleteTag: async (name: string) => {
      const tag = useStore.getState().lib?.tags.find((t) => t.name === name)
      if (!tag) return false
      await useStore.getState().deleteTag(tag.id)
      return true
    },
    searchStats: (q: string) => {
      const store = useStore.getState()
      store.setSearch(q)
      const lib = store.lib
      if (!lib) return { query: q, matching: 0, include: [], exclude: [], terms: [] }
      const parsed = parseQuery(q, lib.tags.map((tag) => tag.name))
      const all = Object.values(lib.items)
      return {
        query: q,
        matching: all.filter((item) => itemMatchesQuery(item, parsed)).length,
        include: parsed.include,
        exclude: parsed.exclude,
        terms: parsed.terms
      }
    },
    uiRenameTag: async (from: string, next: string) => {
      await expandTagManagerCategories()
      const row = await waitFor(() => tagRow(from))
      const button = row?.querySelector<HTMLButtonElement>('button[title^="Rename"]')
      if (!button) return { ok: false, stage: 'row' }
      const id = row?.dataset.tagId
      button.click()
      const input = await waitFor(() => document.querySelector<HTMLInputElement>('.tag-manager-input'))
      if (!input) return { ok: false, stage: 'input' }
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, next)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
      await wait(300)
      const viaEnter = !!tagRow(next)
      if (!viaEnter) {
        const save = document.querySelector<HTMLButtonElement>(
          '.tag-manager-row.is-editing button[title="Save name"]'
        )
        save?.click()
      }
      const done = await waitFor(() => tagRow(next))
      const ok = !!done
      const connected = input.isConnected
      await collapseTagManagerCategories()
      return {
        ok,
        viaEnter,
        stage: done ? 'done' : 'commit',
        id,
        connected,
        inStore: useStore.getState().lib?.tags.some((tag) => tag.id === id) ?? false,
        editing: !!document.querySelector('.tag-manager-input'),
        value: input.value,
        toasts: [...document.querySelectorAll('.toast')].map((toast) => toast.textContent),
        rows: [...document.querySelectorAll('.tag-manager-row .name')].map((n) => n.textContent)
      }
    },
    uiDeleteTag: async (name: string) => {
      await expandTagManagerCategories()
      const row = await waitFor(() => tagRow(name))
      const button = row?.querySelector<HTMLButtonElement>('button[title^="Delete"]')
      if (!button) return { ok: false, stage: 'row' }
      button.click()
      const confirm = await waitFor(() =>
        document.querySelector<HTMLButtonElement>('.modal.narrow .modal-foot .btn-danger')
      )
      if (!confirm) return { ok: false, stage: 'confirm' }
      confirm.click()
      const gone = await waitFor(() => (tagRow(name) ? null : true))
      await collapseTagManagerCategories()
      return { ok: !!gone, stage: gone ? 'done' : 'delete' }
    },
    categoryState: () => {
      const lib = useStore.getState().lib
      return {
        categories: (lib?.categories ?? []).map((category) => ({
          id: category.id,
          name: category.name,
          parentId: category.parentId ?? null
        })),
        tags: (lib?.tags ?? []).map((tag) => ({
          name: tag.name,
          categoryId: tag.categoryId ?? null
        }))
      }
    },
    categoryDiskState: async () => {
      const lib = await window.vault.getLibrary()
      return {
        categories: lib.categories.map((category) => ({
          id: category.id,
          name: category.name,
          parentId: category.parentId ?? null
        })),
        tags: lib.tags.map((tag) => ({ name: tag.name, categoryId: tag.categoryId ?? null }))
      }
    },
    sidebarCategoryState: () => {
      const groups = [...document.querySelectorAll<HTMLElement>('.side-tag-group')]
      return groups.map((group) => ({
        name: group.querySelector('.side-tag-group-label')?.textContent?.trim() ?? '',
        depth: Number(group.dataset.depth ?? 0),
        tags: [...group.querySelectorAll('.side-tag .name')].map(
          (name) => name.textContent?.trim() ?? ''
        )
      }))
    },
    categoryTree: () => {
      const groups = [...document.querySelectorAll<HTMLElement>('.tag-manager-group')]
      return groups.map((group) => ({
        name: group.querySelector('.tag-manager-group-name')?.textContent?.trim() ?? '',
        depth: Number(group.dataset.depth ?? 0),
        parentId: group.dataset.parentId || null,
        tags: directTagRows(group).map(
          (row) => row.querySelector('.name')?.textContent?.trim() ?? ''
        )
      }))
    },
    categoryCollapseState: () => {
      return [...document.querySelectorAll<HTMLElement>('.tag-manager-group')].map((group) => ({
        name: group.querySelector('.tag-manager-group-name')?.textContent?.trim() ?? '',
        collapsed:
          group.querySelector('.tag-manager-caret')?.getAttribute('aria-expanded') === 'false',
        tags: directTagRows(group).map(
          (row) => row.querySelector('.name')?.textContent?.trim() ?? ''
        ),
        children: [...group.children].some((child) =>
          child.classList.contains('tag-manager-children')
        )
      }))
    },
    uiToggleCategoryCollapse: async (name: string) => {
      const read = (): {
        expanded: boolean
        collapsed: boolean
        tags: string[]
        children: boolean
        groups: string[]
      } => {
        const group = categoryGroup(name)
        const expanded =
          group?.querySelector('.tag-manager-caret')?.getAttribute('aria-expanded') === 'true'
        return {
          expanded,
          collapsed:
            group?.querySelector('.tag-manager-caret')?.getAttribute('aria-expanded') === 'false',
          tags: directTagRows(group).map(
            (row) => row.querySelector('.name')?.textContent?.trim() ?? ''
          ),
          children: group
            ? [...group.children].some((child) =>
                child.classList.contains('tag-manager-children')
              )
            : false,
          groups: [...document.querySelectorAll('.tag-manager-group-name')].map(
            (node) => node.textContent?.trim() ?? ''
          )
        }
      }
      const group = categoryGroup(name)
      const button = [...(group?.children ?? [])]
        .find((child) => child.classList.contains('tag-manager-group-head'))
        ?.querySelector<HTMLElement>('.tag-manager-caret')
      if (!button) return { ok: false, stage: 'button' }
      button.click()
      await wait(120)
      return { ok: true, ...read() }
    },
    sidebarCollapseState: () => {
      return [...document.querySelectorAll<HTMLElement>('.side-tag-group')].map((group) => ({
        name: group.querySelector('.side-tag-group-label')?.textContent?.trim() ?? '',
        collapsed: group.classList.contains('is-collapsed'),
        tags: [...group.querySelectorAll('.side-tag .name')].map(
          (name) => name.textContent?.trim() ?? ''
        )
      }))
    },
    uiToggleSidebarCollapse: async (name: string) => {
      const find = (): HTMLElement | null =>
        [...document.querySelectorAll<HTMLElement>('.side-tag-group')].find(
          (group) => group.querySelector('.side-tag-group-label')?.textContent?.trim() === name
        ) ?? null
      const button = find()?.querySelector<HTMLElement>('.side-tag-group-head')
      if (!button) return { ok: false, stage: 'button' }
      button.click()
      await wait(120)
      const group = find()
      return {
        ok: true,
        expanded: button.getAttribute('aria-expanded') === 'true',
        collapsed: group?.classList.contains('is-collapsed') ?? false,
        tags: group
          ? [...group.querySelectorAll('.side-tag .name')].map(
              (node) => node.textContent?.trim() ?? ''
            )
          : [],
        groups: [...document.querySelectorAll('.side-tag-group-label')].map(
          (node) => node.textContent?.trim() ?? ''
        )
      }
    },
    tagRailCollapseState: () => {
      return [...document.querySelectorAll<HTMLElement>('.tagrail .tag-group')].map((group) => ({
        name: group.querySelector('.tag-group-label')?.textContent?.trim() ?? '',
        collapsed: group.classList.contains('is-collapsed'),
        tags: [...group.querySelectorAll('.tag-row .name')].map(
          (name) => name.textContent?.trim() ?? ''
        )
      }))
    },
    uiToggleTagRailCollapse: async (name: string) => {
      const find = (): HTMLElement | null =>
        [...document.querySelectorAll<HTMLElement>('.tagrail .tag-group')].find(
          (group) => group.querySelector('.tag-group-label')?.textContent?.trim() === name
        ) ?? null
      const button = find()?.querySelector<HTMLElement>('.tag-group-head')
      if (!button) return { ok: false, stage: 'button' }
      button.click()
      await wait(120)
      const group = find()
      return {
        ok: true,
        expanded: button.getAttribute('aria-expanded') === 'true',
        collapsed: group?.classList.contains('is-collapsed') ?? false,
        tags: group
          ? [...group.querySelectorAll('.tag-row .name')].map(
              (node) => node.textContent?.trim() ?? ''
            )
          : [],
        groups: [...document.querySelectorAll('.tagrail .tag-group-label')].map(
          (node) => node.textContent?.trim() ?? ''
        )
      }
    },
    uiFilterTagInput: async (surface: 'sidebar' | 'manager' | 'rail', value: string) => {
      const selector =
        surface === 'sidebar'
          ? '.sidebar-search input'
          : surface === 'manager'
            ? '.tag-manager-filter input'
            : '.tagrail-search input'
      const input = document.querySelector<HTMLInputElement>(selector)
      if (!input) return { ok: false, stage: 'input' }
      setInputValue(input, value)
      await wait(180)
      return { ok: true }
    },
    uiCreateCategory: async (name: string, parentName?: string) => {
      const form = document.querySelector<HTMLFormElement>('.tag-manager-new-category')
      const input = form?.querySelector<HTMLInputElement>('input')
      if (!form || !input) return { ok: false, stage: 'form' }
      if (parentName) {
        const parent = useStore.getState().lib?.categories.find((c) => c.name === parentName)
        const select = form.querySelector<HTMLSelectElement>('.tag-manager-create-parent')
        if (!parent || !select) return { ok: false, stage: 'parent' }
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
        setter?.call(select, parent.id)
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await wait(80)
      }
      setInputValue(input, name)
      await wait(80)
      form.requestSubmit()
      const created = await waitFor(
        () => useStore.getState().lib?.categories.find((c) => c.name === name) ?? null
      )
      if (!created) return { ok: false, stage: 'create' }
      // A nested category is only mounted once its ancestors are expanded.
      await expandTagManagerCategories()
      const group = await waitFor(() => categoryGroup(name))
      return { ok: !!group, stage: group ? 'done' : 'create' }
    },
    uiMoveCategory: async (name: string, parentName: string | null) => {
      await expandTagManagerCategories()
      const group = await waitFor(() => categoryGroup(name))
      const select = group?.querySelector<HTMLSelectElement>('.tag-manager-cat-parent')
      if (!group || !select) return { ok: false, stage: 'select' }
      const lib = useStore.getState().lib
      const parent = parentName
        ? lib?.categories.find((category) => category.name === parentName)
        : null
      if (parentName && !parent) return { ok: false, stage: 'parent' }
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, parent?.id ?? '')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const after = await waitFor(() => {
        const category = useStore.getState().lib?.categories.find((c) => c.name === name)
        return category && (category.parentId ?? null) === (parent?.id ?? null) ? category : null
      })
      const parentId = after?.parentId ?? null
      await collapseTagManagerCategories()
      return {
        ok: !!after,
        parentId,
        stage: after ? 'done' : 'move'
      }
    },
    categoryCycleCheck: async (parentName: string, childName: string) => {
      const lib = useStore.getState().lib
      const parent = lib?.categories.find((category) => category.name === parentName)
      const child = lib?.categories.find((category) => category.name === childName)
      if (!parent || !child) return { ok: false, stage: 'category' }
      const before = parent.parentId ?? null
      const result = await window.vault.setCategoryParent(parent.id, child.id)
      const fresh = await window.vault.getLibrary()
      useStore.setState({ lib: fresh })
      const after = fresh.categories.find((category) => category.id === parent.id)?.parentId ?? null
      return { ok: result === null && after === before, rejected: result === null, before, after }
    },
    uiAssignCategory: async (tagName: string, categoryName: string) => {
      await expandTagManagerCategories()
      const row = await waitFor(() => tagRow(tagName))
      const select = row?.querySelector<HTMLSelectElement>('.tag-manager-category')
      if (!row || !select) return { ok: false, stage: 'select' }
      const lib = useStore.getState().lib
      const category = lib?.categories.find((c) => c.name === categoryName)
      if (!category) return { ok: false, stage: 'category' }
      const tagId = row.dataset.tagId
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, category.id)
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(300)
      const group = await waitFor(() => categoryGroup(categoryName))
      const inGroup = directTagRows(group).some((candidate) => candidate.dataset.tagId === tagId)
      const value = select.value
      await collapseTagManagerCategories()
      return { ok: inGroup, inGroup, value }
    },
    uiRenameCategory: async (from: string, next: string) => {
      await expandTagManagerCategories()
      const group = await waitFor(() => categoryGroup(from))
      const button = group?.querySelector<HTMLButtonElement>('button[title^="Rename category"]')
      if (!button) return { ok: false, stage: 'group' }
      button.click()
      const input = await waitFor(() =>
        document.querySelector<HTMLInputElement>('.tag-manager-cat-input')
      )
      if (!input) return { ok: false, stage: 'input' }
      setInputValue(input, next)
      await wait(120)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
      const renamed = await waitFor(() => categoryGroup(next))
      const ok = !!renamed
      await collapseTagManagerCategories()
      return { ok, stage: ok ? 'done' : 'rename' }
    },
    uiDeleteCategory: async (name: string) => {
      await expandTagManagerCategories()
      const group = await waitFor(() => categoryGroup(name))
      const button = group?.querySelector<HTMLButtonElement>('button[title^="Delete category"]')
      if (!button) return { ok: false, stage: 'group' }
      button.click()
      const confirm = await waitFor(() =>
        document.querySelector<HTMLButtonElement>('.modal.narrow .modal-foot .btn-danger')
      )
      if (!confirm) return { ok: false, stage: 'confirm' }
      confirm.click()
      const gone = await waitFor(() => (categoryGroup(name) ? null : true))
      const ok = !!gone
      await collapseTagManagerCategories()
      return { ok, stage: ok ? 'done' : 'delete' }
    },
    uiPickSearchTag: (name: string, exclude = false) => {
      const rows = [...document.querySelectorAll<HTMLElement>('.search-pop-row')]
      const row = rows.find((r) => r.querySelector('.name')?.textContent?.trim() === name)
      const button = row?.querySelector<HTMLButtonElement>(exclude ? '.flag.exc' : '.flag:not(.exc)')
      if (!button) return null
      button.click()
      return useStore.getState().search
    },
    membership: () => membershipCounts(),
    batchSeparation,
    /**
     * Items that already have a manual canvas position must still be revealed
     * when they are re-sent to the inbox, otherwise they land off screen with
     * no indication of where they went.
     */
    batchReveal: () => {
      const store = useStore.getState()
      const lib = store.lib
      if (!lib) return null
      const target = Object.values(lib.items).find(
        (item) => item.inbox && !!store.manual[item.id]
      )
      if (!target) return { ok: false, reason: 'no manual item' as const }
      const before = store.lastBatch
      store.placeInboxBatch([target.id])
      const after = useStore.getState().lastBatch
      return {
        ok: !!after && after !== before && after.ids.includes(target.id),
        id: target.id,
        hadManual: true,
        ids: after?.ids.length ?? 0
      }
    },
    dupeInfo: () => dupeInfo(),
    uiDupeControls: () => ({
      keepOne: document.querySelectorAll('[data-action="dupe-keep-best"]').length,
      keepAll: document.querySelectorAll('[data-action="dupe-keep-all"]').length,
      bulkBar: document.querySelectorAll('.bulk-bar').length,
      resolve: document.querySelectorAll('[data-action="dupe-resolve"]').length,
      resolveDisabled: document.querySelectorAll('[data-action="dupe-resolve"]:disabled').length,
      cards: document.querySelectorAll('.dupe-card').length
    }),
    uiDupeHighlight: async () => {
      const group = document.querySelector<HTMLElement>('.dupe-group')
      if (!group) return null
      const cards = [...group.querySelectorAll<HTMLElement>('.dupe-card')]
      if (cards.length < 2) return { ok: false, total: cards.length }
      const keep = cards.find((c) => c.classList.contains('is-keep'))
      if (!keep) return { ok: false, reason: 'no keep card', total: cards.length }
      const before = group.querySelectorAll('.dupe-card.is-keep').length
      const id = keep.dataset.id
      keep.click()
      await wait(240)
      const dropCard = [...group.querySelectorAll<HTMLElement>('.dupe-card.is-drop')].find(
        (c) => c.dataset.id === id
      )
      const ringOf = (card: HTMLElement | null | undefined): string => {
        const thumb = card?.querySelector<HTMLElement>('.dupe-thumb')
        return thumb ? getComputedStyle(thumb, '::after').boxShadow : ''
      }
      return {
        ok: !!dropCard && group.querySelectorAll('.dupe-card.is-keep').length === before - 1,
        toggledToDrop: !!dropCard,
        keepRing: ringOf(group.querySelector<HTMLElement>('.dupe-card.is-keep')),
        dropRing: ringOf(dropCard),
        ...dupeInfo()
      }
    },
    uiDupeResolve: async () => {
      const before = dupeInfo()
      const button = document.querySelector<HTMLButtonElement>('[data-action="dupe-resolve"]')
      if (!button || button.disabled) return { ok: false, stage: 'button', ...before }
      button.click()
      await wait(260)
      const dialog = document.querySelector('.modal.narrow')
      const title = dialog?.querySelector('h2')?.textContent ?? ''
      const cancel = dialog?.querySelector<HTMLButtonElement>('.modal-foot .btn-ghost')
      cancel?.click()
      await wait(240)
      const after = dupeInfo()
      return {
        ok:
          !!dialog &&
          !!cancel &&
          !document.querySelector('.modal.narrow') &&
          after.groups === before.groups,
        dialog: !!dialog,
        title,
        cancelled: !document.querySelector('.modal.narrow'),
        ...after
      }
    },
    /** Tag two inbox items, then use the inbox dock's Clear tags button. */
    clearTagsCheck: async () => {
      const store = useStore.getState()
      const lib = store.lib
      if (!lib) return null
      const ids = Object.values(lib.items)
        .filter((item) => item.inbox)
        .slice(0, 2)
        .map((item) => item.id)
      if (ids.length < 2) return null
      await store.applyTags(ids, ['bulk-clear'])
      const before = ids.map((id) => useStore.getState().lib?.items[id]?.tags.length ?? 0)
      useStore.getState().setView('inbox')
      useStore.getState().select(ids, 'replace')
      await wait(260)
      const button = document.querySelector<HTMLButtonElement>('[data-action="inbox-clear-tags"]')
      if (!button) return { ok: false, before, after: before }
      button.click()
      const after = await waitFor(() => {
        const now = ids.map((id) => useStore.getState().lib?.items[id]?.tags.length ?? 0)
        return now.every((n) => n === 0) ? now : null
      })
      useStore.getState().clearSelection()
      return {
        ok: !!after,
        before,
        after: after ?? ids.map((id) => useStore.getState().lib?.items[id]?.tags.length ?? 0)
      }
    },
    /** Pick an inbox image whose original file the smoke run can temporarily hide. */
    missingPreviewItem: () => {
      const lib = useStore.getState().lib
      if (!lib) return null
      const images = Object.values(lib.items).filter(
        (item) => item.kind === 'image' && item.inbox && !item.linked
      )
      const item = images[images.length - 1]
      return item ? { id: item.id, file: item.file } : null
    },
    /** Send one library image back to the inbox, like the bulk action does. */
    sendImageToInbox: async () => {
      const lib = useStore.getState().lib
      if (!lib) return null
      const item = Object.values(lib.items).find((i) => i.kind === 'image' && i.inbox)
      if (!item) return null
      await useStore.getState().setMembership([item.id], { inbox: false })
      await useStore.getState().setMembership([item.id], { inbox: true })
      return item.id
    },
    /**
     * Open an inbox tile the way a user does and report whether the detail
     * preview actually decoded the image. Used to catch items that render in
     * the grid but fail to load in the panel.
     */
    openInboxTile: async (id?: string) => {
      const store = useStore.getState()
      store.setView('inbox')
      await wait(260)
      const target = id ?? inboxIds()[0]
      if (!target) return { ok: false, stage: 'id' as const }
      const el = document.querySelector<HTMLElement>(`.tile[data-id="${target}"]`)
      if (!el) return { ok: false, stage: 'tile' as const, id: target }
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      await wait(650)
      return { ...previewState(), stage: 'done' as const, id: target }
    },
    tileRect: (id: string) => {
      const el = document.querySelector<HTMLElement>(`.tile[data-id="${id}"]`)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height)
      }
    },
    previewState: () => previewState(),
    tagFirstInbox: async () => {
      const id = inboxIds()[0]
      if (!id) return null
      const before = useStore.getState().lib?.items[id]
      const beforeInbox = before?.inbox ?? false
      await useStore.getState().applyTags([id], ['smoke-tag'])
      const after = useStore.getState().lib?.items[id]
      return {
        id,
        beforeInbox,
        afterInbox: after?.inbox ?? false,
        tags: after?.tags ?? []
      }
    },
    sendFirstToAI: async (count = 1) => {
      const ids = inboxIds().slice(0, Math.max(0, count))
      await useStore.getState().setMembership(ids, { aiQueue: true })
      return { sent: ids.length, ...membershipCounts() }
    },
    removeFromAI: async (count = 1) => {
      const ids = aiQueueIds().slice(0, Math.max(0, count))
      await useStore.getState().setMembership(ids, { aiQueue: false })
      return { removed: ids.length, ...membershipCounts() }
    },
    uiSendToAI: async (count = 1) => {
      const ids = inboxIds().slice(0, Math.max(0, count))
      const store = useStore.getState()
      store.setView('inbox')
      store.select(ids, 'replace')
      await wait(150)
      const before = membershipCounts()
      const button = document.querySelector<HTMLButtonElement>('[data-action="inbox-ai"]')
      if (!button) return { ok: false, ...before }
      button.click()
      const after = await waitFor(() => {
        const now = membershipCounts()
        return now.aiQueue > before.aiQueue ? now : null
      })
      return { ok: !!after, ...membershipCounts() }
    },
    uiRemoveFromInbox: async (count = 1) => {
      const ids = inboxIds().slice(0, Math.max(0, count))
      const store = useStore.getState()
      store.setView('inbox')
      store.select(ids, 'replace')
      await wait(150)
      const before = membershipCounts()
      const button = document.querySelector<HTMLButtonElement>('[data-action="inbox-remove"]')
      if (!button) return { ok: false, ...before }
      button.click()
      const after = await waitFor(() => {
        const now = membershipCounts()
        return now.inbox < before.inbox ? now : null
      })
      return { ok: !!after, ...membershipCounts() }
    },
    uiRemoveFromAI: async () => {
      const before = membershipCounts()
      const button = document.querySelector<HTMLButtonElement>('[data-action="ai-remove"]')
      if (!button) return { ok: false, ...before }
      button.click()
      const after = await waitFor(() => {
        const now = membershipCounts()
        return now.aiQueue < before.aiQueue ? now : null
      })
      return { ok: !!after, ...membershipCounts() }
    },
    uiRemoveAllFromAI: async () => {
      const before = membershipCounts()
      const button = document.querySelector<HTMLButtonElement>('[data-action="ai-remove-all"]')
      if (!button) return { ok: false, stage: 'button', ...before }
      button.click()
      const confirm = await waitFor(() =>
        document.querySelector<HTMLButtonElement>('.modal.narrow .modal-foot .btn-primary')
      )
      if (!confirm) return { ok: false, stage: 'confirm', ...before }
      confirm.click()
      const after = await waitFor(() => {
        const now = membershipCounts()
        return now.aiQueue === 0 ? now : null
      })
      return {
        ok: !!after,
        stage: after ? 'done' : 'remove',
        removed: before.aiQueue - membershipCounts().aiQueue,
        ...membershipCounts()
      }
    },
    uiBulkToAI: async (count = 2) => {
      const lib = useStore.getState().lib
      const ids = lib
        ? Object.values(lib.items)
            .filter((item) => !item.aiQueue)
            .slice(0, Math.max(2, count))
            .map((item) => item.id)
        : []
      const store = useStore.getState()
      store.setView('library')
      store.select(ids, 'replace')
      await wait(180)
      const before = membershipCounts()
      const button = document.querySelector<HTMLButtonElement>('[data-action="bulk-ai"]')
      if (!button) return { ok: false, ...before }
      button.click()
      const after = await waitFor(() => {
        const now = membershipCounts()
        return now.aiQueue > before.aiQueue ? now : null
      })
      return { ok: !!after, ...membershipCounts() }
    },
    uiBulkToInbox: async (count = 2) => {
      const lib = useStore.getState().lib
      const ids = lib
        ? Object.values(lib.items)
            .filter((item) => !item.inbox)
            .slice(0, Math.max(2, count))
            .map((item) => item.id)
        : []
      const store = useStore.getState()
      store.setView('library')
      store.select(ids, 'replace')
      await wait(180)
      const before = membershipCounts()
      const button = document.querySelector<HTMLButtonElement>('[data-action="bulk-inbox"]')
      if (!button) return { ok: false, ids, ...before }
      button.click()
      const after = await waitFor(() => {
        const now = membershipCounts()
        return now.inbox > before.inbox ? now : null
      })
      return { ok: !!after, ids, ...membershipCounts() }
    },
    runAI,
    sendUntaggedToAI,
    aiEvaluate: (maxItems?: number) => window.vault.aiEvaluate(maxItems),
    aiRejectFeedback,
    uiAiEvaluate: async () => {
      useStore.getState().setView('settings')
      await wait(400)
      const button = [...document.querySelectorAll<HTMLButtonElement>('.settings-inner button')].find(
        (candidate) => candidate.textContent?.includes('Check local accuracy')
      )
      if (!button) return { ok: false, stage: 'button' }
      button.click()
      const panel = await waitFor(() => document.querySelector('.ai-eval'), 4000)
      if (!panel) return { ok: false, stage: 'panel' }
      return {
        ok: true,
        stats: [...panel.querySelectorAll('.stat .v')].map((node) => node.textContent),
        suggested: panel.textContent?.match(/Use (\d+)% confidence/)?.[1] ?? null
      }
    },
    conversionCheck,
    state: () => {
      const store = useStore.getState()
      const items = store.lib ? Object.values(store.lib.items) : []
      return {
        view: store.view,
        items: items.length,
        inbox: items.filter((item) => item.inbox).length,
        aiQueue: items.filter((item) => item.aiQueue).length,
        tagged: items.filter((item) => item.tags.length > 0).length,
        untagged: items.filter((item) => item.tags.length === 0).length,
        aiPending: items.filter((item) => item.ai?.length).length,
        comics: items.filter((item) => item.kind === 'comic').length,
        videos: items.filter((item) => item.kind === 'video').length,
        tags: store.lib?.tags.length ?? 0,
        categories: store.lib?.categories.length ?? 0,
        dupes: store.dupes?.length ?? 0,
        selected: store.selected.size,
        reader: !!store.readerId,
        viewer: !!store.viewerId,
        compare: !!store.compareGroup,
        search: store.search
      }
    }
  }

  window.__vault = hooks
}
