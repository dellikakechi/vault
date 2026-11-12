import { useMemo, useState } from 'react'
import { thumbUrl } from '@shared/api'
import type { MediaItem } from '@shared/types'
import { useItems, useStore } from '../store'
import { cx, pluralize } from '../lib/util'
import { Icon } from '../components/Icon'

export function AiView(): React.JSX.Element {
  const items = useItems()
  const lib = useStore((s) => s.lib)
  const busy = useStore((s) => s.aiBusy)
  const setBusy = useStore((s) => s.setAiBusy)
  const patchItem = useStore((s) => s.patchItem)
  const mergeItems = useStore((s) => s.mergeItems)
  const setMembership = useStore((s) => s.setMembership)
  const toast = useStore((s) => s.toast)
  const setView = useStore((s) => s.setView)
  const confirmAction = useStore((s) => s.confirmAction)

  const [chosen, setChosen] = useState<Record<string, string[]>>({})
  const [deselected, setDeselected] = useState<Record<string, string[]>>({})
  const [done, setDone] = useState<Set<string>>(new Set())

  const settings = lib?.settings.ai
  // The AI queue is explicit: only items the user sent here are analysed and
  // shown. Applying or accepting tags never removes an item from the queue.
  const queued = useMemo(() => items.filter((i) => i.aiQueue), [items])
  const pending = useMemo(
    () => queued.filter((i) => i.ai?.length && !done.has(i.id)),
    [queued, done]
  )
  const waiting = useMemo(
    () => queued.filter((i) => !i.ai?.length && !done.has(i.id)),
    [queued, done]
  )
  const taggedCount = items.filter((i) => i.tags.length > 0).length

  const useModel = settings?.provider === 'openai' && !!settings.apiKey
  const providerLabel = !settings?.enabled
    ? 'Disabled'
    : settings.provider === 'openai'
      ? settings.model || 'Model'
      : 'Local similarity'

  function tagsFor(item: MediaItem): string[] {
    return chosen[item.id] ?? item.ai?.map((a) => a.tag) ?? []
  }

  function toggleTag(item: MediaItem, tag: string): void {
    const current = tagsFor(item)
    const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]
    setChosen((prev) => ({ ...prev, [item.id]: next }))
    // Remember tags the user explicitly turned off so accepting the rest can
    // record them as negative feedback for this item.
    setDeselected((prev) => {
      const current = new Set(prev[item.id] ?? [])
      if (next.includes(tag)) current.delete(tag)
      else current.add(tag)
      return { ...prev, [item.id]: [...current] }
    })
  }

  async function analyse(ids: string[]): Promise<void> {
    if (!ids.length) {
      toast('The AI queue is empty — send items to AI first', 'info')
      return
    }
    setBusy(true)
    try {
      const results = await window.vault.aiSuggest(ids, useModel)
      const fresh = await window.vault.getLibrary()
      useStore.setState({ lib: fresh })
      setDone((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
      setChosen((prev) => {
        const next = { ...prev }
        for (const id of ids) delete next[id]
        return next
      })
      setDeselected((prev) => {
        const next = { ...prev }
        for (const id of ids) delete next[id]
        return next
      })
      const withSuggestions = results.filter((r) => r.suggestions.length).length
      toast(
        `Analysed ${ids.length} ${pluralize(ids.length, 'item')} · ${withSuggestions} got suggestions`,
        'success'
      )
      const failure = results.find((r) => r.error)
      if (failure?.error) toast(failure.error, 'error')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'AI run failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function run(): Promise<void> {
    await analyse(queued.map((i) => i.id))
  }

  async function accept(item: MediaItem): Promise<void> {
    const tags = tagsFor(item)
    if (!tags.length) return
    const updated = await window.vault.aiAccept(item.id, tags, deselected[item.id] ?? [])
    if (updated) patchItem(updated)
    setDone((prev) => new Set(prev).add(item.id))
    setChosen((prev) => {
      const next = { ...prev }
      delete next[item.id]
      return next
    })
    setDeselected((prev) => {
      const next = { ...prev }
      delete next[item.id]
      return next
    })
  }

  async function reject(item: MediaItem): Promise<void> {
    const res = await window.vault.aiReject([item.id])
    res.forEach(patchItem)
    setDone((prev) => new Set(prev).add(item.id))
    setChosen((prev) => {
      const next = { ...prev }
      delete next[item.id]
      return next
    })
    setDeselected((prev) => {
      const next = { ...prev }
      delete next[item.id]
      return next
    })
  }

  async function acceptAll(): Promise<void> {
    const entries = pending
      .map((item) => ({
        id: item.id,
        tags: (item.ai ?? []).filter((s) => s.score >= 0.85).map((s) => s.tag)
      }))
      .filter((e) => e.tags.length > 0)
    if (!entries.length) {
      toast('No suggestions above 85% confidence', 'info')
      return
    }
    const updated = await window.vault.aiAcceptMany(entries)
    mergeItems(updated)
    setDone((prev) => {
      const next = new Set(prev)
      for (const e of entries) next.add(e.id)
      return next
    })
    setChosen((prev) => {
      const next = { ...prev }
      for (const e of entries) delete next[e.id]
      return next
    })
    setDeselected((prev) => {
      const next = { ...prev }
      for (const e of entries) delete next[e.id]
      return next
    })
    toast(`Accepted ${entries.length} ${pluralize(entries.length, 'item')}`, 'success')
  }

  async function rejectAll(): Promise<void> {
    const ids = pending.map((i) => i.id)
    if (!ids.length) return
    const res = await window.vault.aiReject(ids)
    res.forEach(patchItem)
    setDone((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
    setChosen((prev) => {
      const next = { ...prev }
      for (const id of ids) delete next[id]
      return next
    })
    setDeselected((prev) => {
      const next = { ...prev }
      for (const id of ids) delete next[id]
      return next
    })
    toast(`Rejected ${ids.length} ${pluralize(ids.length, 'suggestion set')}`, 'info')
  }

  async function removeFromQueue(item: MediaItem): Promise<void> {
    await setMembership([item.id], { aiQueue: false })
    setChosen((prev) => {
      const next = { ...prev }
      delete next[item.id]
      return next
    })
    setDeselected((prev) => {
      const next = { ...prev }
      delete next[item.id]
      return next
    })
    setDone((prev) => {
      const next = new Set(prev)
      next.delete(item.id)
      return next
    })
  }

  function removeAll(): void {
    const ids = queued.map((item) => item.id)
    if (!ids.length) return
    confirmAction({
      title: `Remove all ${ids.length} ${pluralize(ids.length, 'item')} from the AI queue?`,
      body: 'The items and their tags stay in the library. This only clears the AI page.',
      confirmLabel: 'Remove all',
      onConfirm: () => {
        void clearQueue(ids)
      }
    })
  }

  async function clearQueue(ids: string[]): Promise<void> {
    await setMembership(ids, { aiQueue: false })
    const removed = new Set(ids)
    setChosen((prev) => {
      const next = { ...prev }
      for (const id of removed) delete next[id]
      return next
    })
    setDone((prev) => {
      const next = new Set(prev)
      for (const id of removed) next.delete(id)
      return next
    })
    setDeselected((prev) => {
      const next = { ...prev }
      for (const id of removed) delete next[id]
      return next
    })
  }

  return (
    <div className="view">
      <div className="view-head">
        <div className="view-title">
          <h1>AI review</h1>
          <span className="sub">
            {queued.length
              ? `${queued.length} queued · ${pending.length} awaiting approval`
              : 'Queue items to review AI suggestions'}
          </span>
        </div>
        <div className="view-actions">
          <span className={cx('badge', settings?.provider === 'openai' ? 'ai' : 'accent')}>
            <Icon name={settings?.provider === 'openai' ? 'sparkles' : 'similar'} size={11} />
            {providerLabel}
          </span>
          <button className="btn" onClick={() => setView('settings')}>
            <Icon name="settings" size={14} />
            Configure
          </button>
          <button
            className="btn btn-ghost"
            data-action="ai-remove-all"
            title="Remove every item from the AI queue"
            onClick={removeAll}
            disabled={!queued.length || busy}
          >
            <Icon name="x" size={14} />
            Remove all
          </button>
          <button
            className="btn btn-ai"
            onClick={() => void run()}
            disabled={busy || !queued.length || !settings?.enabled}
          >
            <Icon name="wand" size={14} />
            {busy ? 'Analysing…' : `Analyse queue (${queued.length})`}
          </button>
        </div>
      </div>

      <div className="lib-scroll">
        {!settings?.enabled ? (
          <EmptyStateBlock
            title="AI tagging is off"
            body="Turn it on in Settings. Local mode needs no account: it learns from the tags you have already applied and never sends anything off this machine."
            action={
              <button className="btn btn-primary" onClick={() => setView('settings')}>
                Open settings
              </button>
            }
          />
        ) : queued.length === 0 ? (
          <EmptyStateBlock
            title="The AI queue is empty"
            body="Select items in the inbox or library and choose Send to AI. Analysis only runs on items you queue, and nothing is applied without your approval."
            action={
              <button className="btn btn-primary" onClick={() => setView('inbox')}>
                Go to inbox
              </button>
            }
          />
        ) : (
          <>
            <div className="ai-note" style={{ marginBottom: 16 }}>
              <Icon name="sparkles" />
              <span>
                {pending.length
                  ? `${pending.length} ${pluralize(pending.length, 'item')} awaiting approval. `
                  : 'No pending suggestions — analyse the queue to get some. '}
                {settings.provider === 'openai'
                  ? `Suggestions come from ${settings.model || 'your model'}, primed with your existing tags. `
                  : `Local mode compared these against your ${taggedCount} tagged ${pluralize(taggedCount, 'item')} using colour, composition and filename. `}
                Accepted items stay in the queue until you remove them.
              </span>
              <div style={{ flex: 1 }} />
              <button className="btn btn-sm btn-ai" onClick={() => void run()} disabled={busy}>
                <Icon name="wand" size={13} />
                {busy ? 'Analysing…' : 'Analyse queue'}
              </button>
              {pending.length ? (
                <>
                  <button className="btn btn-sm" onClick={() => void acceptAll()}>
                    Accept all ≥ 85%
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => void rejectAll()}>
                    Reject all
                  </button>
                </>
              ) : null}
            </div>

            {waiting.length ? (
              <div className="ai-queue">
                <div className="ai-queue-head">
                  <span className="eyebrow">Queued · no pending suggestions</span>
                  <span className="mono">{waiting.length}</span>
                </div>
                <div className="ai-queue-grid">
                  {waiting.map((item) => (
                    <div className="ai-queue-card" key={item.id}>
                      <img src={thumbUrl(item)} alt="" loading="lazy" />
                      <div className="ai-queue-body">
                        <span className="name">{item.title}</span>
                        <span className="meta">
                          {item.aiSource
                            ? `Last analysis: ${item.aiSource === 'model' ? 'model' : 'local'}`
                            : 'Not analysed yet'}
                        </span>
                      </div>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => void analyse([item.id])}
                        disabled={busy}
                      >
                        Analyse
                      </button>
                      <button
                        className="btn btn-ghost btn-icon btn-sm"
                        title="Remove from AI queue"
                        data-action="ai-remove"
                        onClick={() => void removeFromQueue(item)}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {pending.length ? (
              <div className="ai-grid" style={{ marginTop: waiting.length ? 16 : 0 }}>
                {pending.map((item, index) => {
                  const selected = tagsFor(item)
                  return (
                    <div
                      className="ai-card"
                      key={item.id}
                      style={{ animationDelay: `${Math.min(index, 12) * 22}ms` }}
                    >
                      <div className="ai-card-thumb">
                        <img src={thumbUrl(item)} alt="" loading="lazy" />
                        <div className="grad" />
                        <span className="name">{item.title}</span>
                        <button
                          className="ai-card-remove"
                          title="Remove from AI queue"
                          data-action="ai-remove"
                          onClick={() => void removeFromQueue(item)}
                        >
                          <Icon name="x" size={13} />
                        </button>
                      </div>
                      <div className="ai-card-body">
                        {(item.ai ?? []).map((s) => {
                          const on = selected.includes(s.tag)
                          return (
                            <button
                              key={s.tag}
                              className={cx('suggestion', !on && 'is-off')}
                              onClick={() => toggleTag(item, s.tag)}
                            >
                              <span className="tick">{on ? <Icon name="check" size={12} /> : null}</span>
                              <span className="name">{s.tag}</span>
                              <span className="bar">
                                <i style={{ width: `${Math.round(s.score * 100)}%` }} />
                              </span>
                              <span className="pct">{Math.round(s.score * 100)}%</span>
                            </button>
                          )
                        })}
                      </div>
                      <div className="ai-card-foot">
                        <button className="btn btn-sm btn-ghost" onClick={() => void reject(item)}>
                          Reject
                        </button>
                        <button
                          className="btn btn-sm btn-ai"
                          onClick={() => void accept(item)}
                          disabled={!selected.length}
                        >
                          <Icon name="check" size={13} /> Accept
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function EmptyStateBlock({
  title,
  body,
  action
}: {
  title: string
  body: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ai-empty">
      <div className="orb">
        <Icon name="sparkles" size={26} />
      </div>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  )
}
