import type { ImportResult } from '@shared/types'
import { useStore } from '../store'
import { importPaths } from './importer'

async function autoTag(ids: string[]): Promise<void> {
  const lib = useStore.getState().lib
  if (!lib || !ids.length) return
  const ai = lib.settings.ai
  const useModel = ai.provider === 'openai' && !!ai.apiKey
  try {
    const results = await window.vault.aiSuggest(ids, useModel)
    const fresh = await window.vault.getLibrary()
    useStore.setState({ lib: fresh })
    const count = results.filter((r) => r.suggestions.length).length
    if (count) {
      useStore
        .getState()
        .toast(`${count} ${count === 1 ? 'item' : 'items'} queued for AI review`, 'info')
    }
  } catch (err) {
    useStore
      .getState()
      .toast(err instanceof Error ? err.message : 'Auto-tagging failed', 'error')
  }
}

/**
 * The single import pipeline used by the title bar, drag & drop and the smoke
 * harness. Keeps the store in sync and reports a single friendly summary.
 */
export async function runImport(paths: string[]): Promise<ImportResult | null> {
  if (!paths.length) return null
  const store = useStore.getState()
  store.setImportState({ total: 0, done: 0, label: 'Scanning…', phase: 'reading' })

  try {
    const result = await importPaths(paths, (progress) =>
      useStore.getState().setImportState(progress)
    )
    const fresh = await window.vault.getLibrary()
    useStore.getState().hydrate(fresh)
    // Keep a fresh import visually separate from an already populated inbox.
    useStore
      .getState()
      .placeInboxBatch([...result.added, ...result.restored].map((item) => item.id))

    const added = result.added.length
    const restored = result.restored.length
    const skipped = result.skipped
    const failed = result.failed.length
    const notes: string[] = []
    if (restored) notes.push(`${restored} returned to the inbox`)
    if (skipped) notes.push(`${skipped} already here`)
    if (failed) notes.push(`${failed} failed`)

    if (added || restored) {
      const parts: string[] = []
      if (added) parts.push(`Added ${added} ${added === 1 ? 'item' : 'items'}`)
      if (restored) parts.push(`${restored} existing ${restored === 1 ? 'item' : 'items'} restored`)
      useStore
        .getState()
        .toast(`${parts.join(' · ')}${notes.length ? ` · ${notes.join(' · ')}` : ''}`, 'success')
    } else if (failed) {
      useStore
        .getState()
        .toast(`Import failed — ${result.failed[0]?.error ?? 'unknown error'}`, 'error')
    } else if (skipped) {
      useStore
        .getState()
        .toast(
          `${skipped} ${skipped === 1 ? 'file was' : 'files were'} already in the library`,
          'info'
        )
    }

    const lib = useStore.getState().lib
    if (added && lib?.settings.autoTagOnImport && lib.settings.ai.enabled) {
      void autoTag(result.added.map((item) => item.id))
    }

    return result
  } catch (err) {
    useStore
      .getState()
      .toast(err instanceof Error ? err.message : 'Import failed', 'error')
    return null
  } finally {
    useStore.getState().setImportState(null)
  }
}
