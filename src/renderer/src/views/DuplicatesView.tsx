import { useEffect, useMemo, useRef, useState } from 'react'
import type { DuplicateGroup } from '@shared/types'
import { thumbUrl } from '@shared/api'
import { useStore } from '../store'
import { cx, formatBytes, formatDate, pluralize } from '../lib/util'
import { Icon } from '../components/Icon'
import { EmptyState } from '../components/ui'

function defaultKeep(g: DuplicateGroup): string[] {
  return g.items.filter((e) => e.suggested === 'keep').map((e) => e.item.id)
}

function kindLabel(g: DuplicateGroup): string {
  if (g.kind === 'identical') return 'identical copies'
  if (g.kind === 'mixed') return 'copies + variations'
  return 'minor variations'
}

export function DuplicatesView(): React.JSX.Element {
  const lib = useStore((s) => s.lib)
  const dupes = useStore((s) => s.dupes)
  const loading = useStore((s) => s.dupesLoading)
  const findDupes = useStore((s) => s.findDupes)
  const updateSettings = useStore((s) => s.updateSettings)
  const deleteItems = useStore((s) => s.deleteItems)
  const confirmAction = useStore((s) => s.confirmAction)
  const setCompareGroup = useStore((s) => s.setCompareGroup)

  const [threshold, setThreshold] = useState(lib?.settings.duplicateThreshold ?? 6)
  /** Per-group keep choices. Missing groups fall back to the suggested set. */
  const [keep, setKeep] = useState<Record<string, string[]>>({})
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  // Always scan when the view opens and whenever the collection grows or
  // shrinks, so new imports are never left unchecked.
  const itemCount = lib ? Object.keys(lib.items).length : 0
  const scannedCount = useRef(-1)
  useEffect(() => {
    if (itemCount === scannedCount.current) return
    scannedCount.current = itemCount
    void findDupes(useStore.getState().lib?.settings.duplicateThreshold ?? 6)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemCount])

  const groups = useMemo(
    () => (dupes ?? []).filter((g) => !dismissed.has(g.id)),
    [dupes, dismissed]
  )

  const keepSetOf = (g: DuplicateGroup): string[] => keep[g.id] ?? defaultKeep(g)

  const reclaimable = useMemo(() => {
    let n = 0
    for (const g of groups) {
      const kept = new Set(keepSetOf(g))
      for (const e of g.items) if (!kept.has(e.item.id)) n += e.item.bytes
    }
    return n
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, keep])

  function commitThreshold(v: number): void {
    if (v === (lib?.settings.duplicateThreshold ?? 6)) return
    void updateSettings({ duplicateThreshold: v })
    setKeep({})
    setDismissed(new Set())
    void findDupes(v)
  }

  function toggleKeep(g: DuplicateGroup, id: string): void {
    setKeep((prev) => {
      const current = prev[g.id] ?? defaultKeep(g)
      const next = current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id]
      return { ...prev, [g.id]: next }
    })
  }

  function resolveGroup(g: DuplicateGroup): void {
    const kept = new Set(keepSetOf(g))
    const ids = g.items.filter((e) => !kept.has(e.item.id)).map((e) => e.item.id)
    if (!ids.length) {
      // Everything is kept: resolving just signs the group off.
      setDismissed((prev) => new Set(prev).add(g.id))
      useStore
        .getState()
        .toast(`Kept all ${g.items.length} ${pluralize(g.items.length, 'copy')}`, 'success')
      return
    }
    const bytes = g.items
      .filter((e) => !kept.has(e.item.id))
      .reduce((n, e) => n + e.item.bytes, 0)
    confirmAction({
      title: `Delete ${ids.length} ${pluralize(ids.length, 'copy')}?`,
      body:
        kept.size === 0
          ? `This group will lose every copy. ${formatBytes(bytes)} will be reclaimed; files move to the library trash folder.`
          : `${formatBytes(bytes)} will be reclaimed. ${kept.size} ${pluralize(kept.size, 'copy')} kept. Files move to the library trash folder.`,
      confirmLabel: 'Delete copies',
      danger: true,
      onConfirm: () => {
        void deleteItems(ids).then(() => {
          setDismissed((prev) => new Set(prev).add(g.id))
          void findDupes(threshold)
        })
      }
    })
  }

  return (
    <div className="view">
      <div className="view-head">
        <div className="view-title">
          <h1>Duplicates</h1>
          <span className="sub">
            {loading
              ? 'Scanning the collection…'
              : `${groups.length} ${pluralize(groups.length, 'group')} · ${formatBytes(reclaimable)} reclaimable`}
          </span>
        </div>
        <div className="view-actions">
          <div className="threshold">
            <label>Similarity</label>
            <input
              type="range"
              min={0}
              max={16}
              step={1}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              onPointerUp={() => commitThreshold(threshold)}
              onKeyUp={() => commitThreshold(threshold)}
            />
            <span className="val">{threshold}</span>
          </div>
          <button className="btn" onClick={() => void findDupes(threshold)} disabled={loading}>
            <Icon name="refresh" size={14} className={loading ? 'spin' : undefined} />
            Rescan
          </button>
        </div>
      </div>

      <div className="dupes-summary">
        <div className="stat">
          <span className="v">{groups.length}</span>
          <span className="k">Groups</span>
        </div>
        <div className="stat">
          <span className="v">{groups.reduce((n, g) => n + g.items.length, 0)}</span>
          <span className="k">Items</span>
        </div>
        <div className="stat">
          <span className="v">{formatBytes(reclaimable)}</span>
          <span className="k">Reclaimable</span>
        </div>
      </div>

      {!groups.length ? (
        <EmptyState
          icon="duplicates"
          title={loading ? 'Scanning…' : 'No duplicates found'}
          action={
            <button className="btn" onClick={() => void findDupes(threshold)} style={{ marginTop: 6 }}>
              <Icon name="refresh" size={14} /> Scan again
            </button>
          }
        >
          {loading
            ? 'Comparing perceptual hashes and colour signatures across the collection.'
            : 'Nothing looks alike at this sensitivity. Loosen the similarity threshold to catch near-identical crops, re-encodes and small edits.'}
        </EmptyState>
      ) : (
        <div className="dupe-scroll">
          {groups.map((g) => {
            const kept = keepSetOf(g)
            const keptSet = new Set(kept)
            const drops = g.items.filter((e) => !keptSet.has(e.item.id))
            const groupBytes = drops.reduce((n, e) => n + e.item.bytes, 0)
            return (
              <div className="dupe-group" key={g.id} data-kind={g.kind}>
                <div className="dupe-group-head">
                  <Icon name="duplicates" size={14} />
                  <span>
                    {g.items.length} similar {pluralize(g.items.length, 'item')}
                  </span>
                  <span className="dupe-kind">{kindLabel(g)}</span>
                  <span className="dim">·</span>
                  <span>{formatBytes(groupBytes)} reclaimable</span>
                  <div className="grow" />
                  <button
                    className="btn btn-sm btn-ghost"
                    data-action="dupe-compare"
                    title="Read the copies like a comic, page by page"
                    onClick={() => setCompareGroup(g)}
                  >
                    <Icon name="book" size={13} /> Compare
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    data-action="dupe-resolve"
                    title={
                      drops.length
                        ? 'Delete the copies marked for removal'
                        : 'Keep everything and finish this group'
                    }
                    onClick={() => resolveGroup(g)}
                  >
                    Resolve
                  </button>
                </div>
                <div className="dupe-items">
                  {g.items.map((entry) => {
                    const isKeep = keptSet.has(entry.item.id)
                    return (
                      <div
                        key={entry.item.id}
                        className={cx('dupe-card', isKeep ? 'is-keep' : 'is-drop')}
                        data-id={entry.item.id}
                        title={isKeep ? 'Click to mark for deletion' : 'Click to keep'}
                        onClick={() => toggleKeep(g, entry.item.id)}
                      >
                        <div className="dupe-thumb">
                          <img src={thumbUrl(entry.item)} alt="" loading="lazy" />
                          <span className={cx('dupe-flag', isKeep ? 'keep' : 'drop')}>
                            {isKeep ? 'Keep' : 'Delete'}
                          </span>
                        </div>
                        <div className="dupe-info">
                          <div className="dupe-name" title={entry.item.title}>
                            {entry.item.title}
                          </div>
                          <div className="dupe-meta">
                            {entry.item.width}×{entry.item.height} · {formatBytes(entry.item.bytes)}
                          </div>
                          <div className="dupe-meta">
                            {entry.item.id === g.keep && g.kind !== 'identical'
                              ? 'reference copy'
                              : entry.identical
                                ? 'identical file'
                                : entry.distance === 0
                                  ? 'same artwork'
                                  : `variation · ${entry.distance} bits`}{' '}
                            · {formatDate(entry.item.addedAt)}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
