import type { MediaItem } from '@shared/types'

/**
 * Search syntax shared by the title bar, inbox and library.
 *
 *   #tag        must have this tag
 *   !tag        must not have this tag
 *   plain       matches the title or any tag
 *   "two words" treated as one text phrase
 *
 * A plain word that exactly matches an existing tag is treated as a tag filter,
 * so `harbor forest` narrows to items carrying both tags. Quoting it
 * (`"harbor"`) forces a text search instead.
 */

export interface ParsedQuery {
  raw: string
  include: string[]
  exclude: string[]
  terms: string[]
}

export function normalizeSearchTag(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 48)
}

export function parseQuery(raw: string, knownTags: Iterable<string> = []): ParsedQuery {
  const known = new Set<string>()
  for (const name of knownTags) known.add(normalizeSearchTag(name))

  const include: string[] = []
  const exclude: string[] = []
  const terms: string[] = []
  let i = 0

  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i++
    if (i >= raw.length) break

    let negate = false
    let tagPrefix = false
    if (raw[i] === '!') {
      negate = true
      i++
    }
    if (raw[i] === '#') {
      tagPrefix = true
      i++
    }

    let value = ''
    if (raw[i] === '"') {
      i++
      const start = i
      while (i < raw.length && raw[i] !== '"') i++
      value = raw.slice(start, i)
      if (raw[i] === '"') i++
    } else {
      const start = i
      while (i < raw.length && !/\s/.test(raw[i])) i++
      value = raw.slice(start, i)
    }

    value = value.trim()
    if (!value) continue
    const tag = normalizeSearchTag(value)

    if (negate) {
      if (tag && !exclude.includes(tag)) exclude.push(tag)
    } else if (tagPrefix || known.has(tag)) {
      if (tag && !include.includes(tag)) include.push(tag)
    } else {
      const term = value.toLowerCase()
      if (!terms.includes(term)) terms.push(term)
    }
  }

  return { raw, include, exclude, terms }
}

export function serializeQuery(parts: Pick<ParsedQuery, 'include' | 'exclude' | 'terms'>): string {
  const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value)
  return [
    ...parts.include.map((tag) => `#${quote(tag)}`),
    ...parts.exclude.map((tag) => `!${quote(tag)}`),
    ...parts.terms.map(quote)
  ].join(' ')
}

export function itemMatchesQuery(item: MediaItem, query: ParsedQuery): boolean {
  for (const tag of query.include) if (!item.tags.includes(tag)) return false
  for (const tag of query.exclude) if (item.tags.includes(tag)) return false
  if (query.terms.length) {
    const haystack = `${item.title} ${item.tags.join(' ')}`.toLowerCase()
    for (const term of query.terms) if (!haystack.includes(term)) return false
  }
  return true
}

export function hasQuery(query: ParsedQuery): boolean {
  return query.include.length > 0 || query.exclude.length > 0 || query.terms.length > 0
}
