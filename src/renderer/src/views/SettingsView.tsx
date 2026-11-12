import { useEffect, useState } from 'react'
import type { AiEvaluation, AiTestResult, AppInfo, TrashInfo } from '@shared/types'
import { useStore } from '../store'
import { formatBytes, pluralize } from '../lib/util'
import { Icon } from '../components/Icon'
import { Toggle } from '../components/ui'

export function SettingsView(): React.JSX.Element | null {
  const lib = useStore((s) => s.lib)
  const updateSettings = useStore((s) => s.updateSettings)
  const hydrate = useStore((s) => s.hydrate)
  const toast = useStore((s) => s.toast)
  const confirmAction = useStore((s) => s.confirmAction)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [trash, setTrash] = useState<TrashInfo | null>(null)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<AiTestResult | null>(null)
  const [evaluating, setEvaluating] = useState(false)
  const [evaluation, setEvaluation] = useState<AiEvaluation | null>(null)

  useEffect(() => {
    void window.vault.info().then(setInfo)
    void window.vault.trashInfo().then(setTrash)
  }, [lib?.root])

  if (!lib) return null
  const s = lib.settings
  const ai = s.ai

  async function changeRoot(): Promise<void> {
    const next = await window.vault.chooseRoot()
    if (next) {
      hydrate(next)
      toast('Library switched', 'success')
    }
  }

  function confirmEmptyTrash(): void {
    if (!trash?.files) return
    confirmAction({
      title: 'Empty trash?',
      body: `${trash.files} ${pluralize(trash.files, 'file')} (${formatBytes(trash.bytes)}) will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Delete forever',
      danger: true,
      onConfirm: () => {
        void (async () => {
          try {
            const removed = await window.vault.emptyTrash()
            const after = await window.vault.trashInfo()
            setTrash(after)
            if (removed.files) {
              const noun = pluralize(removed.files, 'file')
              toast(
                `Deleted ${removed.files} ${noun} (${formatBytes(removed.bytes)})`,
                'success'
              )
            } else {
              toast('Trash was already empty', 'info')
            }
            if (after.files) {
              toast(
                `${after.files} ${pluralize(after.files, 'file')} could not be deleted — still open elsewhere?`,
                'error'
              )
            }
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Could not empty trash', 'error')
          }
        })()
      }
    })
  }

  async function runTest(): Promise<void> {
    setTesting(true)
    setTest(null)
    try {
      const res = await window.vault.aiTest()
      setTest(res)
    } finally {
      setTesting(false)
    }
  }

  async function runEvaluation(): Promise<void> {
    setEvaluating(true)
    try {
      const res = await window.vault.aiEvaluate()
      setEvaluation(res)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Accuracy check failed', 'error')
    } finally {
      setEvaluating(false)
    }
  }

  return (
    <div className="view">
      <div className="view-head">
        <div className="view-title">
          <h1>Settings</h1>
          <span className="sub">Storage, tagging and the shape of the interface</span>
        </div>
        <div className="view-actions">
          <span className="mono">{lib.root}</span>
        </div>
      </div>

      <div className="settings-scroll">
        <div className="settings-inner">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Library</h2>
                <p>Everything lives in a normal folder you own. Back it up like any other directory.</p>
              </div>
            </div>
            <div className="field">
              <label>Location</label>
              <div className="field-row">
                <input className="input mono" value={lib.root} readOnly />
                <button className="btn" onClick={() => void changeRoot()}>
                  Change…
                </button>
                <button className="btn" onClick={() => void window.vault.openRoot()}>
                  <Icon name="folder" size={14} /> Open
                </button>
              </div>
              <span className="help">
                Files are copied into <span className="mono">media/</span>, thumbnails into{' '}
                <span className="mono">thumbs/</span>, and deletions into{' '}
                <span className="mono">trash/</span>.
              </span>
            </div>
            <div className="field">
              <label>Trash</label>
              <div className="field-row">
                <span className="help" style={{ flex: 1 }}>
                  {trash && trash.files > 0
                    ? `${trash.files} ${pluralize(trash.files, 'file')} · ${formatBytes(trash.bytes)} waiting to be permanently deleted.`
                    : 'Empty. Deleted and replaced files land here first.'}
                </span>
                <button
                  className="btn btn-danger"
                  data-action="empty-trash"
                  disabled={!trash || trash.files === 0}
                  title="Permanently delete everything in the trash folder"
                  onClick={confirmEmptyTrash}
                >
                  <Icon name="trash" size={14} /> Empty trash
                </button>
              </div>
            </div>
            <div className="dupes-summary" style={{ padding: 0, gap: 30 }}>
              <div className="stat">
                <span className="v">{info?.stats.items ?? 0}</span>
                <span className="k">Items</span>
              </div>
              <div className="stat">
                <span className="v">{info?.stats.tags ?? 0}</span>
                <span className="k">Tags</span>
              </div>
              <div className="stat">
                <span className="v">{formatBytes(info?.stats.bytes ?? 0)}</span>
                <span className="k">On disk</span>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Importing</h2>
                <p>How new files enter the vault.</p>
              </div>
            </div>
            <div className="toggle-row">
              <div className="text">
                <b>Copy files into the library</b>
                <span>
                  Recommended. Originals stay untouched. Turn this off to reference files where they
                  already live — deletions will only remove the library record.
                </span>
              </div>
              <Toggle
                on={s.copyOnImport}
                onChange={(v) => void updateSettings({ copyOnImport: v })}
              />
            </div>
            <div className="divider" />
            <div className="toggle-row">
              <div className="text">
                <b>Auto-tag on import</b>
                <span>Queue new items for AI review as soon as they land.</span>
              </div>
              <Toggle
                on={s.autoTagOnImport}
                onChange={(v) => void updateSettings({ autoTagOnImport: v })}
              />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Duplicate detection</h2>
                <p>
                  Perceptual hashes catch re-encodes, crops and resizes — not just identical files.
                </p>
              </div>
            </div>
            <div className="field">
              <label>Similarity tolerance · {s.duplicateThreshold}</label>
              <div className="field-row">
                <span className="help">Strict</span>
                <input
                  type="range"
                  min={0}
                  max={16}
                  step={1}
                  value={s.duplicateThreshold}
                  onChange={(e) => void updateSettings({ duplicateThreshold: Number(e.target.value) })}
                  style={{ flex: 1, accentColor: 'var(--accent)' }}
                />
                <span className="help">Loose</span>
              </div>
              <span className="help">
                Lower is stricter. 4–8 catches most re-saves; above 10 expect false positives.
              </span>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div style={{ flex: 1 }}>
                <h2>AI tagging</h2>
                <p>Suggestions are always reviewed by you before they become tags.</p>
              </div>
              <Toggle
                ai
                on={ai.enabled}
                onChange={(v) => void updateSettings({ ai: { ...ai, enabled: v } })}
              />
            </div>

            <div className="field">
              <label>Engine</label>
              <div className="seg-wide">
                <button
                  className={ai.provider === 'local' ? 'is-active' : ''}
                  onClick={() => void updateSettings({ ai: { ...ai, provider: 'local' } })}
                >
                  Local similarity
                </button>
                <button
                  className={ai.provider === 'openai' ? 'is-active' : ''}
                  onClick={() => void updateSettings({ ai: { ...ai, provider: 'openai' } })}
                >
                  Vision model
                </button>
              </div>
              <span className="help">
                Local mode compares colour, composition and filename against your existing tags —
                fully offline. Vision mode sends the thumbnail and your tag vocabulary to an
                OpenAI-compatible endpoint.
              </span>
            </div>

            {ai.provider === 'openai' ? (
              <>
                <div className="field">
                  <label>Endpoint</label>
                  <input
                    className="input mono"
                    defaultValue={ai.baseUrl}
                    onBlur={(e) => void updateSettings({ ai: { ...ai, baseUrl: e.target.value.trim() } })}
                    placeholder="https://api.openai.com/v1"
                  />
                  <span className="help">Any OpenAI-compatible base URL, including local servers.</span>
                </div>
                <div className="field">
                  <label>Model</label>
                  <input
                    className="input mono"
                    defaultValue={ai.model}
                    onBlur={(e) => void updateSettings({ ai: { ...ai, model: e.target.value.trim() } })}
                    placeholder="gpt-4o-mini"
                  />
                </div>
                <div className="field">
                  <label>API key</label>
                  <input
                    className="input mono"
                    type="password"
                    defaultValue={ai.apiKey}
                    onBlur={(e) => void updateSettings({ ai: { ...ai, apiKey: e.target.value.trim() } })}
                    placeholder="sk-…"
                  />
                  <span className="help">
                    Stored locally in <span className="mono">library.json</span>. Never sent anywhere
                    except your chosen endpoint.
                  </span>
                </div>
                <div className="field">
                  <div className="field-row">
                    <button className="btn" onClick={() => void runTest()} disabled={testing}>
                      <Icon name="refresh" size={14} />
                      {testing ? 'Testing…' : 'Test connection'}
                    </button>
                  </div>
                  {test ? (
                    <div className={`test-result ${test.ok ? 'ok' : 'err'}`}>{test.message}</div>
                  ) : null}
                </div>
              </>
            ) : null}

            <div className="field">
              <label>Minimum confidence · {Math.round(ai.minScore * 100)}%</label>
              <input
                type="range"
                min={0.3}
                max={0.95}
                step={0.05}
                value={ai.minScore}
                onChange={(e) => void updateSettings({ ai: { ...ai, minScore: Number(e.target.value) } })}
                style={{ accentColor: 'var(--ai)' }}
              />
              <span className="help">Suggestions below this score are discarded.</span>
            </div>

            <div className="field">
              <label>Maximum suggestions per item · {ai.maxTags}</label>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={ai.maxTags}
                onChange={(e) => void updateSettings({ ai: { ...ai, maxTags: Number(e.target.value) } })}
                style={{ accentColor: 'var(--ai)' }}
              />
            </div>

            <div className="divider" />

            <div className="field">
              <label>Local accuracy check</label>
              <div className="field-row">
                <button className="btn" onClick={() => void runEvaluation()} disabled={evaluating}>
                  <Icon name="sparkles" size={14} />
                  {evaluating ? 'Checking…' : 'Check local accuracy'}
                </button>
                <span className="help" style={{ margin: 0 }}>
                  Hides each item’s own tags, predicts them again, and compares.
                </span>
              </div>
              {evaluation ? (
                <div className="ai-eval">
                  <div className="ai-eval-stats">
                    <div className="stat">
                      <span className="v">{Math.round(evaluation.precision * 100)}%</span>
                      <span className="k">Precision</span>
                    </div>
                    <div className="stat">
                      <span className="v">{Math.round(evaluation.recall * 100)}%</span>
                      <span className="k">Recall</span>
                    </div>
                    <div className="stat">
                      <span className="v">{Math.round(evaluation.f1 * 100)}%</span>
                      <span className="k">F1</span>
                    </div>
                    <div className="stat">
                      <span className="v">{evaluation.items}</span>
                      <span className="k">Checked</span>
                    </div>
                  </div>
                  <span className="help">
                    Leave-one-out result at {Math.round(evaluation.threshold * 100)}% confidence.
                    Precision is how many suggestions were right; recall is how many real tags were
                    found. Raise confidence to improve precision, lower it to improve recall.
                  </span>
                  {evaluation.suggestedThreshold !== evaluation.threshold ? (
                    <div className="field-row">
                      <button
                        className="btn"
                        onClick={() =>
                          void updateSettings({
                            ai: { ...ai, minScore: evaluation.suggestedThreshold }
                          })
                        }
                      >
                        Use {Math.round(evaluation.suggestedThreshold * 100)}% confidence
                      </button>
                      <span className="help" style={{ margin: 0 }}>
                        Best F1 ({Math.round(evaluation.suggestedF1 * 100)}%) on this library.
                      </span>
                    </div>
                  ) : (
                    <span className="help">
                      Your current threshold is the best measured trade-off.
                    </span>
                  )}
                  {evaluation.perTag.length ? (
                    <div className="ai-eval-tags">
                      {evaluation.perTag.slice(0, 8).map((metric) => (
                        <div className="ai-eval-tag" key={metric.tag}>
                          <span className="name">#{metric.tag}</span>
                          <span className="mono">
                            {Math.round(metric.precision * 100)}% precise ·{' '}
                            {Math.round(metric.recall * 100)}% found · {metric.support} examples
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Canvas</h2>
                <p>How large items appear in the inbox and the library grid.</p>
              </div>
            </div>
            <div className="field">
              <label>Tile size · {s.tileSize}px</label>
              <input
                type="range"
                min={140}
                max={320}
                step={10}
                value={s.tileSize}
                onChange={(e) => void updateSettings({ tileSize: Number(e.target.value) })}
                style={{ accentColor: 'var(--accent)' }}
              />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>About</h2>
                <p>Vault {info?.version ?? ''} · a local-first media library.</p>
              </div>
            </div>
            <div className="field">
              <span className="help">
                {info?.stats.items ?? 0} {pluralize(info?.stats.items ?? 0, 'item')} across{' '}
                {info?.stats.tags ?? 0} {pluralize(info?.stats.tags ?? 0, 'tag')}. Images, GIFs,
                comics and video are stored as ordinary files, so nothing is locked in.
              </span>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
