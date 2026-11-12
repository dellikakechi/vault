import type { TagCategory } from '@shared/types'

export interface CategoryNode {
  category: TagCategory
  depth: number
  children: CategoryNode[]
}

/**
 * Turn a flat category list into a stable parent/child tree. Invalid or
 * cyclic links are surfaced at the top level instead of disappearing.
 */
export function buildCategoryTree(categories: TagCategory[]): CategoryNode[] {
  const ids = new Set(categories.map((category) => category.id))
  const byParent = new Map<string | undefined, TagCategory[]>()
  for (const category of categories) {
    const parent =
      category.parentId && category.parentId !== category.id && ids.has(category.parentId)
        ? category.parentId
        : undefined
    const list = byParent.get(parent)
    if (list) list.push(category)
    else byParent.set(parent, [category])
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }

  const seen = new Set<string>()
  const build = (parentId: string | undefined, depth: number): CategoryNode[] => {
    const out: CategoryNode[] = []
    for (const category of byParent.get(parentId) ?? []) {
      if (seen.has(category.id)) continue
      seen.add(category.id)
      out.push({
        category,
        depth,
        children: build(category.id, depth + 1)
      })
    }
    return out
  }

  const roots = build(undefined, 0)
  for (const category of categories) {
    if (seen.has(category.id)) continue
    seen.add(category.id)
    roots.push({ category, depth: 0, children: [] })
  }
  return roots
}

export function flattenCategoryTree(nodes: CategoryNode[]): CategoryNode[] {
  const out: CategoryNode[] = []
  const walk = (list: CategoryNode[]): void => {
    for (const node of list) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** Every category below `id`, excluding `id` itself. */
export function categoryDescendants(categories: TagCategory[], id: string): Set<string> {
  const out = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const category of categories) {
      if (category.id === id || !category.parentId || out.has(category.id)) continue
      if (category.parentId === id || out.has(category.parentId)) {
        out.add(category.id)
        changed = true
      }
    }
  }
  return out
}

export function categoryPath(categories: TagCategory[], id: string): string {
  const byId = new Map(categories.map((category) => [category.id, category]))
  const parts: string[] = []
  const seen = new Set<string>()
  let current = byId.get(id)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    parts.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return parts.join(' / ')
}

/** Ancestors of a category, closest first, including the category itself. */
export function categoryChain(categories: TagCategory[], id: string): string[] {
  const byId = new Map(categories.map((category) => [category.id, category]))
  const out: string[] = []
  const seen = new Set<string>()
  let current = byId.get(id)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    out.push(current.id)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return out
}
