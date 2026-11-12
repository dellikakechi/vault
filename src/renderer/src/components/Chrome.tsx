import { useEffect, useMemo, useRef, useState } from 'react'
import { useItems, useStore } from '../store'
import { cx, tagColor } from '../lib/util'
import { parseQuery, serializeQuery } from '../lib/search'
import { Icon, type IconName } from './Icon'

const NAV: { id: 'inbox' | 'library' | 'duplicates' | 'ai'; label: string; icon: IconName }[] = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'duplicates', label: 'Duplicates', icon: 'duplicates' },
  { id: 'ai', label: 'AI', icon: 'sparkles' }
]

export function IconRail(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const items = useItems()

  const inbox = items.filter((i) => i.inbox).length
  const ai = items.filter((i) => i.aiQueue).length
  const library = items.length
  const counts: Record<string, number> = { inbox, library, ai }

  return (
    <nav className="rail">
      {NAV.map((n) => (
        <button
          key={n.id}
          className={cx('rail-btn', view === n.id && 'is-active')}
          onClick={() => setView(n.id)}
          title={n.label}
        >
          <Icon name={n.icon} />
          <span>{n.label}</span>
          {counts[n.id] ? (
            <em className={cx('rail-badge', n.id === 'ai' && 'ai')}>
              {counts[n.id] > 999 ? '999+' : counts[n.id]}
            </em>
          ) : null}
        </button>
      ))}
      <div className="rail-spacer" />
      <button
        className={cx('rail-btn', view === 'settings' && 'is-active')}
        onClick={() => setView('settings')}
        title="Settings"
      >
        <Icon name="settings" />
        <span>Setup</span>
      </button>
    </nav>
  )
}

export function TitleBar({
  onImport
}: {
  onImport: (kind: 'files' | 'folder') => void
}): React.JSX.Element {
  const lib = useStore((s) => s.lib)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const [menu, setMenu] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const tags = lib?.tags ?? []
  const tagNames = useMemo(() => tags.map((tag) => tag.name), [tags])
  const parsed = useMemo(() => parseQuery(search, tagNames), [search, tagNames])
  const lastToken = /\s$/.test(search) ? '' : (search.trim().split(/\s+/).pop() ?? '')
  const fragment = lastToken.replace(/^!?#?/, '').replace(/^"|"$/g, '').toLowerCase()
  const suggestions = useMemo(
    () =>
      tags
        .filter((tag) => !fragment || tag.name.includes(fragment))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 50),
    [tags, fragment]
  )

  function pick(name: string, exclude: boolean): void {
    const trimmed = search.trimEnd()
    const endsSpace = /\s$/.test(search)
    const lastRaw = trimmed.split(/\s+/).pop() ?? ''
    const lastValue = lastRaw.replace(/^!?#?/, '').replace(/^"|"$/g, '').toLowerCase()
    const complete = !trimmed || endsSpace || tagNames.includes(lastValue)
    const base = complete ? trimmed : search.replace(/!?#?(?:"[^"]*"?|\S*)$/, '').trimEnd()
    const before = parseQuery(base, tagNames)
    const include = before.include.filter((tag) => tag !== name)
    const excluded = before.exclude.filter((tag) => tag !== name)
    const active = exclude ? before.exclude.includes(name) : before.include.includes(name)
    if (!active) (exclude ? excluded : include).push(name)
    const next = serializeQuery({ include, exclude: excluded, terms: before.terms })
    setSearch(next ? `${next} ` : '')
  }

  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [menu])

  return (
    <header className="titlebar">
      <div className="brand">
        <span className="brand-mark" />
        <span className="brand-name">VAULT</span>
      </div>
      <div className="titlebar-sep" />
      <div className="titlebar-lib">
        <Icon name="folder" size={14} />
        <span>{lib?.name ?? 'Library'}</span>
        <span className="path" title={lib?.root}>
          {lib?.root}
        </span>
      </div>
      <div className="titlebar-spacer" />
      <div className="titlebar-search">
        <Icon name="search" size={14} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => setSearchOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setSearchOpen(false)
              e.currentTarget.blur()
            }
          }}
          placeholder="Search  #tag  !tag"
          title="#tag must be included, !tag is excluded, plain text searches titles"
          spellCheck={false}
        />
        {search ? (
          <button
            className="search-clear"
            onClick={() => setSearch('')}
            aria-label="Clear search"
            title="Clear search"
          >
            <Icon name="x" size={11} />
          </button>
        ) : (
          <kbd>Ctrl K</kbd>
        )}
        {searchOpen ? (
          <div className="search-pop" onPointerDown={(e) => e.preventDefault()}>
            <div className="search-pop-help">
              <span>
                <b>#tag</b> include
              </span>
              <span>
                <b>!tag</b> exclude
              </span>
              <span>text searches titles</span>
            </div>
            {suggestions.length ? (
              <div className="search-pop-tags">
                {suggestions.map((tag) => {
                  const included = parsed.include.includes(tag.name)
                  const excluded = parsed.exclude.includes(tag.name)
                  return (
                    <div className="search-pop-row" key={tag.id}>
                      <span className="dot" style={{ background: tag.color ?? tagColor(tag.name) }} />
                      <button
                        className={cx('name', included && 'is-in')}
                        onClick={() => pick(tag.name, false)}
                        title="Include this tag"
                      >
                        {tag.name}
                      </button>
                      <button
                        className={cx('flag', included && 'is-on')}
                        onClick={() => pick(tag.name, false)}
                        title="Include this tag"
                      >
                        #
                      </button>
                      <button
                        className={cx('flag', 'exc', excluded && 'is-on')}
                        onClick={() => pick(tag.name, true)}
                        title="Exclude this tag"
                      >
                        !
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="search-pop-empty">No tags match “{fragment}”</div>
            )}
          </div>
        ) : null}
      </div>
      <div className="add-group" ref={menuRef}>
        <button className="btn btn-primary" onClick={() => onImport('files')}>
          <Icon name="plus" size={15} />
          Add media
        </button>
        <button
          className="btn btn-primary btn-icon"
          onClick={() => setMenu((v) => !v)}
          title="More import options"
        >
          <Icon name="chevronDown" size={14} />
        </button>
        {menu ? (
          <div className="context-menu" style={{ top: 38, right: 0 }}>
            <button
              onClick={() => {
                setMenu(false)
                onImport('files')
              }}
            >
              <Icon name="image" /> Add files…
            </button>
            <button
              onClick={() => {
                setMenu(false)
                onImport('folder')
              }}
            >
              <Icon name="book" /> Add folder as comic…
            </button>
          </div>
        ) : null}
      </div>
    </header>
  )
}
