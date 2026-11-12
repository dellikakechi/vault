import { useCallback, useEffect, useMemo } from 'react'
import { fileUrl } from '@shared/api'
import { useItem, useStore } from '../store'
import { Icon } from './Icon'

/**
 * Full-screen image/GIF viewer opened from the detail preview. The window goes
 * into full screen while it is open, which hides the native caption buttons, so
 * the viewer's own close button is the only X on screen.
 *
 * Left/right cycle through every image and GIF in the active view's current
 * filter, in the same order the view displays them.
 */
export function ImageViewer(): React.JSX.Element | null {
  const id = useStore((s) => s.viewerId)
  const item = useItem(id)
  const lib = useStore((s) => s.lib)
  const viewOrder = useStore((s) => s.viewOrder)
  const setViewer = useStore((s) => s.setViewer)
  const openId = item?.id ?? null
  const open = !!item
  const close = useCallback(() => setViewer(null), [setViewer])

  const candidates = useMemo(() => {
    const items = lib?.items ?? {}
    const seen = new Set<string>()
    const out = []
    for (const candidateId of viewOrder) {
      const candidate = items[candidateId]
      if (!candidate || seen.has(candidateId)) continue
      seen.add(candidateId)
      if (candidate.kind === 'image' || candidate.kind === 'gif') out.push(candidate)
    }
    // Opened from a view that does not publish an order (duplicates, AI):
    // keep the viewer usable with just the open item.
    if (item && !seen.has(item.id)) out.unshift(item)
    return out
  }, [lib?.items, viewOrder, item])

  const index = openId ? candidates.findIndex((candidate) => candidate.id === openId) : -1

  const step = useCallback(
    (delta: number) => {
      if (candidates.length < 2 || index < 0) return
      const next = (index + delta + candidates.length) % candidates.length
      setViewer(candidates[next].id)
    },
    [candidates, index, setViewer]
  )

  // Keyed on the viewer being open, not on the current item: cycling with the
  // arrow keys must not tear down and rebuild the immersive window state.
  useEffect(() => {
    if (!open) return
    void window.vault.setImmersive(true)
    return () => {
      void window.vault.setImmersive(false)
    }
  }, [open])

  useEffect(() => {
    if (!openId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        step(1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        step(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId, close, step])

  if (!item) return null

  const stepable = candidates.length > 1 && index >= 0

  return (
    <div
      className="viewer"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <img src={fileUrl(item.file)} alt={item.title} draggable={false} />

      {stepable ? (
        <>
          <button
            className="reader-nav prev"
            data-action="viewer-prev"
            title="Previous image (←)"
            aria-label="Previous image"
            onClick={() => step(-1)}
          >
            <Icon name="chevronLeft" size={18} />
          </button>
          <button
            className="reader-nav next"
            data-action="viewer-next"
            title="Next image (→)"
            aria-label="Next image"
            onClick={() => step(1)}
          >
            <Icon name="chevronRight" size={18} />
          </button>
        </>
      ) : null}

      <div className="viewer-bar">
        <span className="title">{item.title}</span>
        {stepable ? (
          <span className="mono">
            {index + 1} / {candidates.length}
          </span>
        ) : null}
        {item.width && item.height ? (
          <span className="mono">
            {item.width} × {item.height}
          </span>
        ) : null}
        <div className="grow" />
        <button
          className="btn btn-ghost btn-icon btn-sm"
          data-action="viewer-close"
          onClick={close}
          title="Close (Esc)"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
    </div>
  )
}
