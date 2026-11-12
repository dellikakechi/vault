import { useEffect, useMemo, useRef, useState } from 'react'
import type { MediaItem, MediaKind } from '@shared/types'
import { fileUrl, thumbUrl } from '@shared/api'
import { useItems, useStore, useTagCounts } from '../store'
import { cx, formatBytes, formatDate, formatDuration, kindLabel, pluralize, tagColor } from '../lib/util'
import { itemMatchesQuery, parseQuery, serializeQuery } from '../lib/search'
import { buildCategoryTree, categoryDescendants, flattenCategoryTree } from '../lib/categories'
import { runConversion } from '../lib/convertRunner'
import { Icon, type IconName } from '../components/Icon'
import { EmptyState } from '../components/ui'

type SortKey = 'recent' | 'oldest' | 'title' | 'size'
type Special = 'all' | 'inbox' | 'ai' | 'untagged'

const TYPE_FILTERS: { value: MediaKind | 'all'; label: string; icon: IconName }[] = [
  { value: 'all', label: 'All media', icon: 'layers' },
  { value: 'image', label: 'Images', icon: 'image' },
  { value: 'gif', label: 'GIFs', icon: 'layers' },
  { value: 'comic', label: 'Comics', icon: 'book' },
  { value: 'set', label: 'Image sets', icon: 'grid' },
  { value: 'video', label: 'Videos', icon: 'film' }
]

export function LibraryView({ onImport }: { onImport: (kind: 'files' | 'folder') => void }): React.JSX.Element {
  const items = useItems()
  const lib = useStore((s) => s.lib)
  const search = useStore((s) => s.search)
  const typeFilter = useStore((s) => s.typeFilter)
  const setTypeFilter = useStore((s) => s.setTypeFilter)
  const tagFilter = useStore((s) => s.tagFilter)
  const toggleTagFilter = useStore((s) => s.toggleTagFilter)
  const setTagFilter = useStore((s) => s.setTagFilter)
  const setSearch = useStore((s) => s.setSearch)
  const setDetail = useStore((s) => s.setDetail)
  const selected = useStore((s) => s.selected)
  const updateSettings = useStore((s) => s.updateSettings)
  const setMembership = useStore((s) => s.setMembership)
  const setViewOrder = useStore((s) => s.setViewOrder)
  const expandedCategories = useStore((s) => s.expandedCategories)
  const toggleCategoryExpanded = useStore((s) => s.toggleCategoryExpanded)
  const counts = useTagCounts()

  const [special, setSpecial] = useState<Special>('all')
  const [sort, setSort] = useState<SortKey>('recent')
  const [tagQuery, setTagQuery] = useState('')
  const [tagText, setTagText] = useState('')
  /** Categories the user collapsed while a tag search/filter is active. */
  const [filterCollapsed, setFilterCollapsed] = useState<string[]>([])
  const lastIndex = useRef(-1)

  const tileSize = lib?.settings.tileSize ?? 210
  const tags = lib?.tags ?? []
  const parsed = useMemo(() => parseQuery(search, tags.map((tag) => tag.name)), [search, tags])

  const filtered = useMemo(() => {
    const out = items.filter((i) => {
      if (typeFilter !== 'all' && i.kind !== typeFilter) return false
      if (special === 'inbox' && !i.inbox) return false
      if (special === 'ai' && !i.aiQueue) return false
      if (special === 'untagged' && i.tags.length > 0) return false
      if (tagFilter.length && !tagFilter.every((t) => i.tags.includes(t))) return false
      if (!itemMatchesQuery(i, parsed)) return false
      return true
    })
    out.sort((a, b) => {
      if (sort === 'recent') return b.addedAt - a.addedAt
      if (sort === 'oldest') return a.addedAt - b.addedAt
      if (sort === 'title') return a.title.localeCompare(b.title)
      return b.bytes - a.bytes
    })
    return out
  }, [items, typeFilter, special, tagFilter, parsed, sort])

  // Publish what the grid is showing so the full-screen viewer can move
  // through the same list, in the same order.
  useEffect(() => {
    setViewOrder(filtered.map((item) => item.id))
  }, [filtered, setViewOrder])

  const countsByType = useMemo(() => {
    const map: Record<string, number> = { all: items.length }
    for (const i of items) map[i.kind] = (map[i.kind] ?? 0) + 1
    return map
  }, [items])

  // Creating an image set switches the collection filter programmatically; make
  // sure a status filter cannot keep the new set hidden.
  useEffect(() => {
    if (typeFilter !== 'all') setSpecial('all')
  }, [typeFilter])

  const untaggedCount = items.filter((i) => i.tags.length === 0).length
  const inboxCount = items.filter((i) => i.inbox).length
  const aiCount = items.filter((i) => i.aiQueue).length

  const visibleTags = useMemo(() => {
    const q = tagQuery.trim().toLowerCase()
    return tags
      .filter((t) => !q || t.name.includes(q))
      .sort((a, b) => (counts.get(b.name) ?? 0) - (counts.get(a.name) ?? 0) || a.name.localeCompare(b.name))
  }, [tags, tagQuery, counts])

  const tagGroups = useMemo(() => {
    const categories = lib?.categories ?? []
    if (!categories.length) return [{ id: '', name: '', depth: 0, tags: visibleTags }]
    const byId = new Map(categories.map((category) => [category.id, category]))
    const flat = flattenCategoryTree(buildCategoryTree(categories))
    const visible = new Set<string>()
    const groups = flat
      .map((node) => {
        const groupTags = visibleTags.filter((tag) => tag.categoryId === node.category.id)
        if (groupTags.length) {
          let id: string | undefined = node.category.id
          while (id) {
            visible.add(id)
            id = byId.get(id)?.parentId
          }
        }
        return {
          id: node.category.id,
          name: node.category.name,
          depth: node.depth,
          tags: groupTags
        }
      })
      .filter((group) => visible.has(group.id))
    const loose = visibleTags.filter((tag) => !tag.categoryId || !byId.has(tag.categoryId))
    if (loose.length) groups.push({ id: '', name: 'Uncategorized', depth: 0, tags: loose })
    return groups
  }, [lib?.categories, visibleTags])

  // A tag search/filter temporarily opens every category so matches are
  // visible. Clearing it returns the categories to their default (collapsed).
  const filteringTags =
    tagQuery.trim() !== '' || tagFilter.length > 0 || parsed.include.length > 0

  useEffect(() => {
    if (!filteringTags) setFilterCollapsed([])
  }, [filteringTags])

  const collapsedIds = useMemo(() => {
    const categories = lib?.categories ?? []
    if (filteringTags) return filterCollapsed
    return categories
      .map((category) => category.id)
      .filter((id) => !expandedCategories.includes(id))
  }, [filteringTags, filterCollapsed, expandedCategories, lib?.categories])

  // A collapsed category hides its tags and every descendant category, but the
  // category's own row stays visible so it can be expanded again.
  const hiddenCategories = useMemo(() => {
    const categories = lib?.categories ?? []
    const out = new Set<string>()
    for (const id of collapsedIds) {
      for (const child of categoryDescendants(categories, id)) out.add(child)
    }
    return out
  }, [collapsedIds, lib?.categories])

  function isCategoryCollapsed(key: string): boolean {
    // A library without categories shows a flat tag list with no header, so it
    // must never be hidden behind a collapse state.
    if (key === 'uncategorized' && !(lib?.categories?.length ?? 0)) return false
    if (filteringTags) return filterCollapsed.includes(key)
    return !expandedCategories.includes(key)
  }

  function toggleCategoryRow(key: string): void {
    if (filteringTags) {
      setFilterCollapsed((current) =>
        current.includes(key) ? current.filter((value) => value !== key) : [...current, key]
      )
    } else {
      toggleCategoryExpanded(key)
    }
  }

  function onCardClick(e: React.MouseEvent, item: MediaItem, index: number): void {
    const store = useStore.getState()
    if (e.shiftKey && lastIndex.current >= 0) {
      const a = Math.min(lastIndex.current, index)
      const b = Math.max(lastIndex.current, index)
      store.select(filtered.slice(a, b + 1).map((i) => i.id), 'add')
    } else if (e.metaKey || e.ctrlKey) {
      store.select([item.id], 'toggle')
    } else {
      store.select([item.id], 'replace')
    }
    lastIndex.current = index
  }

  /** The thumbnail opens the preview; the area below only selects. */
  function previewCard(e: React.MouseEvent, item: MediaItem): void {
    e.stopPropagation()
    useStore.getState().setDetail(item.id)
  }

  function toggleCard(e: React.MouseEvent, item: MediaItem): void {
    e.stopPropagation()
    useStore.getState().select([item.id], 'toggle')
  }

  function applyBulkTag(e: React.FormEvent): void {
    e.preventDefault()
    const name = tagText.trim()
    if (!name || !selected.size) return
    void useStore.getState().applyTags([...selected], [name])
    setTagText('')
  }

  function confirmBulkDelete(): void {
    const ids = [...selected]
    if (!ids.length) return
    useStore.getState().confirmAction({
      title: `Delete ${ids.length} ${pluralize(ids.length, 'item')}?`,
      body: 'Files move to the library trash folder so they can be recovered from disk.',
      confirmLabel: 'Move to trash',
      danger: true,
      onConfirm: () => void useStore.getState().deleteItems(ids)
    })
  }

  const activeFilters: { label: string; onRemove: () => void; kind?: 'exclude' }[] = []
  if (typeFilter !== 'all') {
    activeFilters.push({
      label: kindLabel(typeFilter),
      onRemove: () => setTypeFilter('all')
    })
  }
  if (special !== 'all') {
    activeFilters.push({
      label:
        special === 'inbox' ? 'Inbox' : special === 'ai' ? 'AI queue' : 'Untagged',
      onRemove: () => setSpecial('all')
    })
  }
  for (const t of tagFilter) {
    activeFilters.push({ label: `#${t}`, onRemove: () => toggleTagFilter(t) })
  }
  for (const t of parsed.include) {
    if (tagFilter.includes(t)) continue
    activeFilters.push({
      label: `#${t}`,
      onRemove: () =>
        setSearch(
          serializeQuery({
            include: parsed.include.filter((name) => name !== t),
            exclude: parsed.exclude,
            terms: parsed.terms
          })
        )
    })
  }
  for (const t of parsed.exclude) {
    activeFilters.push({
      label: `!${t}`,
      kind: 'exclude',
      onRemove: () =>
        setSearch(
          serializeQuery({
            include: parsed.include,
            exclude: parsed.exclude.filter((name) => name !== t),
            terms: parsed.terms
          })
        )
    })
  }
  for (const term of parsed.terms) {
    activeFilters.push({
      label: `“${term}”`,
      onRemove: () =>
        setSearch(
          serializeQuery({
            include: parsed.include,
            exclude: parsed.exclude,
            terms: parsed.terms.filter((value) => value !== term)
          })
        )
    })
  }

  const totalBytes = filtered.reduce((n, i) => n + i.bytes, 0)
  const selectedItems = [...selected]
    .map((id) => lib?.items[id])
    .filter((item): item is MediaItem => !!item)
  const allInbox = selectedItems.length > 0 && selectedItems.every((i) => i.inbox)
  const allAi = selectedItems.length > 0 && selectedItems.every((i) => i.aiQueue)
  const anyTags = selectedItems.some((i) => i.tags.length > 0)
  const canCreateSet =
    selectedItems.length >= 2 &&
    selectedItems.every((i) => i.kind === 'image' || i.kind === 'gif')

  return (
    <div className="library">
      <aside className="sidebar">
        <div className="sidebar-section">
          <div className="sidebar-label">Collection</div>
          {TYPE_FILTERS.map((t) => (
            <button
              key={t.value}
              data-filter={t.value}
              className={cx('side-item', typeFilter === t.value && special === 'all' && 'is-active')}
              onClick={() => {
                setTypeFilter(t.value)
                setSpecial('all')
              }}
            >
              <Icon name={t.icon} />
              <span>{t.label}</span>
              <span className="count">{countsByType[t.value] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">Status</div>
          <button
            className={cx('side-item', special === 'inbox' && 'is-active')}
            onClick={() => {
              setSpecial('inbox')
              setTypeFilter('all')
            }}
          >
            <Icon name="inbox" />
            <span>Inbox</span>
            <span className="count">{inboxCount}</span>
          </button>
          <button
            className={cx('side-item', special === 'ai' && 'is-active')}
            onClick={() => {
              setSpecial('ai')
              setTypeFilter('all')
            }}
          >
            <Icon name="sparkles" />
            <span>AI queue</span>
            <span className="count">{aiCount}</span>
          </button>
          <button
            className={cx('side-item', special === 'untagged' && 'is-active')}
            onClick={() => {
              setSpecial('untagged')
              setTypeFilter('all')
            }}
          >
            <Icon name="tag" />
            <span>Untagged</span>
            <span className="count">{untaggedCount}</span>
          </button>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label-row">
            <div className="sidebar-label">Tags</div>
            <button
              className="side-manage"
              onClick={() => useStore.getState().setTagManagerOpen(true)}
              title="Manage tags"
            >
              <Icon name="settings" size={12} />
            </button>
          </div>
          <div className="sidebar-search">
            <Icon name="search" />
            <input
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
              placeholder="Filter tags"
              spellCheck={false}
            />
          </div>
          {tagGroups.map((group) => {
            const key = group.id || 'uncategorized'
            // Descendants of a collapsed category disappear with it.
            if (group.id && hiddenCategories.has(group.id)) return null
            const isCollapsed = isCategoryCollapsed(key)
            return (
              <div
                className={cx('side-tag-group', isCollapsed && 'is-collapsed')}
                key={key}
                data-category-id={group.id}
                data-depth={group.depth}
              >
                {group.name ? (
                  <button
                    className="side-tag-group-head"
                    data-action="tag-category-toggle"
                    data-category-id={group.id}
                    aria-expanded={!isCollapsed}
                    title={`${isCollapsed ? 'Expand' : 'Collapse'} ${group.name}`}
                    onClick={() => toggleCategoryRow(key)}
                    style={{ paddingLeft: `${4 + group.depth * 12}px` }}
                  >
                    <Icon
                      className="side-tag-caret"
                      name={isCollapsed ? 'chevronRight' : 'chevronDown'}
                      size={11}
                    />
                    <span className="sidebar-label side-tag-group-label">{group.name}</span>
                  </button>
                ) : null}
                {isCollapsed
                  ? null
                  : group.tags.map((tag) => (
                      <button
                        key={tag.id}
                        className={cx('side-tag', tagFilter.includes(tag.name) && 'is-on')}
                        onClick={() => toggleTagFilter(tag.name)}
                        style={{ paddingLeft: `${8 + group.depth * 12}px` }}
                      >
                        <span
                          className="dot"
                          style={{ background: tag.color ?? tagColor(tag.name) }}
                        />
                        <span className="name">{tag.name}</span>
                        <span className="count">{counts.get(tag.name) ?? 0}</span>
                      </button>
                    ))}
              </div>
            )
          })}
          {!tags.length ? (
            <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--text-4)' }}>
              Tags you create in the inbox appear here.
            </div>
          ) : null}
          {tagFilter.length ? (
            <button className="side-tag" onClick={() => setTagFilter([])} style={{ color: 'var(--text-4)' }}>
              <Icon name="x" size={12} />
              <span className="name">Clear tag filters</span>
            </button>
          ) : null}
        </div>
      </aside>

      <div className="lib-main">
        <div className="lib-head">
          <div className="view-title">
            <h1>Library</h1>
            <span className="sub">
              {filtered.length} {pluralize(filtered.length, 'item')} · {formatBytes(totalBytes)}
            </span>
          </div>
          <div className="grow" />
          <div className="lib-toolbar">
            <label className="kbd-hint" style={{ gap: 8 }}>
              Size
              <input
                type="range"
                min={140}
                max={320}
                step={10}
                value={tileSize}
                onChange={(e) => void updateSettings({ tileSize: Number(e.target.value) })}
                style={{ width: 90, accentColor: 'var(--accent)' }}
              />
            </label>
            <select
              className="input"
              style={{ width: 132, height: 32, fontSize: 12 }}
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="recent">Recently added</option>
              <option value="oldest">Oldest first</option>
              <option value="title">Title A–Z</option>
              <option value="size">Largest first</option>
            </select>
            <button
              className="btn"
              onClick={() => {
                if (selected.size === filtered.length) useStore.getState().clearSelection()
                else useStore.getState().select(filtered.map((i) => i.id), 'replace')
              }}
            >
              {selected.size === filtered.length && filtered.length ? 'Deselect' : 'Select all'}
            </button>
          </div>
        </div>

        {activeFilters.length ? (
          <div className="filter-chips">
            {activeFilters.map((f) => (
              <span className={cx('chip', f.kind === 'exclude' && 'is-exclude')} key={f.label}>
                {f.label}
                <button onClick={f.onRemove} aria-label="Remove filter">
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {items.length === 0 ? (
          <EmptyState
            icon="library"
            title="Your library is empty"
            action={
              <button className="btn btn-primary" onClick={() => onImport('files')} style={{ marginTop: 6 }}>
                <Icon name="plus" size={15} /> Add media
              </button>
            }
          >
            Import images, GIFs, videos or whole folders of comic pages. Tagged items live here;
            everything else waits in the inbox.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="search"
            title="Nothing matches"
            action={
              <button
                className="btn"
                onClick={() => {
                  setTypeFilter('all')
                  setSpecial('all')
                  setTagFilter([])
                  useStore.getState().setSearch('')
                }}
              >
                Clear filters
              </button>
            }
          >
            Try a different search, or clear the active filters.
          </EmptyState>
        ) : (
          <div className="lib-scroll">
            <div className="grid" style={{ ['--card-size' as string]: `${tileSize}px` }}>
              {filtered.map((item, index) => (
                <Card
                  key={item.id}
                  item={item}
                  index={index}
                  selected={selected.has(item.id)}
                  onClick={(e) => onCardClick(e, item, index)}
                  onPreview={(e) => previewCard(e, item)}
                  onToggle={(e) => toggleCard(e, item)}
                />
              ))}
            </div>
          </div>
        )}

        {selected.size > 0 ? (
          <div className="bulk-bar">
            <span style={{ fontWeight: 600, fontSize: 12 }}>{selected.size} selected</span>
            <span style={{ width: 1, height: 20, background: 'var(--line-strong)' }} />
            <form onSubmit={applyBulkTag} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="tag" size={13} />
              <input
                className="input"
                style={{ height: 30, width: 170 }}
                placeholder="Tag selected, Enter"
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
              />
            </form>
            <button
              className={cx('btn btn-sm btn-ghost', allInbox && 'is-on')}
              data-action="bulk-inbox"
              title={
                allInbox
                  ? 'Remove selected items from the inbox'
                  : 'Send selected items to the inbox'
              }
              onClick={() => void setMembership([...selected], { inbox: !allInbox })}
            >
              <Icon name={allInbox ? 'check' : 'inbox'} size={13} /> Inbox
            </button>
            <button
              className={cx('btn btn-sm btn-ghost', allAi && 'is-on')}
              data-action="bulk-ai"
              title={
                allAi
                  ? 'Remove selected items from the AI queue'
                  : 'Send selected items to the AI queue'
              }
              onClick={() => void setMembership([...selected], { aiQueue: !allAi })}
            >
              <Icon name={allAi ? 'check' : 'sparkles'} size={13} /> AI queue
            </button>
            <button
              className="btn btn-sm btn-ghost"
              data-action="bulk-clear-tags"
              disabled={!anyTags}
              title="Remove every tag from the selected items"
              onClick={() => void useStore.getState().clearTags([...selected])}
            >
              <Icon name="tag" size={13} /> Clear tags
            </button>
            <button
              className="btn btn-sm btn-ghost"
              data-action="bulk-convert"
              title="Convert selected images and comic pages to lossless WebP"
              onClick={() => void runConversion([...selected])}
            >
              <Icon name="refresh" size={13} /> Convert
            </button>
            <button
              className="btn btn-sm btn-ghost"
              data-action="bulk-create-set"
              disabled={!canCreateSet}
              title="Turn the selected images into a paged image set"
              onClick={() => void useStore.getState().createImageSet([...selected])}
            >
              <Icon name="grid" size={13} /> Make image set
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => useStore.getState().clearSelection()}>
              Clear
            </button>
            <button className="btn btn-sm btn-danger" onClick={confirmBulkDelete}>
              <Icon name="trash" size={13} /> Delete
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Card({
  item,
  index,
  selected,
  onClick,
  onPreview,
  onToggle
}: {
  item: MediaItem
  index: number
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  onPreview: (e: React.MouseEvent) => void
  onToggle: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const enter = (): void => {
    if (item.kind !== 'gif') return
    timer.current = setTimeout(() => setHover(true), 260)
  }
  const leave = (): void => {
    if (timer.current) clearTimeout(timer.current)
    setHover(false)
  }

  return (
    <div
      className={cx('card', selected && 'is-selected')}
      data-id={item.id}
      onClick={onClick}
      style={{ animationDelay: `${Math.min(index, 14) * 16}ms` }}
    >
      <div
        className="card-thumb"
        onPointerEnter={enter}
        onPointerLeave={leave}
        onClick={onPreview}
      >
        <img src={thumbUrl(item)} alt="" loading="lazy" decoding="async" />
        {hover && item.kind === 'gif' ? (
          <img className="card-anim" src={fileUrl(item.file)} alt="" decoding="async" />
        ) : null}
        <div className="veil" />
        <span className="card-kind">
          <Icon
            name={item.kind === 'video' ? 'film' : item.kind === 'comic' ? 'book' : item.kind === 'set' ? 'grid' : item.kind === 'gif' ? 'layers' : 'image'}
          />
          {kindLabel(item.kind)}
        </span>
        {item.ai?.length ? <span className="badge ai card-ai">AI</span> : null}
        <button className="card-check" onClick={onToggle} aria-label="Select">
          <Icon name="check" />
        </button>
        {item.kind === 'video' ? (
          <span className="card-play">
            <Icon name="play" />
          </span>
        ) : null}
      </div>
      <div className="card-body">
        <div className="card-title">{item.title}</div>
        <div className="card-meta">
          <span>
            {item.kind === 'video'
              ? formatDuration(item.durationMs)
              : item.kind === 'comic' || item.kind === 'set'
                ? `${item.pages?.length ?? 0} pages`
                : `${item.width}×${item.height}`}
          </span>
          <span className="dotsep" />
          <span>{formatBytes(item.bytes)}</span>
          <span className="dotsep" />
          <span>{formatDate(item.addedAt)}</span>
        </div>
        {item.tags.length ? (
          <div className="card-tags">
            {item.tags.slice(0, 4).map((t) => (
              <span className="card-tag" key={t}>
                {t}
              </span>
            ))}
            {item.tags.length > 4 ? <span className="card-tag">+{item.tags.length - 4}</span> : null}
          </div>
        ) : item.ai?.length ? (
          <div className="card-tags">
            <span className="card-tag ai">AI suggests {item.ai.length}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
