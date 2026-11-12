import { useEffect, useMemo, useRef, useState } from 'react'
import type { Tag, TagCategory } from '@shared/types'
import { useStore, useTagCounts } from '../store'
import { cx, pluralize, tagColor } from '../lib/util'
import {
  buildCategoryTree,
  categoryDescendants,
  flattenCategoryTree,
  type CategoryNode
} from '../lib/categories'
import { Modal } from './ui'
import { Icon } from './Icon'

export function TagManager(): React.JSX.Element | null {
  const open = useStore((s) => s.tagManagerOpen)
  const lib = useStore((s) => s.lib)
  const setOpen = useStore((s) => s.setTagManagerOpen)
  const renameTag = useStore((s) => s.renameTag)
  const deleteTag = useStore((s) => s.deleteTag)
  const createTag = useStore((s) => s.createTag)
  const createCategory = useStore((s) => s.createCategory)
  const moveCategory = useStore((s) => s.moveCategory)
  const renameCategory = useStore((s) => s.renameCategory)
  const deleteCategory = useStore((s) => s.deleteCategory)
  const setTagCategory = useStore((s) => s.setTagCategory)
  const confirmAction = useStore((s) => s.confirmAction)
  const expandedCategories = useStore((s) => s.expandedCategories)
  const toggleCategoryExpanded = useStore((s) => s.toggleCategoryExpanded)
  const counts = useTagCounts()

  const [query, setQuery] = useState('')
  /** Categories the user collapsed while the tag filter is active. */
  const [filterCollapsed, setFilterCollapsed] = useState<string[]>([])
  const [draftName, setDraftName] = useState('')
  const [categoryDraft, setCategoryDraft] = useState('')
  const [categoryParent, setCategoryParent] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editingCatId, setEditingCatId] = useState<string | null>(null)
  const [catDraft, setCatDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const categoryInputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef(false)
  const committingRef = useRef<string | null>(null)
  const catCancelRef = useRef(false)
  const catCommittingRef = useRef<string | null>(null)

  const categories = useMemo(() => [...(lib?.categories ?? [])], [lib?.categories])
  const tree = useMemo(() => buildCategoryTree(categories), [categories])
  const flatCategories = useMemo(() => flattenCategoryTree(tree), [tree])

  const tags = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...(lib?.tags ?? [])]
      .filter((tag) => !q || tag.name.includes(q))
      .sort(
        (a, b) =>
          (counts.get(b.name) ?? 0) - (counts.get(a.name) ?? 0) ||
          a.name.localeCompare(b.name)
      )
  }, [lib?.tags, query, counts])

  const tagsByCategory = useMemo(() => {
    const known = new Set(categories.map((category) => category.id))
    const buckets = new Map<string, Tag[]>()
    for (const tag of tags) {
      const key = tag.categoryId && known.has(tag.categoryId) ? tag.categoryId : ''
      const list = buckets.get(key)
      if (list) list.push(tag)
      else buckets.set(key, [tag])
    }
    return buckets
  }, [categories, tags])

  // When filtering, keep the ancestors of every matching tag so the tree
  // still has context, but hide unrelated branches.
  const visibleCategoryIds = useMemo(() => {
    if (!query.trim()) return null
    const byId = new Map(categories.map((category) => [category.id, category]))
    const visible = new Set<string>()
    for (const tag of tags) {
      const seen = new Set<string>()
      let id = tag.categoryId
      while (id && byId.has(id) && !seen.has(id)) {
        visible.add(id)
        seen.add(id)
        id = byId.get(id)?.parentId
      }
    }
    return visible
  }, [categories, query, tags])

  // Filtering tags opens every category temporarily; clearing the filter
  // returns them to their default (collapsed).
  const filteringTags = query.trim() !== ''

  useEffect(() => {
    if (!filteringTags) setFilterCollapsed([])
  }, [filteringTags])

  function isCategoryCollapsed(id: string): boolean {
    // With no categories there is no tree at all, just a flat tag list. Keep it
    // visible: it has no header the user could click to expand it again.
    if (id === 'uncategorized' && !categories.length) return false
    if (filteringTags) return filterCollapsed.includes(id)
    return !expandedCategories.includes(id)
  }

  function toggleCategoryRow(id: string): void {
    if (filteringTags) {
      setFilterCollapsed((current) =>
        current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
      )
    } else {
      toggleCategoryExpanded(id)
    }
  }

  if (!open) return null

  function close(): void {
    setEditingId(null)
    setEditingCatId(null)
    setQuery('')
    setCategoryParent('')
    setOpen(false)
  }

  function start(tag: Tag): void {
    cancelRef.current = false
    setEditingId(tag.id)
    setDraft(tag.name)
  }

  async function commit(tag: Tag): Promise<void> {
    if (committingRef.current === tag.id) return
    if (cancelRef.current) {
      cancelRef.current = false
      setEditingId(null)
      return
    }
    const next = draft.trim()
    if (!next || next === tag.name) {
      setEditingId(null)
      return
    }
    committingRef.current = tag.id
    setEditingId(null)
    setSaving(true)
    try {
      await renameTag(tag.id, next)
    } catch (err) {
      useStore
        .getState()
        .toast(err instanceof Error ? err.message : 'Could not rename tag', 'error')
    } finally {
      committingRef.current = null
      setSaving(false)
    }
  }

  function askDelete(tag: Tag): void {
    const n = counts.get(tag.name) ?? 0
    confirmAction({
      title: `Delete #${tag.name}?`,
      body: `This removes the tag from ${n} ${pluralize(n, 'item')}. The items themselves stay in the library.`,
      confirmLabel: 'Delete tag',
      danger: true,
      onConfirm: () => {
        if (editingId === tag.id) setEditingId(null)
        void deleteTag(tag.id)
      }
    })
  }

  function startCategory(category: TagCategory): void {
    catCancelRef.current = false
    setEditingCatId(category.id)
    setCatDraft(category.name)
  }

  async function commitCategory(category: TagCategory): Promise<void> {
    if (catCommittingRef.current === category.id) return
    if (catCancelRef.current) {
      catCancelRef.current = false
      setEditingCatId(null)
      return
    }
    const next = catDraft.trim()
    if (!next || next === category.name) {
      setEditingCatId(null)
      return
    }
    catCommittingRef.current = category.id
    setEditingCatId(null)
    setSaving(true)
    try {
      await renameCategory(category.id, next)
    } catch (err) {
      useStore
        .getState()
        .toast(err instanceof Error ? err.message : 'Could not rename category', 'error')
    } finally {
      catCommittingRef.current = null
      setSaving(false)
    }
  }

  function askDeleteCategory(category: TagCategory, count: number): void {
    const children = categories.filter((candidate) => candidate.parentId === category.id)
    const childNote = children.length
      ? ` Its ${children.length} ${pluralize(children.length, 'child category', 'child categories')} move up one level.`
      : ''
    confirmAction({
      title: `Delete category “${category.name}”?`,
      body: `${count ? `${count} ${pluralize(count, 'tag')} will move to the parent category or become uncategorized. ` : 'This empty category will be removed. '}Tags and items are kept.${childNote}`,
      confirmLabel: 'Delete category',
      danger: true,
      onConfirm: () => {
        if (editingCatId === category.id) setEditingCatId(null)
        void deleteCategory(category.id)
      }
    })
  }

  function startChild(category: TagCategory): void {
    setCategoryParent(category.id)
    categoryInputRef.current?.focus()
  }

  function parentChoices(category?: TagCategory): CategoryNode[] {
    if (!category) return flatCategories
    const blocked = categoryDescendants(categories, category.id)
    return flatCategories.filter(
      (node) => node.category.id !== category.id && !blocked.has(node.category.id)
    )
  }

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const name = draftName.trim()
    if (!name) return
    await createTag(name)
    setDraftName('')
  }

  async function addCategory(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const name = categoryDraft.trim()
    if (!name) return
    await createCategory(name, categoryParent || null)
    setCategoryDraft('')
    setCategoryParent('')
  }

  function renderCategory(node: CategoryNode): React.JSX.Element | null {
    const category = node.category
    if (visibleCategoryIds && !visibleCategoryIds.has(category.id)) return null
    const groupTags = tagsByCategory.get(category.id) ?? []
    const editing = editingCatId === category.id
    const isCollapsed = isCategoryCollapsed(category.id)
    return (
      <div
        className="tag-manager-group"
        key={category.id}
        data-category-id={category.id}
        data-depth={node.depth}
        data-parent-id={category.parentId ?? ''}
      >
        <div className="tag-manager-group-head">
          <button
            className="tag-manager-caret"
            data-action="tag-category-toggle"
            data-category-id={category.id}
            aria-expanded={!isCollapsed}
            title={`${isCollapsed ? 'Expand' : 'Collapse'} ${category.name}`}
            onClick={() => toggleCategoryRow(category.id)}
          >
            <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} />
          </button>
          <Icon name="layers" size={12} />
          {editing ? (
            <input
              className="input tag-manager-cat-input"
              value={catDraft}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setCatDraft(e.target.value)}
              onBlur={() => void commitCategory(category)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commitCategory(category)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  catCancelRef.current = true
                  setEditingCatId(null)
                }
              }}
              spellCheck={false}
            />
          ) : (
            <span className="tag-manager-group-name">{category.name}</span>
          )}
          <span className="tag-manager-group-count">
            {groupTags.length} {pluralize(groupTags.length, 'tag')}
          </span>
          {!editing ? (
            <select
              className="input tag-manager-cat-parent"
              value={category.parentId ?? ''}
              title="Move this category under another category"
              onChange={(e) => void moveCategory(category.id, e.target.value || null)}
            >
              <option value="">Top level</option>
              {parentChoices(category).map((choice) => (
                <option key={choice.category.id} value={choice.category.id}>
                  {'— '.repeat(choice.depth)}
                  {choice.category.name}
                </option>
              ))}
            </select>
          ) : null}
          <div className="tag-manager-group-actions">
            {editing ? (
              <>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  title="Save category name"
                  disabled={saving}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => void commitCategory(category)}
                >
                  <Icon name="check" size={12} />
                </button>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  title="Cancel"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => {
                    catCancelRef.current = true
                    setEditingCatId(null)
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  title={`Add a child category under ${category.name}`}
                  onClick={() => startChild(category)}
                >
                  <Icon name="plus" size={12} />
                </button>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  title={`Rename category ${category.name}`}
                  onClick={() => startCategory(category)}
                >
                  <Icon name="edit" size={12} />
                </button>
                <button
                  className="btn btn-ghost btn-icon btn-sm tag-manager-delete"
                  title={`Delete category ${category.name}`}
                  onClick={() => askDeleteCategory(category, groupTags.length)}
                >
                  <Icon name="trash" size={12} />
                </button>
              </>
            )}
          </div>
        </div>

        {isCollapsed ? null : (
          <>
        <div className="tag-manager-tags">
          {groupTags.map((tag) => {
            const tagEditing = editingId === tag.id
            const count = counts.get(tag.name) ?? 0
            return (
              <div
                className={cx('tag-manager-row', tagEditing && 'is-editing')}
                key={tag.id}
                data-tag-id={tag.id}
              >
                <span className="dot" style={{ background: tag.color ?? tagColor(tag.name) }} />
                {tagEditing ? (
                  <input
                    className="input tag-manager-input"
                    value={draft}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => void commit(tag)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commit(tag)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelRef.current = true
                        setEditingId(null)
                      }
                    }}
                    spellCheck={false}
                  />
                ) : (
                  <span className="name">{tag.name}</span>
                )}
                <span className="count">
                  {count} {pluralize(count, 'item')}
                </span>
                {!tagEditing ? (
                  <select
                    className="input tag-manager-category"
                    value={tag.categoryId ?? ''}
                    title="Move tag to a category"
                    onChange={(e) => void setTagCategory(tag.id, e.target.value || null)}
                  >
                    <option value="">No category</option>
                    {flatCategories.map((choice) => (
                      <option key={choice.category.id} value={choice.category.id}>
                        {'— '.repeat(choice.depth)}
                        {choice.category.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <div className="actions">
                  {tagEditing ? (
                    <>
                      <button
                        className="btn btn-ghost btn-icon btn-sm"
                        title="Save name"
                        disabled={saving}
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => void commit(tag)}
                      >
                        <Icon name="check" size={13} />
                      </button>
                      <button
                        className="btn btn-ghost btn-icon btn-sm"
                        title="Cancel"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => {
                          cancelRef.current = true
                          setEditingId(null)
                        }}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn btn-ghost btn-icon btn-sm"
                        title={`Rename #${tag.name}`}
                        onClick={() => start(tag)}
                      >
                        <Icon name="edit" size={13} />
                      </button>
                      <button
                        className="btn btn-ghost btn-icon btn-sm tag-manager-delete"
                        title={`Delete #${tag.name}`}
                        onClick={() => askDelete(tag)}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {!groupTags.length && !node.children.length ? (
          <div className="tag-manager-group-empty">No tags in this category yet.</div>
        ) : null}

        {node.children.length ? (
          <div className="tag-manager-children">
            {node.children.map((child) => renderCategory(child))}
          </div>
        ) : null}
          </>
        )}
      </div>
    )
  }

  const loose = tagsByCategory.get('') ?? []

  return (
    <Modal
      className="tag-manager"
      title="Manage tags"
      subtitle={`${lib?.tags.length ?? 0} ${pluralize(lib?.tags.length ?? 0, 'tag')} · ${categories.length} ${pluralize(categories.length, 'category')} · renaming updates every item`}
      onClose={close}
      footer={
        <>
          <span className="mono" style={{ color: 'var(--text-4)' }}>
            {tags.length} shown
          </span>
          <div className="grow" />
          <button className="btn btn-ghost" onClick={close}>
            Done
          </button>
        </>
      }
    >
      <div className="modal-body">
        <form className="tag-manager-new" onSubmit={(e) => void create(e)}>
          <Icon name="tag" size={14} />
          <input
            className="input"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Create a new tag"
            spellCheck={false}
          />
          <button className="btn btn-sm" disabled={!draftName.trim()}>
            <Icon name="plus" size={13} /> Add
          </button>
        </form>

        <form className="tag-manager-new tag-manager-new-category" onSubmit={(e) => void addCategory(e)}>
          <Icon name="layers" size={14} />
          <input
            ref={categoryInputRef}
            className="input"
            value={categoryDraft}
            onChange={(e) => setCategoryDraft(e.target.value)}
            placeholder="New category name"
            spellCheck={false}
          />
          <select
            className="input tag-manager-cat-parent tag-manager-create-parent"
            value={categoryParent}
            title="Create the category inside another category"
            onChange={(e) => setCategoryParent(e.target.value)}
          >
            <option value="">Top level</option>
            {flatCategories.map((node) => (
              <option key={node.category.id} value={node.category.id}>
                {'— '.repeat(node.depth)}
                {node.category.name}
              </option>
            ))}
          </select>
          <button className="btn btn-sm" disabled={!categoryDraft.trim()}>
            <Icon name="plus" size={13} /> Add category
          </button>
        </form>

        <div className="tag-manager-filter">
          <Icon name="search" size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tags"
            spellCheck={false}
          />
        </div>

        <div className="tag-manager-list">
          {tree.map((node) => renderCategory(node))}

          {loose.length || !categories.length ? (
            <div className="tag-manager-group" data-category-id="" data-depth="0">
              {categories.length ? (
                <div className="tag-manager-group-head">
                  <button
                    className="tag-manager-caret"
                    data-action="tag-category-toggle"
                    data-category-id=""
                    aria-expanded={!isCategoryCollapsed('uncategorized')}
                    title={`${isCategoryCollapsed('uncategorized') ? 'Expand' : 'Collapse'} Uncategorized`}
                    onClick={() => toggleCategoryRow('uncategorized')}
                  >
                    <Icon
                      name={isCategoryCollapsed('uncategorized') ? 'chevronRight' : 'chevronDown'}
                      size={12}
                    />
                  </button>
                  <Icon name="layers" size={12} />
                  <span className="tag-manager-group-name">Uncategorized</span>
                  <span className="tag-manager-group-count">
                    {loose.length} {pluralize(loose.length, 'tag')}
                  </span>
                </div>
              ) : null}
              {isCategoryCollapsed('uncategorized') ? null : (
              <div className="tag-manager-tags">
                {loose.map((tag) => {
                  const tagEditing = editingId === tag.id
                  const count = counts.get(tag.name) ?? 0
                  return (
                    <div
                      className={cx('tag-manager-row', tagEditing && 'is-editing')}
                      key={tag.id}
                      data-tag-id={tag.id}
                    >
                      <span className="dot" style={{ background: tag.color ?? tagColor(tag.name) }} />
                      {tagEditing ? (
                        <input
                          className="input tag-manager-input"
                          value={draft}
                          autoFocus
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => void commit(tag)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              void commit(tag)
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              cancelRef.current = true
                              setEditingId(null)
                            }
                          }}
                          spellCheck={false}
                        />
                      ) : (
                        <span className="name">{tag.name}</span>
                      )}
                      <span className="count">
                        {count} {pluralize(count, 'item')}
                      </span>
                      {!tagEditing ? (
                        <select
                          className="input tag-manager-category"
                          value={tag.categoryId ?? ''}
                          title="Move tag to a category"
                          onChange={(e) => void setTagCategory(tag.id, e.target.value || null)}
                        >
                          <option value="">No category</option>
                          {flatCategories.map((choice) => (
                            <option key={choice.category.id} value={choice.category.id}>
                              {'— '.repeat(choice.depth)}
                              {choice.category.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <div className="actions">
                        {tagEditing ? (
                          <>
                            <button
                              className="btn btn-ghost btn-icon btn-sm"
                              title="Save name"
                              disabled={saving}
                              onPointerDown={(e) => e.preventDefault()}
                              onClick={() => void commit(tag)}
                            >
                              <Icon name="check" size={13} />
                            </button>
                            <button
                              className="btn btn-ghost btn-icon btn-sm"
                              title="Cancel"
                              onPointerDown={(e) => e.preventDefault()}
                              onClick={() => {
                                cancelRef.current = true
                                setEditingId(null)
                              }}
                            >
                              <Icon name="x" size={13} />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn btn-ghost btn-icon btn-sm"
                              title={`Rename #${tag.name}`}
                              onClick={() => start(tag)}
                            >
                              <Icon name="edit" size={13} />
                            </button>
                            <button
                              className="btn btn-ghost btn-icon btn-sm tag-manager-delete"
                              title={`Delete #${tag.name}`}
                              onClick={() => askDelete(tag)}
                            >
                              <Icon name="trash" size={13} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              )}
            </div>
          ) : null}

          {!tags.length ? (
            <div className="tag-manager-empty">
              {lib?.tags.length
                ? 'No tags match that filter.'
                : 'No tags yet. Create one above, or tag items from the inbox.'}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
