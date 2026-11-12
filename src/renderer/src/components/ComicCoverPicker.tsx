import { useEffect, useState } from 'react'
import { fileUrl } from '@shared/api'
import { useItem, useStore } from '../store'
import { Modal } from './ui'
import { Icon } from './Icon'
import { cx } from '../lib/util'
import { thumbBufferFromUrl } from '../lib/media'

export function ComicCoverPicker(): React.JSX.Element | null {
  const id = useStore((s) => s.coverToolId)
  const item = useItem(id)
  const close = useStore((s) => s.setCoverTool)
  const patchItem = useStore((s) => s.patchItem)
  const toast = useStore((s) => s.toast)
  const [index, setIndex] = useState(() => item?.coverIndex ?? 0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setIndex(item?.coverIndex ?? 0)
  }, [item?.id])

  if (!item) return null
  const pages = item.pages ?? []
  const active = pages[index] ?? pages[0]

  async function apply(): Promise<void> {
    if (!item || !active) return
    setBusy(true)
    try {
      const buf = await thumbBufferFromUrl(fileUrl(active.file))
      const updated = await window.vault.setThumb(item.id, buf, { coverIndex: index })
      if (updated) patchItem(updated)
      toast(item.kind === 'set' ? 'Set cover updated' : 'Comic cover updated', 'success')
      close(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update cover', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      className="wide"
      title="Choose a cover"
      subtitle={`${item.title} · ${pages.length} pages`}
      onClose={() => close(null)}
      footer={
        <>
          <span className="mono">
            Page {index + 1} of {pages.length}
          </span>
          <div className="grow" />
          <button className="btn btn-ghost" onClick={() => close(null)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void apply()} disabled={busy}>
            <Icon name="check" size={14} />
            {busy ? 'Saving…' : 'Use as cover'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="cover-grid">
          {pages.map((page, i) => (
            <button
              key={page.file}
              className={cx('cover-page', i === index && 'is-active')}
              onClick={() => setIndex(i)}
              onDoubleClick={() => {
                setIndex(i)
                void apply()
              }}
            >
              <img src={fileUrl(page.file)} alt="" loading="lazy" />
              <span className="cover-num">{i + 1}</span>
              {item.coverIndex === i ? <span className="cover-current">Current</span> : null}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
