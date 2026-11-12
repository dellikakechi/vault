import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  AiEvaluation,
  AiSettings,
  AiSuggestion,
  AiTagMetric,
  AiTestResult,
  MediaItem
} from '../shared/types'
import { hamming, normalizeTagName, type Library } from './library'

function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

function aspectDistance(a: MediaItem, b: MediaItem): number {
  const arA = a.width && a.height ? a.width / a.height : 1
  const arB = b.width && b.height ? b.width / b.height : 1
  return Math.min(1, Math.abs(Math.log(arA / arB)) / 1.1)
}

function colorSimilarity(a: MediaItem, b: MediaItem): number {
  if (!a.color || !b.color) return 0.5
  const dr = a.color[0] - b.color[0]
  const dg = a.color[1] - b.color[1]
  const db = a.color[2] - b.color[2]
  return 1 - Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / 441.67)
}

function similarity(target: MediaItem, candidate: MediaItem): number {
  const phash = target.phash && candidate.phash ? 1 - hamming(target.phash, candidate.phash) / 64 : 0.35
  const hist = target.hist && candidate.hist ? cosine(target.hist, candidate.hist) : 0.3
  const color = colorSimilarity(target, candidate)
  const paged = (kind: string): boolean => kind === 'comic' || kind === 'set'
  const kind = target.kind === candidate.kind ? 1 : paged(target.kind) || paged(candidate.kind) ? 0.3 : 0.15
  const aspect = 1 - aspectDistance(target, candidate)
  return 0.4 * phash + 0.3 * hist + 0.1 * color + 0.12 * kind + 0.08 * aspect
}

function titleMatches(item: MediaItem, tag: string): boolean {
  const title = item.title.toLowerCase()
  const words = tag.split(/[\s/_-]+/).filter((w) => w.length > 2)
  if (!words.length) return false
  return words.every((w) => title.includes(w))
}

function categoryLabel(categories: { id: string; name: string; parentId?: string }[], id: string): string | undefined {
  const byId = new Map(categories.map((category) => [category.id, category] as const))
  const parts: string[] = []
  const seen = new Set<string>()
  let current = byId.get(id)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    parts.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return parts.length ? parts.join(' / ') : undefined
}

function meanTop(values: number[], n: number): number {
  if (!values.length) return 0
  const take = values.slice(0, Math.min(n, values.length))
  return take.reduce((sum, value) => sum + value, 0) / take.length
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function nearestTagged(lib: Library, target: MediaItem, limit = 8): { item: MediaItem; sim: number }[] {
  const tagged = lib.items().filter((i) => i.id !== target.id && i.tags.length > 0)
  return tagged
    .map((item) => ({ item, sim: similarity(target, item) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
}

/**
 * Offline tagger. Each tag is judged on its own evidence: how close its best
 * positive examples are, how much closer they are than the nearest examples
 * that do *not* have the tag, and how many positives agree. This is more
 * precise than letting every nearby item vote for all of its tags.
 *
 * Tags rejected by the user for this item are remembered as negatives and are
 * never suggested again unless the user applies them manually.
 */
export function localSuggestions(lib: Library, target: MediaItem, settings: AiSettings): AiSuggestion[] {
  const maxTags = Math.max(1, settings.maxTags || 5)
  const rejected = new Set(target.rejectedTags ?? [])
  const tagged = lib.items().filter((i) => i.id !== target.id && i.tags.length > 0)

  const neighbours = tagged
    .map((item) => ({ item, sim: similarity(target, item) }))
    .sort((a, b) => b.sim - a.sim)

  const positivesByTag = new Map<string, number[]>()
  const supportByTag = new Map<string, number>()
  for (const { item, sim } of neighbours) {
    for (const tag of item.tags) {
      supportByTag.set(tag, (supportByTag.get(tag) ?? 0) + 1)
      const list = positivesByTag.get(tag)
      if (!list) positivesByTag.set(tag, [sim])
      else if (list.length < 8) list.push(sim)
    }
  }

  // Include vocabulary tags with no examples yet so a filename/title match can
  // still surface a new tag that has not been used elsewhere.
  const candidates = new Set<string>([
    ...positivesByTag.keys(),
    ...lib.data.tags.map((tag) => tag.name)
  ])

  const suggestions: AiSuggestion[] = []
  for (const tag of candidates) {
    if (target.tags.includes(tag) || rejected.has(tag)) continue
    const positives = positivesByTag.get(tag) ?? []
    const titleHit = titleMatches(target, tag)
    let score = 0

    if (positives.length) {
      // The nearest tagged items that do not have this tag are the background
      // distribution. A tag is only convincing when it beats that background.
      const negatives: number[] = []
      for (const neighbour of neighbours) {
        if (neighbour.item.tags.includes(tag)) continue
        negatives.push(neighbour.sim)
        if (negatives.length >= 5) break
      }
      const posTop = meanTop(positives, 3)
      const posBest = positives[0] ?? 0
      const negTop = meanTop(negatives, 5)
      const negBest = negatives[0] ?? 0
      const margin = posTop - negTop
      const coverage = positives.filter((sim) => sim >= Math.max(0.58, negTop + 0.04)).length
      const support = supportByTag.get(tag) ?? positives.length

      score =
        0.4 * posTop +
        0.12 * posBest +
        0.36 * clamp01(margin / 0.15) +
        0.12 * clamp01(coverage / 3)
      score += Math.min(0.03, Math.log1p(support) * 0.008)

      // If positives are no closer than the background, do not let a weak
      // signal cross the suggestion threshold.
      if (margin < 0.02) score = Math.min(score, 0.58)
      // A single lucky neighbour is not enough evidence on its own: require
      // either a clear margin or several positives agreeing above background.
      if (margin < 0.06 && coverage < 2) score = Math.min(score, 0.56)
      if (negBest > posBest) score *= 0.92
    }

    if (titleHit) score = Math.max(score, 0.94)
    if (score <= 0) continue
    suggestions.push({ tag, score: Math.min(0.99, score), source: 'local' })
  }

  return suggestions
    .filter((s) => s.score >= settings.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTags)
}

function stripFences(text: string): string {
  return text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
}

function parseTagPayload(text: string): { tag: string; score?: number }[] {
  const raw = stripFences(text)
  const attempt = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  let parsed = attempt(raw)
  if (!parsed) {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) parsed = attempt(raw.slice(start, end + 1))
  }
  if (!parsed) {
    const start = raw.indexOf('[')
    const end = raw.lastIndexOf(']')
    if (start >= 0 && end > start) parsed = attempt(raw.slice(start, end + 1))
  }
  if (!parsed || typeof parsed !== 'object') return []
  const obj = parsed as Record<string, unknown>
  const arr = Array.isArray(parsed) ? parsed : (obj.tags as unknown[]) ?? (obj.suggestions as unknown[])
  if (!Array.isArray(arr)) return []
  return arr
    .map((entry) => {
      if (typeof entry === 'string') return { tag: entry }
      if (entry && typeof entry === 'object') {
        const o = entry as Record<string, unknown>
        const tag = o.tag ?? o.name ?? o.label
        if (typeof tag !== 'string') return null
        const score = typeof o.score === 'number' ? o.score : typeof o.confidence === 'number' ? o.confidence : undefined
        return { tag, score }
      }
      return null
    })
    .filter((x): x is { tag: string; score?: number } => !!x)
}

export async function modelSuggestions(
  lib: Library,
  target: MediaItem,
  settings: AiSettings
): Promise<AiSuggestion[]> {
  const thumbPath = path.join(lib.thumbsDir, `${target.id}.webp`)
  let b64 = ''
  try {
    b64 = (await fs.readFile(thumbPath)).toString('base64')
  } catch {
    b64 = ''
  }

  const items = lib.items()
  const tagCounts = new Map<string, number>()
  for (const item of items) {
    for (const tag of item.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }
  const vocabulary = lib.data.tags
    .map((tag) => {
      const category = tag.categoryId
        ? categoryLabel(lib.data.categories, tag.categoryId)
        : undefined
      const count = tagCounts.get(tag.name) ?? 0
      return `${tag.name}${category ? ` [${category}]` : ''}${count ? ` (${count})` : ''}`
    })
    .join(', ')

  const examples = nearestTagged(lib, target, 8)
    .filter((n) => n.sim > 0.45)
    .map((n) => `- "${n.item.title}" -> ${n.item.tags.join(', ')}`)
    .join('\n')

  // Give the model the local tagger's strongest evidence as hints. It can
  // accept or reject them, but it does not have to start from a blank slate.
  const hints = localSuggestions(lib, target, {
    ...settings,
    minScore: 0.35,
    maxTags: 8
  })
  const hintText = hints
    .map((hint) => `${hint.tag} ${Math.round(hint.score * 100)}%`)
    .join(', ')
  const rejected = target.rejectedTags ?? []

  const system = [
    'You are the tagging engine of a personal media vault (images, comics, animated GIFs, videos).',
    'Assign short, lowercase, reusable tags so the owner can find items later.',
    'Prefer tags from the existing vocabulary when they genuinely fit.',
    'Use the local visual matches as hints, not commands.',
    'You may add at most two new tags if nothing existing fits. Never output more than 5 tags.',
    'Be precise: 0.9+ only when clearly visible, 0.7-0.9 when plausible, below 0.6 omit.',
    'If the image is ambiguous, return fewer tags rather than guessing.',
    'Return ONLY JSON of the form {"tags":[{"tag":"string","score":0.0}]} where score is 0..1 confidence.'
  ].join(' ')

  const user = [
    `Existing tags: ${vocabulary || '(none yet)'}`,
    hintText ? `Local visual matches: ${hintText}` : '',
    examples ? `Similar items already tagged:\n${examples}` : '',
    rejected.length ? `Previously rejected for this item (do not suggest): ${rejected.join(', ')}` : '',
    `Item: ${target.kind} titled "${target.title}" (${target.width}x${target.height}${
      target.durationMs ? `, ${Math.round(target.durationMs / 1000)}s` : ''
    })`,
    'The title or filename can hint at a character, series or subject, but verify it against the image.',
    'Tag what is visually present and what the item is.'
  ]
    .filter(Boolean)
    .join('\n')

  const content: unknown[] = [{ type: 'text', text: user }]
  if (b64) content.push({ type: 'image_url', image_url: { url: `data:image/webp;base64,${b64}`, detail: 'low' } })

  const res = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.1,
      max_tokens: 400,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content }
      ]
    }),
    signal: AbortSignal.timeout(60000)
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Model request failed (${res.status}) ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const text = json.choices?.[0]?.message?.content ?? ''
  const parsed = parseTagPayload(text)
  const known = new Set(lib.data.tags.map((tag) => tag.name))
  const blocked = new Set([...target.tags, ...rejected])
  const out: AiSuggestion[] = []
  const seen = new Set<string>()
  let newTags = 0
  for (const entry of parsed) {
    const tag = normalizeTagName(entry.tag)
    if (!tag || seen.has(tag) || blocked.has(tag)) continue
    if (!known.has(tag)) {
      if (newTags >= 2) continue
      newTags++
    }
    seen.add(tag)
    const score = typeof entry.score === 'number' ? Math.max(0, Math.min(1, entry.score)) : 0.7
    out.push({ tag, score, source: 'model' })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, settings.maxTags || 5)
}

/**
 * Leave-one-out check of the local tagger. Each tagged item is predicted with
 * its own tags hidden, then compared with the tags the user actually applied.
 * This gives a concrete precision/recall number for the current vocabulary and
 * confidence threshold. It is sampled so large libraries stay responsive.
 */
export function evaluateLocal(lib: Library, maxItems = 150): AiEvaluation {
  const settings = lib.data.settings.ai
  const tagged = lib.items().filter((item) => item.tags.length > 0)
  const limit = Math.max(1, Math.floor(maxItems))
  const step = Math.max(1, Math.ceil(tagged.length / limit))
  const sample = tagged.filter((_, index) => index % step === 0).slice(0, limit)

  const perTag = new Map<string, AiTagMetric>()
  let predictedTotal = 0
  let correct = 0
  let actualTotal = 0

  const metricFor = (tag: string): AiTagMetric => {
    const existing = perTag.get(tag)
    if (existing) return existing
    const metric: AiTagMetric = {
      tag,
      support: 0,
      predicted: 0,
      correct: 0,
      precision: 0,
      recall: 0
    }
    perTag.set(tag, metric)
    return metric
  }

  // Collect every scored prediction once, then evaluate several thresholds
  // from the same pass. That keeps the check cheap and makes the suggested
  // threshold directly comparable.
  const scored: { actual: Set<string>; predicted: AiSuggestion[] }[] = []
  for (const item of sample) {
    const actual = new Set(item.tags)
    actualTotal += actual.size
    const clone: MediaItem = { ...item, tags: [], rejectedTags: undefined, ai: undefined }
    const predictions = localSuggestions(lib, clone, {
      ...settings,
      minScore: 0,
      maxTags: Math.max(settings.maxTags, 8)
    })
    scored.push({ actual, predicted: predictions })
    for (const suggestion of predictions) {
      if (suggestion.score < settings.minScore) continue
      predictedTotal++
      const metric = metricFor(suggestion.tag)
      metric.predicted++
      if (actual.has(suggestion.tag)) {
        correct++
        metric.correct++
      }
    }
    for (const tag of actual) metricFor(tag).support++
  }

  const thresholds = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]
  const curve = thresholds.map((threshold) => {
    let predicted = 0
    let hits = 0
    for (const entry of scored) {
      for (const suggestion of entry.predicted) {
        if (suggestion.score < threshold) continue
        predicted++
        if (entry.actual.has(suggestion.tag)) hits++
      }
    }
    const p = predicted ? hits / predicted : 0
    const r = actualTotal ? hits / actualTotal : 0
    return {
      threshold,
      predicted,
      correct: hits,
      precision: p,
      recall: r,
      f1: p + r ? (2 * p * r) / (p + r) : 0
    }
  })
  const best = curve.reduce((a, b) =>
    b.f1 > a.f1 || (b.f1 === a.f1 && b.precision > a.precision) ? b : a
  )

  const metrics = [...perTag.values()].map((metric) => ({
    ...metric,
    precision: metric.predicted ? metric.correct / metric.predicted : 0,
    recall: metric.support ? metric.correct / metric.support : 0
  }))
  metrics.sort((a, b) => b.support - a.support || a.tag.localeCompare(b.tag))

  const precision = predictedTotal ? correct / predictedTotal : 0
  const recall = actualTotal ? correct / actualTotal : 0
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0

  return {
    items: sample.length,
    predicted: predictedTotal,
    correct,
    precision,
    recall,
    f1,
    threshold: settings.minScore,
    suggestedThreshold: best.threshold,
    suggestedF1: best.f1,
    curve,
    perTag: metrics
  }
}

export async function testConnection(settings: AiSettings): Promise<AiTestResult> {
  if (settings.provider === 'local') {
    return { ok: true, message: 'Local similarity tagger needs no network. It learns from your tagged items.' }
  }
  if (!settings.apiKey) return { ok: false, message: 'Add an API key first.' }
  try {
    const res = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(20000)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, message: `${res.status} ${res.statusText} — ${body.slice(0, 160)}` }
    }
    const json = (await res.json()) as { data?: { id: string }[] }
    const count = json.data?.length ?? 0
    return { ok: true, message: `Connected. ${count} models available.` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' }
  }
}
