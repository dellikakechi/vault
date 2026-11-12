import { useEffect, useMemo, useState } from 'react'
import { fileUrl, thumbUrl } from '@shared/api'
import { useItem, useStore } from '../store'
import { cx, formatBytes, formatDate, formatDuration, kindLabel } from '../lib/util'
import { Icon } from './Icon'
import { Toggle } from './ui'
import { thumbBufferFromUrl } from '../lib/media'

export function DetailPanel(): React.JSX.Element | null {
  const detailId = useStore((s) => s.detailId)
  const item = useItem(detailId)
  const lib = useStore((s) => s.lib)
  const setDetail = useStore((s) => s.setDetail)
  const patchItem = useStore((s) => s.patchItem)
  const setMembership = useStore((s) => s.setMembership)
  const toast = useStore((s) => s.toast)
  const setVideoTool = useStore((s) => s.setVideoTool)
  const setCoverTool = useStore((s) => s.setCoverTool)
  const setReader = useStore((s) => s.setReader)
  const setViewer = useStore((s) => s.setViewer)
  const canViewFullscreen = item?.kind === 'image' || item?.kind === 'gif'

  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [busy, setBusy] = useState(false)
  /** The original file can be gone (moved, cleaned up); fall back to the thumb. */
  const [previewFailed, setPreviewFailed] = useState(false)

  useEffect(() => {
    setTitle(item?.title ?? '')
    setNote(item?.note ?? '')
    setTagInput('')
    setPreviewFailed(false)
  }, [item?.id])

  const allTags = useMemo(() => lib?.tags.map((t) => t.name) ?? [], [lib?.tags])

  if (!item) return null

  const isPaged = item.kind === 'comic' || item.kind === 'set'

  async function saveTitle(): Promise<void> {
    if (!item) return
    const next = title.trim()
    if (!next || next === item.title) {
      setTitle(item.title)
      return
    }
    const updated = await window.vault.updateItem(item.id, { title: next })
    if (updated) patchItem(updated)
  }

  async function saveNote(): Promise<void> {
    if (!item) return
    if (note === (item.note ?? '')) return
    const updated = await window.vault.updateItem(item.id, { note })
    if (updated) patchItem(updated)
  }

  function addTag(): void {
    const name = tagInput.trim()
    if (!name) return
    void useStore.getState().applyTags([item!.id], [name])
    setTagInput('')
  }

  async function setCover(index: number): Promise<void> {
    if (!item?.pages?.[index]) return
    setBusy(true)
    try {
      const buf = await thumbBufferFromUrl(fileUrl(item.pages[index].file))
      const updated = await window.vault.setThumb(item.id, buf, { coverIndex: index })
      if (updated) patchItem(updated)
      toast('Cover updated', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update cover', 'error')
    } finally {
      setBusy(false)
    }
  }

  function confirmDelete(): void {
    if (!item) return
    useStore.getState().confirmAction({
      title: `Delete “${item.title}”?`,
      body: 'The file moves to the library trash folder. You can restore it from disk if needed.',
      confirmLabel: 'Move to trash',
      danger: true,
      onConfirm: () => {
        void useStore.getState().deleteItems([item.id])
        setDetail(null)
      }
    })
  }

  const ai = item.ai ?? []
  const pages = item.pages ?? []

  return (
    <aside className="detail">
      <div className="detail-head">
        <span className="badge">{kindLabel(item.kind)}</span>
        {item.linked ? <span className="badge">Linked</span> : null}
        <div className="grow" />
        <button
          className={cx('btn btn-ghost btn-icon btn-sm')}
          title="Favourite"
          onClick={async () => {
            const updated = await window.vault.updateItem(item.id, { favorite: !item.favorite })
            if (updated) patchItem(updated)
          }}
          style={item.favorite ? { color: 'var(--accent)' } : undefined}
        >
          <Icon name="star" size={15} />
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setDetail(null)} title="Close">
          <Icon name="x" size={15} />
        </button>
      </div>

      <div className="detail-scroll">
        <div
          className="detail-preview"
          onDoubleClick={() => {
            if (canViewFullscreen) setViewer(item.id)
          }}
        >
          {item.kind === 'video' ? (
            <video
              src={fileUrl(item.file)}
              controls
              loop
              preload="auto"
              poster={thumbUrl(item)}
              onError={() => setPreviewFailed(true)}
            />
          ) : (
            <img
              src={previewFailed || isPaged ? thumbUrl(item) : fileUrl(item.file)}
              alt={item.title}
              onError={() => {
                if (!previewFailed) setPreviewFailed(true)
              }}
            />
          )}
          {previewFailed && !isPaged ? (
            <span className="detail-preview-note">Original file missing — showing thumbnail</span>
          ) : null}
          {isPaged ? (
            <button className="btn btn-primary btn-sm cover-open" onClick={() => setReader(item.id)}>
              <Icon name="book" size={14} /> Read {item.kind === 'set' ? 'image set' : 'comic'}
            </button>
          ) : null}
          {canViewFullscreen ? (
            <button
              className="btn btn-icon btn-sm preview-fullscreen"
              data-action="detail-fullscreen"
              title="Full screen"
              aria-label="Full screen"
              onClick={() => setViewer(item.id)}
            >
              <Icon name="fit" size={14} />
            </button>
          ) : null}
        </div>

        <div className="detail-body">
          <input
            className="detail-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            spellCheck={false}
          />

          <div className="detail-meta">
            <div className="meta-cell">
              <span className="k">Type</span>
              <span className="v">{kindLabel(item.kind)}</span>
            </div>
            <div className="meta-cell">
              <span className="k">Size</span>
              <span className="v">{formatBytes(item.bytes)}</span>
            </div>
            <div className="meta-cell">
              <span className="k">{item.kind === 'video' ? 'Duration' : 'Dimensions'}</span>
              <span className="v">
                {item.kind === 'video'
                  ? formatDuration(item.durationMs)
                  : `${item.width || '—'} × ${item.height || '—'}`}
              </span>
            </div>
            <div className="meta-cell">
              <span className="k">Added</span>
              <span className="v">{formatDate(item.addedAt)}</span>
            </div>
            {isPaged ? (
              <div className="meta-cell">
                <span className="k">Pages</span>
                <span className="v">{pages.length}</span>
              </div>
            ) : null}
            {item.kind === 'video' && item.thumbCustom ? (
              <div className="meta-cell">
                <span className="k">Thumbnail</span>
                <span className="v">Uploaded image</span>
              </div>
            ) : item.thumbTimeMs !== undefined && item.kind === 'video' ? (
              <div className="meta-cell">
                <span className="k">Poster frame</span>
                <span className="v">{(item.thumbTimeMs / 1000).toFixed(2)}s</span>
              </div>
            ) : null}
            <div className="meta-cell" style={{ gridColumn: '1 / -1' }}>
              <span className="k">File</span>
              <span className="v" title={item.file}>
                {item.file.split(/[\\/]/).pop()}
              </span>
            </div>
          </div>

          <div className="detail-section">
            <div className="detail-section-head">
              <span className="eyebrow">Tags</span>
              <div className="grow" />
              {item.tags.length ? (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void useStore.getState().applyTags([item.id], [], item.tags)}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <div className="tag-editor">
              {item.tags.map((tag) => (
                <span className="chip" key={tag}>
                  {tag}
                  <button
                    onClick={() => void useStore.getState().applyTags([item.id], [], [tag])}
                    aria-label={`Remove ${tag}`}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addTag()
                  }
                }}
                placeholder={item.tags.length ? 'Add tag…' : 'Add the first tag…'}
                list="vault-tag-list"
                spellCheck={false}
              />
              <datalist id="vault-tag-list">
                {allTags.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="detail-section">
            <div className="detail-section-head">
              <span className="eyebrow">Queues</span>
            </div>
            <div className="queue-list">
              <div className="queue-row">
                <span className="queue-icon">
                  <Icon name="inbox" size={14} />
                </span>
                <div className="queue-copy">
                  <b>Inbox</b>
                  <span>Keep this item on the inbox canvas</span>
                </div>
                <Toggle
                  on={!!item.inbox}
                  onChange={(v) => void setMembership([item.id], { inbox: v })}
                />
              </div>
              <div className="queue-row">
                <span className="queue-icon ai">
                  <Icon name="sparkles" size={14} />
                </span>
                <div className="queue-copy">
                  <b>AI queue</b>
                  <span>Include this item in AI analysis</span>
                </div>
                <Toggle
                  ai
                  on={!!item.aiQueue}
                  onChange={(v) => void setMembership([item.id], { aiQueue: v })}
                />
              </div>
            </div>
          </div>

          {ai.length ? (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="eyebrow" style={{ color: 'var(--ai)' }}>
                  AI suggestions
                </span>
                <div className="grow" />
                <button
                  className="btn btn-sm btn-ai"
                  onClick={async () => {
                    const updated = await window.vault.aiAccept(
                      item.id,
                      ai.map((a) => a.tag)
                    )
                    if (updated) patchItem(updated)
                    toast('Suggestions accepted', 'success')
                  }}
                >
                  Accept all
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={async () => {
                    const res = await window.vault.aiReject([item.id])
                    res.forEach(patchItem)
                  }}
                >
                  Reject
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {ai.map((s) => (
                  <span className="chip is-ai" key={s.tag}>
                    {s.tag}
                    <span className="mono" style={{ color: 'inherit', opacity: 0.7 }}>
                      {Math.round(s.score * 100)}%
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {isPaged && pages.length ? (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="eyebrow">Pages</span>
                <span className="mono">{pages.length}</span>
                <div className="grow" />
                <button className="btn btn-sm" onClick={() => setCoverTool(item.id)}>
                  <Icon name="image" size={13} /> Cover picker
                </button>
              </div>
              <div className="page-strip">
                {pages.slice(0, 18).map((page, i) => (
                  <button
                    key={page.file}
                    className={cx(item.coverIndex === i && 'is-cover')}
                    onClick={() => void setCover(i)}
                    title={`Use page ${i + 1} as cover`}
                    disabled={busy}
                  >
                    <img src={fileUrl(page.file)} alt="" loading="lazy" />
                    <span>{i + 1}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="detail-actions">
            {isPaged ? (
              <>
                <button className="btn" onClick={() => setReader(item.id)}>
                  <Icon name="book" size={14} /> Read
                </button>
                <button className="btn" onClick={() => setCoverTool(item.id)}>
                  <Icon name="image" size={14} /> Set cover
                </button>
              </>
            ) : null}
            {item.kind === 'video' ? (
              <button className="btn" onClick={() => setVideoTool(item.id)}>
                <Icon name="frame" size={14} /> Pick thumbnail frame
              </button>
            ) : null}
            <button className="btn" onClick={() => void window.vault.reveal(item.id)}>
              <Icon name="folder" size={14} /> Show in Explorer
            </button>
            <button className="btn btn-danger" onClick={confirmDelete}>
              <Icon name="trash" size={14} /> Delete
            </button>
          </div>

          <div className="detail-section">
            <div className="detail-section-head">
              <span className="eyebrow">Notes</span>
            </div>
            <textarea
              className="input"
              rows={3}
              placeholder="Anything worth remembering…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => void saveNote()}
            />
          </div>
        </div>
      </div>
    </aside>
  )
}
