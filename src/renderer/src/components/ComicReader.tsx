import { useCallback, useEffect, useMemo, useState } from 'react'
import { fileUrl, thumbUrl } from '@shared/api'
import { useItem, useStore } from '../store'
import { Icon } from './Icon'
import { cx } from '../lib/util'

interface ReaderPage {
  key: string
  src: string
  title: string
}

/**
 * Pages come either from a real comic, or from a duplicate group being
 * compared. The comparison is built entirely in memory: it is never written to
 * the library, so the virtual "comic" cannot show up anywhere.
 */
function useReaderSource(): {
  key: string
  title: string
  pages: ReaderPage[]
  compare: boolean
} | null {
  const id = useStore((s) => s.readerId)
  const item = useItem(id)
  const compareGroup = useStore((s) => s.compareGroup)

  return useMemo(() => {
    if ((item?.kind === 'comic' || item?.kind === 'set') && item.pages?.length) {
      return {
        key: item.id,
        title: item.title,
        compare: false,
        pages: item.pages.map((page, index) => ({
          key: page.file,
          src: fileUrl(page.file),
          title: `${item.title} · page ${index + 1}`
        }))
      }
    }
    if (compareGroup?.items.length) {
      return {
        key: `compare:${compareGroup.id}`,
        title: 'Compare duplicates',
        compare: true,
        pages: compareGroup.items.map((entry) => ({
          key: entry.item.id,
          // A video has no still frame to point at, so show its poster.
          src:
            entry.item.kind === 'video'
              ? thumbUrl(entry.item)
              : fileUrl(entry.item.file),
          title: entry.item.title
        }))
      }
    }
    return null
  }, [item, compareGroup])
}

export function ComicReader(): React.JSX.Element | null {
  const source = useReaderSource()
  const setReader = useStore((s) => s.setReader)
  const setCompareGroup = useStore((s) => s.setCompareGroup)
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex(0)
  }, [source?.key])

  const pages = source?.pages ?? []
  const page = pages[index]
  const compare = !!source?.compare
  const open = !!source

  const close = useCallback(() => {
    setReader(null)
    setCompareGroup(null)
  }, [setReader, setCompareGroup])

  // The reader owns the whole screen: entering window full screen hides the
  // native caption buttons, so the only X on screen is the reader's own.
  // Keyed on the reader being open, not on the specific source.
  useEffect(() => {
    if (!open) return
    void window.vault.setImmersive(true)
    return () => {
      void window.vault.setImmersive(false)
    }
  }, [open])

  useEffect(() => {
    if (!source) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault()
        setIndex((i) => Math.min(pages.length - 1, i + 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        setIndex((i) => Math.max(0, i - 1))
      } else if (e.key === 'Home') setIndex(0)
      else if (e.key === 'End') setIndex(pages.length - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [source, pages.length, close])

  if (!source) return null

  return (
    <div className="reader">
      <div className="reader-bar">
        <span className="title">{source.title}</span>
        {compare && page ? <span className="dim reader-sub">{page.title}</span> : null}
        <div className="grow" />
        <span className="mono">
          {index + 1} / {pages.length}
        </span>
        <button
          className="btn btn-ghost btn-icon btn-sm"
          data-action="reader-close"
          onClick={close}
          title="Close reader (Esc)"
        >
          <Icon name="x" size={16} />
        </button>
      </div>

      <div
        className="reader-stage"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          if (e.clientX - rect.left < rect.width / 2) setIndex((i) => Math.max(0, i - 1))
          else setIndex((i) => Math.min(pages.length - 1, i + 1))
        }}
      >
        {page ? <img src={page.src} alt={page.title} /> : null}
        <button
          className="reader-nav prev"
          onClick={(e) => {
            e.stopPropagation()
            setIndex((i) => Math.max(0, i - 1))
          }}
          disabled={index === 0}
        >
          <Icon name="chevronLeft" size={18} />
        </button>
        <button
          className="reader-nav next"
          onClick={(e) => {
            e.stopPropagation()
            setIndex((i) => Math.min(pages.length - 1, i + 1))
          }}
          disabled={index === pages.length - 1}
        >
          <Icon name="chevronRight" size={18} />
        </button>
      </div>

      <div className="reader-progress">
        <i style={{ width: `${pages.length ? ((index + 1) / pages.length) * 100 : 0}%` }} />
      </div>

      <div className="reader-strip">
        {pages.map((p, i) => (
          <button
            key={p.key}
            className={cx(i === index && 'is-active')}
            onClick={() => setIndex(i)}
            title={p.title}
          >
            <img src={p.src} alt="" loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  )
}
