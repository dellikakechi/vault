import { create } from 'zustand'
import type {
  DuplicateGroup,
  LibraryData,
  LibrarySettings,
  MediaItem,
  MediaKind,
  Tag,
  TagCategory,
  ViewId
} from '@shared/types'
import { parseQuery, serializeQuery } from './lib/search'
import { readManual, writeManual, type ManualPlacement } from './lib/manual'
import { placeBatch } from './lib/arrange'

export interface ToastItem {
  id: number
  message: string
  kind: 'info' | 'success' | 'error'
}

export interface ImportState {
  total: number
  done: number
  label: string
  phase: 'reading' | 'saving'
}

export interface ConvertState {
  total: number
  done: number
  failed: number
  skipped: number
  label: string
}

export interface ConfirmSpec {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}

interface AppState {
  lib: LibraryData | null
  loadError: string | null
  view: ViewId
  selected: Set<string>
  detailId: string | null
  videoToolId: string | null
  coverToolId: string | null
  readerId: string | null
  /** Image currently shown in the full-screen viewer, if any. */
  viewerId: string | null
  /** Snapshot of a duplicate group being read like a comic, if any. */
  compareGroup: DuplicateGroup | null
  /**
   * IDs of the items the active view is showing, in display order. Views
   * publish this so overlays (the image viewer) can move through exactly what
   * the user sees, including the view's own filter and sort.
   */
  viewOrder: string[]
  /**
   * Categories explicitly expanded by the user. Categories are collapsed by
   * default, and a tag search/filter expands them temporarily.
   */
  expandedCategories: string[]
  search: string
  typeFilter: MediaKind | 'all'
  tagFilter: string[]
  focusTag: string | null
  tagRailOpen: boolean
  tagManagerOpen: boolean
  importState: ImportState | null
  convertState: ConvertState | null
  toasts: ToastItem[]
  dupes: DuplicateGroup[] | null
  dupesLoading: boolean
  aiBusy: boolean
  confirm: ConfirmSpec | null
  /** Free-canvas positions for the current library. */
  manual: Record<string, ManualPlacement>
  /** Set after a batch is placed, so the canvas can reveal it once. */
  lastBatch: { ids: string[]; at: number } | null

  init: () => Promise<void>
  hydrate: (lib: LibraryData) => void
  setView: (view: ViewId) => void
  select: (ids: string[], mode?: 'replace' | 'add' | 'toggle') => void
  clearSelection: () => void
  setDetail: (id: string | null) => void
  setVideoTool: (id: string | null) => void
  setCoverTool: (id: string | null) => void
  setReader: (id: string | null) => void
  setViewer: (id: string | null) => void
  setCompareGroup: (group: DuplicateGroup | null) => void
  setViewOrder: (ids: string[]) => void
  toggleCategoryExpanded: (id: string) => void
  setSearch: (q: string) => void
  setTypeFilter: (t: MediaKind | 'all') => void
  toggleTagFilter: (name: string) => void
  setTagFilter: (names: string[]) => void
  setFocusTag: (name: string | null) => void
  setTagRailOpen: (open: boolean) => void
  setTagManagerOpen: (open: boolean) => void
  patchItem: (item: MediaItem) => void
  mergeItems: (items: MediaItem[]) => void
  dropItems: (ids: string[]) => void
  setImportState: (s: ImportState | null) => void
  setConvertState: (s: ConvertState | null) => void
  toast: (message: string, kind?: ToastItem['kind']) => void
  dismissToast: (id: number) => void
  confirmAction: (spec: ConfirmSpec) => void
  closeConfirm: () => void
  applyTags: (ids: string[], add: string[], remove?: string[]) => Promise<void>
  clearTags: (ids: string[]) => Promise<void>
  setMembership: (
    ids: string[],
    patch: { inbox?: boolean; aiQueue?: boolean }
  ) => Promise<void>
  updateManual: (updates: Record<string, { x: number; y: number }>) => void
  placeInboxBatch: (ids: string[]) => void
  clearLastBatch: () => void
  createTag: (name: string) => Promise<Tag | null>
  renameTag: (id: string, name: string) => Promise<boolean>
  deleteTag: (id: string) => Promise<void>
  createCategory: (name: string, parentId?: string | null) => Promise<TagCategory | null>
  moveCategory: (id: string, parentId: string | null) => Promise<boolean>
  renameCategory: (id: string, name: string) => Promise<boolean>
  deleteCategory: (id: string) => Promise<void>
  setTagCategory: (tagId: string, categoryId: string | null) => Promise<void>
  deleteItems: (ids: string[]) => Promise<void>
  createImageSet: (ids: string[]) => Promise<MediaItem | null>
  updateSettings: (patch: Partial<LibrarySettings>) => Promise<void>
  findDupes: (threshold: number) => Promise<void>
  setAiBusy: (busy: boolean) => void
}

let toastSeq = 0

function mergeInto(lib: LibraryData, items: MediaItem[]): LibraryData {
  if (!items.length) return lib
  const next = { ...lib.items }
  for (const item of items) next[item.id] = item
  return { ...lib, items: next }
}

export const useStore = create<AppState>((set, get) => ({
  lib: null,
  loadError: null,
  view: 'inbox',
  selected: new Set(),
  detailId: null,
  videoToolId: null,
  coverToolId: null,
  readerId: null,
  viewerId: null,
  compareGroup: null,
  viewOrder: [],
  expandedCategories: [],
  search: '',
  typeFilter: 'all',
  tagFilter: [],
  focusTag: null,
  tagRailOpen: true,
  tagManagerOpen: false,
  importState: null,
  convertState: null,
  toasts: [],
  dupes: null,
  dupesLoading: false,
  aiBusy: false,
  confirm: null,
  manual: {},
  lastBatch: null,

  init: async () => {
    try {
      const lib = await window.vault.getLibrary()
      set({ lib, manual: readManual(lib.id) })
    } catch (err) {
      set({ loadError: err instanceof Error ? err.message : String(err) })
    }
  },

  hydrate: (lib) =>
    set({ lib, selected: new Set(), detailId: null, manual: readManual(lib.id), lastBatch: null }),

  setView: (view) =>
    set((s) => ({
      view,
      detailId: null,
      viewerId: null,
      viewOrder: [],
      focusTag: null,
      selected: view === 'inbox' ? s.selected : new Set()
    })),

  select: (ids, mode = 'replace') =>
    set((s) => {
      if (mode === 'replace') return { selected: new Set(ids) }
      const next = new Set(s.selected)
      for (const id of ids) {
        if (mode === 'add') next.add(id)
        else if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      return { selected: next }
    }),

  clearSelection: () => set({ selected: new Set() }),
  setDetail: (detailId) => set({ detailId }),
  setVideoTool: (videoToolId) => set({ videoToolId }),
  setCoverTool: (coverToolId) => set({ coverToolId }),
  setReader: (readerId) => set({ readerId }),
  setViewer: (viewerId) => set({ viewerId }),
  setCompareGroup: (compareGroup) => set({ compareGroup }),
  setViewOrder: (ids) =>
    set((s) => {
      if (s.viewOrder.length === ids.length && s.viewOrder.every((id, i) => id === ids[i])) {
        return {}
      }
      return { viewOrder: ids }
    }),
  toggleCategoryExpanded: (id) =>
    set((s) => ({
      expandedCategories: s.expandedCategories.includes(id)
        ? s.expandedCategories.filter((value) => value !== id)
        : [...s.expandedCategories, id]
    })),
  setSearch: (search) => set({ search }),
  setTypeFilter: (typeFilter) => set({ typeFilter }),
  toggleTagFilter: (name) =>
    set((s) => ({
      tagFilter: s.tagFilter.includes(name) ? s.tagFilter.filter((t) => t !== name) : [...s.tagFilter, name]
    })),
  setTagFilter: (tagFilter) => set({ tagFilter }),
  setFocusTag: (focusTag) => set({ focusTag }),
  setTagRailOpen: (tagRailOpen) => set({ tagRailOpen }),
  setTagManagerOpen: (tagManagerOpen) => set({ tagManagerOpen }),

  patchItem: (item) =>
    set((s) => (s.lib ? { lib: { ...s.lib, items: { ...s.lib.items, [item.id]: item } } } : {})),

  mergeItems: (items) => set((s) => (s.lib ? { lib: mergeInto(s.lib, items) } : {})),

  dropItems: (ids) =>
    set((s) => {
      if (!s.lib) return {}
      const items = { ...s.lib.items }
      for (const id of ids) delete items[id]
      const selected = new Set(s.selected)
      for (const id of ids) selected.delete(id)
      const detailId = s.detailId && ids.includes(s.detailId) ? null : s.detailId
      return { lib: { ...s.lib, items }, selected, detailId }
    }),

  setImportState: (importState) => set({ importState }),
  setConvertState: (convertState) => set({ convertState }),

  toast: (message, kind = 'info') => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3800)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  confirmAction: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),

  applyTags: async (ids, add, remove = []) => {
    if (!ids.length) return
    const changed = await window.vault.applyTags(ids, add, remove)
    get().mergeItems(changed)
    const lib = get().lib
    if (lib) {
      const tags = [...lib.tags]
      for (const name of add) {
        if (!tags.some((t) => t.name === name)) {
          tags.push({ id: `tmp-${name}`, name, createdAt: Date.now() })
        }
      }
      set({ lib: { ...get().lib!, tags } })
      const fresh = await window.vault.getLibrary()
      set({ lib: fresh })
    }
    const verb = add.length
      ? `Tagged ${ids.length}`
      : remove.length
        ? `Untagged ${ids.length}`
        : `Updated ${ids.length}`
    get().toast(verb, 'success')
  },

  clearTags: async (ids) => {
    const lib = get().lib
    if (!lib || !ids.length) return
    const names = new Set<string>()
    for (const id of ids) for (const name of lib.items[id]?.tags ?? []) names.add(name)
    if (!names.size) {
      get().toast('Those items have no tags', 'info')
      return
    }
    await get().applyTags(ids, [], [...names])
  },

  setMembership: async (ids, patch) => {
    if (!ids.length) return
    const before = get().lib
    const entering =
      patch.inbox === true && before
        ? ids.filter((id) => before.items[id] && !before.items[id].inbox)
        : []
    const changed = await window.vault.setMembership(ids, patch)
    get().mergeItems(changed)
    if (entering.length) get().placeInboxBatch(entering)
    const n = ids.length
    const noun = n === 1 ? 'item' : 'items'
    if (patch.inbox !== undefined) {
      get().toast(
        patch.inbox ? `Sent ${n} ${noun} to the inbox` : `Removed ${n} ${noun} from the inbox`,
        'success'
      )
    }
    if (patch.aiQueue !== undefined) {
      get().toast(
        patch.aiQueue
          ? `Sent ${n} ${noun} to the AI queue`
          : `Removed ${n} ${noun} from the AI queue`,
        'success'
      )
    }
  },

  updateManual: (updates) => {
    const lib = get().lib
    if (!lib || !Object.keys(updates).length) return
    const next = { ...get().manual, ...updates }
    writeManual(lib.id, next)
    set({ manual: next })
  },

  /**
   * Place newly added inbox items in their own free-canvas region. Items that
   * already have a manual position (for example, re-sent to the inbox) keep it,
   * but every item entering the inbox is still flagged for a one-time reveal so
   * the user can see where it went.
   */
  placeInboxBatch: (ids) => {
    const lib = get().lib
    if (!lib || !ids.length) return
    const manual = get().manual
    const entering = [...new Set(ids)].filter((id) => lib.items[id]?.inbox)
    if (!entering.length) return
    const unique = entering.filter((id) => !manual[id])
    let next = manual
    if (unique.length) {
      const batchSet = new Set(unique)
      const existing = Object.values(lib.items).filter(
        (item) => item.inbox && !batchSet.has(item.id)
      )
      const batch = unique
        .map((id) => lib.items[id])
        .filter((item): item is MediaItem => !!item)
      const placed =
        existing.length && batch.length
          ? placeBatch(existing, batch, lib.settings.tileSize || 210, manual)
          : null
      if (placed) {
        next = { ...manual, ...placed }
        writeManual(lib.id, next)
      }
    }
    set({ manual: next, lastBatch: { ids: entering, at: Date.now() } })
  },

  clearLastBatch: () => set({ lastBatch: null }),

  createTag: async (name) => {
    const clean = name.trim().toLowerCase()
    if (!clean) return null
    const tag = await window.vault.addTag(clean)
    const lib = get().lib
    if (lib && !lib.tags.some((t) => t.name === tag.name)) {
      set({ lib: { ...lib, tags: [...lib.tags, tag] } })
    }
    return tag
  },

  renameTag: async (id, name) => {
    const lib = get().lib
    const previous = lib?.tags.find((tag) => tag.id === id)?.name
    const before = lib ? parseQuery(get().search, lib.tags.map((tag) => tag.name)) : null
    const tag = await window.vault.renameTag(id, name.trim())
    if (!tag) {
      get().toast('Tag not found', 'error')
      return false
    }
    const fresh = await window.vault.getLibrary()
    const replace = (names: string[]): string[] =>
      previous ? names.map((n) => (n === previous ? tag.name : n)) : names
    set({
      lib: fresh,
      tagFilter: replace(get().tagFilter),
      focusTag: get().focusTag && previous && get().focusTag === previous ? tag.name : get().focusTag,
      search: before
        ? serializeQuery({
            include: replace(before.include),
            exclude: replace(before.exclude),
            terms: before.terms
          })
        : get().search
    })
    get().toast(`Renamed to #${tag.name}`, 'success')
    return true
  },

  deleteTag: async (id) => {
    const lib = get().lib
    const previous = lib?.tags.find((tag) => tag.id === id)?.name
    const before = lib ? parseQuery(get().search, lib.tags.map((tag) => tag.name)) : null
    await window.vault.deleteTag(id)
    const fresh = await window.vault.getLibrary()
    set({
      lib: fresh,
      tagFilter: previous ? get().tagFilter.filter((name) => name !== previous) : get().tagFilter,
      focusTag: previous && get().focusTag === previous ? null : get().focusTag,
      search: before
        ? serializeQuery({
            include: before.include.filter((name) => name !== previous),
            exclude: before.exclude.filter((name) => name !== previous),
            terms: before.terms
          })
        : get().search
    })
    get().toast(previous ? `Deleted #${previous}` : 'Tag deleted', 'success')
  },

  createCategory: async (name, parentId) => {
    const clean = name.trim()
    if (!clean) return null
    const category = await window.vault.addCategory(clean, undefined, parentId ?? null)
    const lib = get().lib
    if (lib && !lib.categories.some((c) => c.id === category.id)) {
      set({ lib: { ...lib, categories: [...lib.categories, category] } })
    } else if (lib && (category.parentId ?? null) !== (parentId ?? null)) {
      get().toast(`Category “${category.name}” already exists`, 'info')
    }
    return category
  },

  moveCategory: async (id, parentId) => {
    const category = await window.vault.setCategoryParent(id, parentId)
    if (!category) {
      const fresh = await window.vault.getLibrary()
      set({ lib: fresh })
      get().toast('A category cannot be moved inside itself', 'error')
      return false
    }
    const fresh = await window.vault.getLibrary()
    set({ lib: fresh })
    get().toast(
      parentId ? `Moved category ${category.name}` : `Moved category ${category.name} to top level`,
      'success'
    )
    return true
  },

  renameCategory: async (id, name) => {
    const category = await window.vault.renameCategory(id, name.trim())
    if (!category) {
      get().toast('Could not rename — a category cannot merge into its own child', 'error')
      return false
    }
    const fresh = await window.vault.getLibrary()
    set({ lib: fresh })
    get().toast(`Renamed category to ${category.name}`, 'success')
    return true
  },

  deleteCategory: async (id) => {
    const previous = get().lib?.categories.find((c) => c.id === id)?.name
    await window.vault.deleteCategory(id)
    const fresh = await window.vault.getLibrary()
    set({ lib: fresh })
    get().toast(
      previous ? `Deleted category ${previous} · tags kept` : 'Category deleted',
      'success'
    )
  },

  setTagCategory: async (tagId, categoryId) => {
    const tag = await window.vault.setTagCategory(tagId, categoryId)
    if (!tag) return
    const lib = get().lib
    if (!lib) return
    set({ lib: { ...lib, tags: lib.tags.map((t) => (t.id === tag.id ? tag : t)) } })
  },

  deleteItems: async (ids) => {
    if (!ids.length) return
    const res = await window.vault.deleteItems(ids)
    get().dropItems(ids)
    get().toast(
      res.kept
        ? `Removed ${res.removed} item${res.removed === 1 ? '' : 's'} (${res.kept} linked file${res.kept === 1 ? '' : 's'} left in place)`
        : `Moved ${res.removed} item${res.removed === 1 ? '' : 's'} to trash`,
      'success'
    )
  },

  createImageSet: async (ids) => {
    try {
      const item = await window.vault.createImageSet(ids)
      if (!item) return null
      set((s) => {
        if (!s.lib) return {}
        return {
          lib: { ...s.lib, items: { ...s.lib.items, [item.id]: item } },
          view: 'library',
          typeFilter: 'set',
          selected: new Set([item.id]),
          viewOrder: [item.id],
          detailId: null,
          search: '',
          tagFilter: [],
          focusTag: null
        }
      })
      get().toast(
        `Created an image set with ${item.pages?.length ?? 0} pages`,
        'success'
      )
      return item
    } catch (err) {
      get().toast(err instanceof Error ? err.message : 'Could not create image set', 'error')
      return null
    }
  },

  updateSettings: async (patch) => {
    const settings = await window.vault.setSettings(patch)
    const lib = get().lib
    if (lib) set({ lib: { ...lib, settings } })
  },

  findDupes: async (threshold) => {
    set({ dupesLoading: true })
    try {
      const dupes = await window.vault.findDuplicates(threshold)
      set({ dupes, dupesLoading: false })
    } catch (err) {
      set({ dupesLoading: false })
      get().toast(err instanceof Error ? err.message : 'Duplicate scan failed', 'error')
    }
  },

  setAiBusy: (aiBusy) => set({ aiBusy })
}))

export function useItems(): MediaItem[] {
  const lib = useStore((s) => s.lib)
  return lib ? Object.values(lib.items) : EMPTY
}

const EMPTY: MediaItem[] = []

export function useItem(id: string | null): MediaItem | null {
  const lib = useStore((s) => s.lib)
  return id && lib ? lib.items[id] ?? null : null
}

export function useTagCounts(): Map<string, number> {
  const items = useItems()
  const counts = new Map<string, number>()
  for (const item of items) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return counts
}
