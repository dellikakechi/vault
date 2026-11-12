import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { MediaItem } from '@shared/types'
import { fileUrl, thumbUrl } from '@shared/api'
import { layoutItems, type ArrangeMode, type Placement } from '../lib/arrange'
import { runConversion } from '../lib/convertRunner'
import { clamp, cx, formatDuration } from '../lib/util'
import { useStore } from '../store'
import { Icon, type IconName } from './Icon'
import { SmoothLoopVideo } from './SmoothLoopVideo'

const MODES: { value: ArrangeMode; label: string; icon: IconName }[] = [
  { value: 'scatter', label: 'Scatter', icon: 'shuffle' },
  { value: 'grid', label: 'Grid', icon: 'grid' },
  { value: 'hue', label: 'Colour', icon: 'palette' },
  { value: 'similar', label: 'Similar', icon: 'similar' },
  { value: 'time', label: 'Time', icon: 'clock' }
]

const MODE_KEY = 'vault:arrange-mode'

function loadMode(): ArrangeMode {
  const saved = localStorage.getItem(MODE_KEY)
  return MODES.some((m) => m.value === saved) ? (saved as ArrangeMode) : 'scatter'
}

export function InboxCanvas({
  items,
  focusTag,
  base
}: {
  items: MediaItem[]
  focusTag: string | null
  base: number
}): React.JSX.Element {
  const selected = useStore((s) => s.selected)
  const lib = useStore((s) => s.lib)
  const setDetail = useStore((s) => s.setDetail)
  const manual = useStore((s) => s.manual)
  const updateManual = useStore((s) => s.updateManual)
  const lastBatch = useStore((s) => s.lastBatch)
  const clearLastBatch = useStore((s) => s.clearLastBatch)

  const [mode, setMode] = useState<ArrangeMode>(loadMode)
  const [viewport, setViewport] = useState({ x: 80, y: 110, zoom: 0.82 })
  const [size, setSize] = useState({ w: 1200, h: 800 })
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [space, setSpace] = useState(false)
  const [panning, setPanning] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const spaceRef = useRef(false)
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const marqueeRef = useRef<{ sx: number; sy: number } | null>(null)
  const dragRef = useRef<{
    ids: string[]
    sx: number
    sy: number
    origins: Record<string, { x: number; y: number }>
    moved: boolean
    tileId: string
    additive: boolean
  } | null>(null)

  const layout = useMemo(() => layoutItems(items, mode, base), [items, mode, base])

  const positions = useMemo(() => {
    const map = new Map(layout.placements)
    for (const [id, p] of Object.entries(manual)) {
      // Auto-placed import batches only keep their own region on the free canvas.
      if (p.scatterOnly && mode !== 'scatter') continue
      const existing = map.get(id)
      if (existing) map.set(id, { ...existing, x: p.x, y: p.y })
    }
    return map
  }, [layout, manual, mode])

  const positionsRef = useRef(positions)
  positionsRef.current = positions

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode)
  }, [mode])

  // Measure the canvas.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    setSize({ w: r.width, h: r.height })
    return () => ro.disconnect()
  }, [])

  const contentBounds = useMemo(() => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of positions.values()) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + p.w)
      maxY = Math.max(maxY, p.y + p.h)
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }, [positions])

  const fit = useCallback(() => {
    const b = contentBounds
    const { w, h } = size
    if (!b.w || !b.h || !w) return
    const zoom = clamp(Math.min((w - 150) / b.w, (h - 190) / b.h), 0.22, 1.1)
    setViewport({
      zoom,
      x: (w - b.w * zoom) / 2 - b.x * zoom,
      y: Math.max(84, (h - b.h * zoom) / 2 - b.y * zoom + 20)
    })
  }, [contentBounds, size])

  const didFit = useRef(false)
  useEffect(() => {
    if (!items.length) {
      didFit.current = false
      return
    }
    if (!didFit.current && size.w > 0) {
      didFit.current = true
      requestAnimationFrame(fit)
    }
  }, [items.length, size.w, fit])

  // A newly placed import batch should be on screen, not somewhere off to the
  // right where the user has to hunt for it.
  const revealedBatch = useRef<number | null>(null)
  useEffect(() => {
    if (!lastBatch || !size.w) return
    if (revealedBatch.current === lastBatch.at) return
    const ids = lastBatch.ids.filter((id) => lib?.items[id]?.inbox)
    if (!ids.length) {
      clearLastBatch()
      return
    }
    const placed = ids
      .map((id) => positions.get(id))
      .filter((p): p is Placement => !!p)
    if (placed.length !== ids.length) return
    revealedBatch.current = lastBatch.at
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of placed) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + p.w)
      maxY = Math.max(maxY, p.y + p.h)
    }
    const w = Math.max(maxX - minX, 1)
    const h = Math.max(maxY - minY, 1)
    const zoom = clamp(
      Math.min((size.w - 180) / w, (size.h - 240) / h),
      0.24,
      0.9
    )
    setViewport({
      zoom,
      x: (size.w - w * zoom) / 2 - minX * zoom,
      y: Math.max(84, (size.h - h * zoom) / 2 - minY * zoom + 20)
    })
    clearLastBatch()
  }, [lastBatch, positions, size, lib, clearLastBatch])

  const prevMode = useRef(mode)
  useEffect(() => {
    if (prevMode.current !== mode) {
      prevMode.current = mode
      requestAnimationFrame(fit)
    }
  }, [mode, fit])

  // Space-to-pan
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      e.preventDefault()
      spaceRef.current = true
      setSpace(true)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        spaceRef.current = false
        setSpace(false)
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const el = wrapRef.current
    const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0 }
    const v = viewportRef.current
    return { x: (clientX - rect.left - v.x) / v.zoom, y: (clientY - rect.top - v.y) / v.zoom }
  }, [])

  // Wheel: pan by default, zoom with ctrl/cmd.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        setViewport((v) => {
          const next = clamp(v.zoom * Math.exp(-e.deltaY * 0.0022), 0.14, 3)
          const k = next / v.zoom
          return { zoom: next, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k }
        })
      } else {
        setViewport((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const zoomAtCenter = useCallback((factor: number) => {
    setViewport((v) => {
      const next = clamp(v.zoom * factor, 0.14, 3)
      const k = next / v.zoom
      const cx0 = size.w / 2
      const cy0 = size.h / 2
      return { zoom: next, x: cx0 - (cx0 - v.x) * k, y: cy0 - (cy0 - v.y) * k }
    })
  }, [size])

  function onBackgroundPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button === 1 || e.button === 2 || spaceRef.current) {
      panRef.current = {
        sx: e.clientX,
        sy: e.clientY,
        ox: viewportRef.current.x,
        oy: viewportRef.current.y
      }
      setPanning(true)
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    const world = screenToWorld(e.clientX, e.clientY)
    marqueeRef.current = { sx: world.x, sy: world.y }
    setMarquee({ x: world.x, y: world.y, w: 0, h: 0 })
    if (!e.shiftKey) useStore.getState().clearSelection()
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (panRef.current) {
      const p = panRef.current
      setViewport((v) => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }))
      return
    }
    if (marqueeRef.current) {
      const world = screenToWorld(e.clientX, e.clientY)
      const { sx, sy } = marqueeRef.current
      const rect = {
        x: Math.min(sx, world.x),
        y: Math.min(sy, world.y),
        w: Math.abs(world.x - sx),
        h: Math.abs(world.y - sy)
      }
      setMarquee(rect)
      if (rect.w > 2 || rect.h > 2) {
        const hits: string[] = []
        for (const [id, p] of positionsRef.current) {
          if (
            p.x < rect.x + rect.w &&
            p.x + p.w > rect.x &&
            p.y < rect.y + rect.h &&
            p.y + p.h > rect.y
          ) {
            hits.push(id)
          }
        }
        useStore.getState().select(hits, 'replace')
      }
    }
  }

  function onPointerUp(): void {
    panRef.current = null
    marqueeRef.current = null
    setPanning(false)
    setMarquee(null)
  }

  function onTilePointerDown(e: React.PointerEvent, item: MediaItem): void {
    if (e.button !== 0 || spaceRef.current) return
    e.stopPropagation()
    const store = useStore.getState()
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    if (additive) {
      store.select([item.id], 'toggle')
      return
    }
    const isSelected = store.selected.has(item.id)
    if (!isSelected) store.select([item.id], 'replace')
    const ids = isSelected ? [...store.selected] : [item.id]
    const origins: Record<string, { x: number; y: number }> = {}
    for (const id of ids) {
      const p = positionsRef.current.get(id)
      if (p) origins[id] = { x: p.x, y: p.y }
    }
    dragRef.current = {
      ids,
      sx: e.clientX,
      sy: e.clientY,
      origins,
      moved: false,
      tileId: item.id,
      additive
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onTilePointerMove(e: React.PointerEvent): void {
    const d = dragRef.current
    if (!d) return
    const dx = (e.clientX - d.sx) / viewportRef.current.zoom
    const dy = (e.clientY - d.sy) / viewportRef.current.zoom
    if (!d.moved && Math.hypot(dx, dy) < 3) return
    d.moved = true
    const updates: Record<string, { x: number; y: number }> = {}
    for (const id of d.ids) {
      const o = d.origins[id]
      if (o) updates[id] = { x: o.x + dx, y: o.y + dy }
    }
    updateManual(updates)
  }

  function onTilePointerUp(e: React.PointerEvent, item: MediaItem): void {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (!d.moved) {
      if (useStore.getState().selected.size > 1 && !d.additive) {
        useStore.getState().select([item.id], 'replace')
      }
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const visible = useMemo(() => {
    const v = viewport
    const pad = 240
    const left = -v.x / v.zoom - pad
    const top = -v.y / v.zoom - pad
    const right = left + size.w / v.zoom + pad * 2
    const bottom = top + size.h / v.zoom + pad * 2
    return items.filter((item) => {
      const p = positions.get(item.id)
      return p && p.x < right && p.x + p.w > left && p.y < bottom && p.y + p.h > top
    })
  }, [items, positions, viewport, size])

  const visibleClusters = useMemo(() => {
    const v = viewport
    const pad = 200
    const left = -v.x / v.zoom - pad
    const top = -v.y / v.zoom - pad
    const right = left + size.w / v.zoom + pad * 2
    const bottom = top + size.h / v.zoom + pad * 2
    return layout.clusters.filter(
      (c) => c.x < right && c.x + c.w > left && c.y < bottom && c.y + c.h > top
    )
  }, [layout.clusters, viewport, size])

  const selectedCount = selected.size
  const [tagText, setTagText] = useState('')
  const selectedItems = [...selected]
    .map((id) => lib?.items[id])
    .filter((item): item is MediaItem => !!item)
  const allAi = selectedItems.length > 0 && selectedItems.every((i) => i.aiQueue)
  const anyTags = selectedItems.some((i) => i.tags.length > 0)
  const canCreateSet =
    selectedItems.length >= 2 &&
    selectedItems.every((i) => i.kind === 'image' || i.kind === 'gif')

  function applyQuickTag(e: React.FormEvent): void {
    e.preventDefault()
    const name = tagText.trim()
    if (!name || !selectedCount) return
    void useStore.getState().applyTags([...selected], [name])
    setTagText('')
  }

  async function removeFromInbox(): Promise<void> {
    const ids = [...selected]
    if (!ids.length) return
    await useStore.getState().setMembership(ids, { inbox: false })
    useStore.getState().clearSelection()
  }

  function confirmDelete(): void {
    const ids = [...selected]
    if (!ids.length) return
    useStore.getState().confirmAction({
      title: `Delete ${ids.length} item${ids.length === 1 ? '' : 's'}?`,
      body: 'Files are moved to the library trash folder, so you can recover them from disk if needed.',
      confirmLabel: 'Move to trash',
      danger: true,
      onConfirm: () => void useStore.getState().deleteItems(ids)
    })
  }

  return (
    <div
      ref={wrapRef}
      className={cx('canvas-wrap', space && 'is-space', panning && 'is-panning')}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="canvas-bg" />
      <div
        className="canvas-dots"
        style={{
          backgroundSize: `${44 * viewport.zoom}px ${44 * viewport.zoom}px`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`
        }}
      />

      <div
        className="canvas-world"
        style={{
          transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`
        }}
      >
        {visibleClusters.map((c) => (
          <div
            key={c.id}
            className="cluster"
            data-accent={c.accent}
            style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
          >
            <div className="cluster-label">{c.label}</div>
          </div>
        ))}

        {visible.map((item) => {
          const p = positions.get(item.id)!
          const isSelected = selected.has(item.id)
          const dimmed = !!focusTag && !item.tags.includes(focusTag)
          return (
            <div
              key={item.id}
              data-id={item.id}
              className={cx('tile', isSelected && 'is-selected', dimmed && 'is-dimmed')}
              style={{
                left: p.x,
                top: p.y,
                width: p.w,
                height: p.h,
                transform: p.rot ? `rotate(${p.rot}deg)` : undefined
              }}
              onPointerDown={(e) => onTilePointerDown(e, item)}
              onPointerMove={onTilePointerMove}
              onPointerUp={(e) => onTilePointerUp(e, item)}
              onDoubleClick={() => setDetail(item.id)}
              title={item.title}
            >
              <TileMedia item={item} />
              {item.kind === 'comic' || item.kind === 'set' ? <div className="tile-stack" /> : null}
              {isSelected ? (
                <span className="tile-check">
                  <Icon name="check" size={12} />
                </span>
              ) : (
                <span className="tile-kind">
                  <Icon
                    name={
                      item.kind === 'video'
                        ? 'film'
                        : item.kind === 'comic'
                          ? 'book'
                          : item.kind === 'set'
                            ? 'grid'
                            : item.kind === 'gif'
                              ? 'layers'
                              : 'image'
                    }
                    size={12}
                  />
                </span>
              )}
              {item.ai?.length ? <span className="tile-ai">AI</span> : null}
              {item.kind === 'comic' || item.kind === 'set' ? (
                <span className="tile-pages">{item.pages?.length ?? 0}p</span>
              ) : null}
              <div className="tile-caption">
                <span className="tile-title">{item.title}</span>
                <span className="tile-meta">
                  {item.kind === 'video'
                    ? formatDuration(item.durationMs)
                    : item.width && item.height
                      ? `${item.width}×${item.height}`
                      : ''}
                </span>
              </div>
            </div>
          )
        })}

        {marquee && marquee.w > 1 && marquee.h > 1 ? (
          <div
            className="marquee"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="empty" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <div className="empty-inner">
            <div className="empty-icon">
              <Icon name="inbox" />
            </div>
            <h2>The inbox is clear</h2>
            <p>
              Items you import land here first. Tag them as you go — they stay here until you
              remove them. Drag files anywhere in the window, or use “Add media” to start building
              the collection.
            </p>
          </div>
        </div>
      ) : null}

      <div className="canvas-title">
        <h1>Inbox</h1>
        <span className="count">
          {items.length} in inbox {focusTag ? `· filtered by #${focusTag}` : ''}
        </span>
      </div>

      <div className="canvas-top-right" onPointerDown={(e) => e.stopPropagation()}>
        {focusTag ? (
          <button
            className="btn btn-sm btn-ghost"
            style={{ background: 'rgba(217,255,74,.1)', color: 'var(--accent)' }}
            onClick={() => useStore.getState().setFocusTag(null)}
          >
            <Icon name="x" size={12} /> #{focusTag}
          </button>
        ) : null}
        <div className="zoom-pill">
          <button onClick={() => zoomAtCenter(1 / 1.18)} title="Zoom out">
            <Icon name="zoomOut" size={14} />
          </button>
          <span>{Math.round(viewport.zoom * 100)}%</span>
          <button onClick={() => zoomAtCenter(1.18)} title="Zoom in">
            <Icon name="zoomIn" size={14} />
          </button>
          <button onClick={fit} title="Fit to view">
            <Icon name="fit" size={14} />
          </button>
        </div>
      </div>

      <div className="canvas-hint">
        <span>
          <Kbd>Drag</Kbd> arrange
        </span>
        <span>
          <Kbd>Space</Kbd> pan
        </span>
        <span>
          <Kbd>Ctrl</Kbd>
          <Kbd>wheel</Kbd> zoom
        </span>
        <span>
          <Kbd>Double-click</Kbd> open
        </span>
      </div>

      {selectedCount > 0 ? (
        <div className="selection-dock" onPointerDown={(e) => e.stopPropagation()}>
          <span className="count">{selectedCount} selected</span>
          <span className="sep" />
          <form onSubmit={applyQuickTag} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="tag" size={13} />
            <input
              className="input"
              style={{ height: 28, width: 168, background: '#08080a' }}
              placeholder="Tag, then Enter"
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              autoFocus
            />
          </form>
          <button
            className={cx('btn btn-sm btn-ghost', allAi && 'is-on')}
            data-action="inbox-ai"
            title={
              allAi
                ? 'Remove selected items from the AI queue'
                : 'Send selected items to the AI queue'
            }
            onClick={() =>
              void useStore.getState().setMembership([...selected], { aiQueue: !allAi })
            }
          >
            <Icon name={allAi ? 'check' : 'sparkles'} size={13} />
            {allAi ? 'Remove from AI' : 'Send to AI'}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            data-action="inbox-clear-tags"
            disabled={!anyTags}
            title="Remove every tag from the selected items"
            onClick={() => void useStore.getState().clearTags([...selected])}
          >
            <Icon name="tag" size={13} /> Clear tags
          </button>
          <button
            className="btn btn-sm btn-ghost"
            data-action="inbox-convert"
            title="Convert selected images and comic pages to lossless WebP"
            onClick={() => void runConversion([...selected])}
          >
            <Icon name="refresh" size={13} /> Convert
          </button>
          <button
            className="btn btn-sm btn-ghost"
            data-action="inbox-create-set"
            disabled={!canCreateSet}
            title="Turn the selected images into a paged image set"
            onClick={() => void useStore.getState().createImageSet([...selected])}
          >
            <Icon name="grid" size={13} /> Make image set
          </button>
          <button
            className="btn btn-sm btn-ghost"
            data-action="inbox-remove"
            title="Remove selected items from the inbox"
            onClick={() => void removeFromInbox()}
          >
            <Icon name="x" size={13} /> Remove from inbox
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => useStore.getState().clearSelection()}
          >
            Clear
          </button>
          <button className="btn btn-sm btn-danger" onClick={confirmDelete}>
            <Icon name="trash" size={13} /> Delete
          </button>
        </div>
      ) : null}

      <div className="seg arrange-dock" onPointerDown={(e) => e.stopPropagation()}>
        {MODES.map((m) => (
          <button
            key={m.value}
            className={cx(mode === m.value && 'is-active')}
            onClick={() => setMode(m.value)}
          >
            <Icon name={m.icon} />
            {m.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <kbd>{children}</kbd>
}

function TileMedia({ item }: { item: MediaItem }): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const enter = (): void => {
    if (item.kind !== 'video' && item.kind !== 'gif') return
    timer.current = setTimeout(() => setHover(true), 260)
  }
  const leave = (): void => {
    if (timer.current) clearTimeout(timer.current)
    setHover(false)
  }

  return (
    <div
      className="tile-media"
      onPointerEnter={enter}
      onPointerLeave={leave}
      style={{ background: item.color ? `rgb(${item.color.join(',')})` : undefined }}
    >
      <img src={thumbUrl(item)} alt="" draggable={false} decoding="async" />
      {hover && item.kind === 'gif' ? (
        <img className="tile-anim" src={fileUrl(item.file)} alt="" draggable={false} />
      ) : null}
      {hover && item.kind === 'video' ? (
        <SmoothLoopVideo
          src={fileUrl(item.file)}
          poster={thumbUrl(item)}
          startAt={(item.thumbTimeMs ?? 0) / 1000}
        />
      ) : null}
    </div>
  )
}
