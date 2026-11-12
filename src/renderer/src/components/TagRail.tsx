import { useEffect, useMemo, useRef, useState } from 'react'
import { useItems, useStore, useTagCounts } from '../store'
import { cx, tagColor } from '../lib/util'
import {
  buildCategoryTree,
  categoryDescendants,
  flattenCategoryTree
} from '../lib/categories'
import { Icon } from './Icon'

export function TagRail(): React.JSX.Element {
  const lib = useStore((s) => s.lib)
  const items = useItems()
  const selected = useStore((s) => s.selected)
  const focusTag = useStore((s) => s.focusTag)
  const setFocusTag = useStore((s) => s.setFocusTag)
  const setTagRailOpen = useStore((s) => s.setTagRailOpen)
  const counts = useTagCounts()
  const expandedCategories = useStore((s) => s.expandedCategories)
  const toggleCategoryExpanded = useStore((s) => s.toggleCategoryExpanded)
  const [query, setQuery] = useState('')
  /** Categories the user collapsed while the tag search is active. */
  const [filterCollapsed, setFilterCollapsed] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const tags = useMemo(
    () =>
      [...(lib?.tags ?? [])].sort(
        (a, b) => (counts.get(b.name) ?? 0) - (counts.get(a.name) ?? 0) || a.name.localeCompare(b.name)
      ),
    [lib?.tags, counts]
  )

  const q = query.trim().toLowerCase()
  const filtered = q ? tags.filter((t) => t.name.includes(q)) : tags

  const categories = useMemo(() => [...(lib?.categories ?? [])], [lib?.categories])
  const groups = useMemo(() => {
    if (!categories.length) return [{ id: '', name: '', depth: 0, tags: filtered }]
    const byId = new Map(categories.map((category) => [category.id, category]))
    const flat = flattenCategoryTree(buildCategoryTree(categories))
    const visible = new Set<string>()
    const out = flat
      .map((node) => {
        const groupTags = filtered.filter((tag) => tag.categoryId === node.category.id)
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
    const loose = filtered.filter((tag) => !tag.categoryId || !byId.has(tag.categoryId))
    if (loose.length) out.push({ id: '', name: 'Uncategorized', depth: 0, tags: loose })
    return out
  }, [categories, filtered])

  // Searching tags opens every category so matches are visible; clearing the
  // search returns them to their default (collapsed).
  const filteringTags = q !== ''

  useEffect(() => {
    if (!filteringTags) setFilterCollapsed([])
  }, [filteringTags])

  const collapsedIds = useMemo(() => {
    if (filteringTags) return filterCollapsed
    return categories.map((category) => category.id).filter((id) => !expandedCategories.includes(id))
  }, [filteringTags, filterCollapsed, expandedCategories, categories])

  const hiddenCategories = useMemo(() => {
    const out = new Set<string>()
    for (const id of collapsedIds) {
      for (const child of categoryDescendants(categories, id)) out.add(child)
    }
    return out
  }, [collapsedIds, categories])

  function isCategoryCollapsed(key: string): boolean {
    // Without categories this is a flat tag list with no header to expand it.
    if (key === 'uncategorized' && !categories.length) return false
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

  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected])
  const allHave = (name: string): boolean =>
    selectedItems.length > 0 && selectedItems.every((i) => i.tags.includes(name))
  const someHave = (name: string): boolean => selectedItems.some((i) => i.tags.includes(name))

  function toggle(name: string): void {
    if (selected.size) {
      if (allHave(name)) void useStore.getState().applyTags([...selected], [], [name])
      else void useStore.getState().applyTags([...selected], [name])
    } else {
      setFocusTag(focusTag === name ? null : name)
    }
  }

  function create(): void {
    const name = q
    if (!name) return
    if (selected.size) {
      void useStore.getState().applyTags([...selected], [name])
    } else {
      void useStore.getState().createTag(name)
    }
    setQuery('')
  }

  const exact = tags.some((t) => t.name === q)

  return (
    <aside className="tagrail">
      <div className="tagrail-head">
        <h2>Tags</h2>
        <span className="count">{tags.length}</span>
        <div className="grow" />
        <button
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => useStore.getState().setTagManagerOpen(true)}
          title="Manage tags"
        >
          <Icon name="settings" size={14} />
        </button>
        <button
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => setTagRailOpen(false)}
          title="Collapse tag panel"
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </div>

      <div className="tagrail-search">
        <Icon name="search" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (filtered.length === 1) toggle(filtered[0].name)
              else if (q) create()
            }
          }}
          placeholder="Find or create a tag"
          spellCheck={false}
        />
      </div>

      {selected.size > 0 ? (
        <div className="tagrail-target">
          <span>
            Applying to {selected.size} item{selected.size === 1 ? '' : 's'}
          </span>
          <span className="muted">click to toggle</span>
        </div>
      ) : focusTag ? (
        <div className="tagrail-target">
          <span>Highlighting #{focusTag}</span>
          <button onClick={() => setFocusTag(null)} style={{ color: 'inherit', display: 'flex' }}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ) : null}

      <div className="tag-list">
        {groups.map((group) => {
          const key = group.id || 'uncategorized'
          // Descendants of a collapsed category disappear with it.
          if (group.id && hiddenCategories.has(group.id)) return null
          const isCollapsed = isCategoryCollapsed(key)
          return (
            <div
              className={cx('tag-group', isCollapsed && 'is-collapsed')}
              key={key}
              data-category-id={group.id}
              data-depth={group.depth}
            >
              {group.name ? (
                <button
                  className="tag-group-head"
                  data-action="tag-category-toggle"
                  data-category-id={group.id}
                  aria-expanded={!isCollapsed}
                  title={`${isCollapsed ? 'Expand' : 'Collapse'} ${group.name}`}
                  onClick={() => toggleCategoryRow(key)}
                  style={{ paddingLeft: `${4 + group.depth * 12}px` }}
                >
                  <Icon
                    className="tag-group-caret"
                    name={isCollapsed ? 'chevronRight' : 'chevronDown'}
                    size={11}
                  />
                  <span className="tag-group-label">{group.name}</span>
                </button>
              ) : null}
              {isCollapsed
                ? null
                : group.tags.map((tag) => {
                    const on = selected.size ? allHave(tag.name) : focusTag === tag.name
                    const partial = selected.size > 0 && !on && someHave(tag.name)
                    return (
                      <button
                        key={tag.id}
                        className={cx('tag-row', on && 'is-on', partial && 'is-partial')}
                        onClick={() => toggle(tag.name)}
                        title={selected.size ? 'Apply to selection' : 'Highlight on canvas'}
                        style={{ paddingLeft: `${9 + group.depth * 12}px` }}
                      >
                        <span
                          className="dot"
                          style={{ background: tag.color ?? tagColor(tag.name) }}
                        />
                        <span className="name">{tag.name}</span>
                        <span className="count">{counts.get(tag.name) ?? 0}</span>
                        {on ? (
                          <span className="tick">
                            <Icon name="check" size={13} />
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
            </div>
          )
        })}

        {!filtered.length && q && !exact ? (
          <button className="tagrail-create" onClick={create}>
            <Icon name="plus" size={13} /> Create <b>{q}</b>
          </button>
        ) : null}

        {!tags.length ? (
          <div style={{ padding: '10px 12px', fontSize: 11.5, color: 'var(--text-4)', lineHeight: 1.6 }}>
            No tags yet. Select a few items and type a tag to start shaping the collection.
          </div>
        ) : null}
      </div>

      <div className="tagrail-foot">
        {selected.size
          ? 'Clicking a tag adds it to the selection. Click again to remove.'
          : 'Click a tag to highlight matching items. Select items first to apply tags.'}
      </div>
    </aside>
  )
}
