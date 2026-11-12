import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  IMAGE_EXT,
  Library,
  defaultRoot,
  kindForFile,
  normalizeTagName,
  readConfig,
  writeConfig
} from './library'
import { evaluateLocal, localSuggestions, modelSuggestions, testConnection } from './ai'
import type {
  AiRunResult,
  ImportResult,
  LibraryData,
  LibrarySettings,
  MediaItem,
  ProcessedImport,
  ScanEntry
} from '../shared/types'

let lib: Library | null = null
let win: BrowserWindow | null = null
/** State for `window:setImmersive` (comic reader / image viewer). */
let immersive = false
let immersiveWasFullScreen = false
let immersiveExit: NodeJS.Timeout | null = null

export function currentLibrary(): Library {
  if (!lib) throw new Error('Library not ready')
  return lib
}

export function attachWindow(w: BrowserWindow): void {
  win = w
}

export async function openLibraryAt(root: string): Promise<Library> {
  if (lib) await lib.flush()
  lib = await Library.open(root)
  if (!process.env.VAULT_ROOT) {
    const cfg = readConfig()
    cfg.libraryRoot = root
    writeConfig(cfg)
  }
  return lib
}

export async function initLibrary(): Promise<void> {
  const cfg = readConfig()
  const root = process.env.VAULT_ROOT || cfg.libraryRoot || defaultRoot()
  await openLibraryAt(root)
}

export function libraryData(): LibraryData {
  const l = currentLibrary()
  return l.data
}

const UPDATABLE: (keyof MediaItem)[] = [
  'title',
  'note',
  'favorite',
  'coverIndex',
  'thumbTimeMs',
  'tags',
  'width',
  'height',
  'durationMs'
]

async function walkImages(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 7 || out.length > 6000) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'thumbs' || entry.name === 'trash') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walkImages(full, out, depth + 1)
    else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full)
  }
}

async function scanPaths(paths: string[]): Promise<ScanEntry[]> {
  const out: ScanEntry[] = []
  for (const p of paths) {
    let stat
    try {
      stat = await fs.stat(p)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      const images: string[] = []
      await walkImages(p, images)
      images.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      if (images.length === 0) continue
      if (images.length === 1) {
        const single = images[0]
        const s = await fs.stat(single)
        out.push({
          path: single,
          name: path.basename(single),
          kind: kindForFile(single) ?? 'image',
          bytes: s.size,
          isDir: false
        })
        continue
      }
      let bytes = 0
      const listed: { path: string; name: string; bytes: number }[] = []
      for (const img of images) {
        try {
          const s = await fs.stat(img)
          bytes += s.size
          listed.push({ path: img, name: path.basename(img), bytes: s.size })
        } catch {
          /* ignore */
        }
      }
      out.push({
        path: p,
        name: path.basename(p),
        kind: 'comic',
        bytes,
        isDir: true,
        images: listed
      })
    } else {
      const kind = kindForFile(p)
      if (!kind) continue
      out.push({
        path: p,
        name: path.basename(p),
        kind,
        bytes: stat.size,
        isDir: false
      })
    }
  }
  return out
}

function defaultTitle(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled'
}

async function commitImport(payload: ProcessedImport[]): Promise<ImportResult> {
  const l = currentLibrary()
  const copy = l.data.settings.copyOnImport
  const result: ImportResult = { added: [], restored: [], skipped: 0, failed: [] }
  // Keep the existing item for each hash, not just the hash itself, so an
  // import of a file that is already in the library can repair or re-surface it.
  const knownSha = new Map<string, MediaItem>()
  for (const item of l.items()) {
    if (item.sha256 && !knownSha.has(item.sha256)) knownSha.set(item.sha256, item)
  }

  /** Point an existing item at the file that was just ingested. */
  const adoptFile = async (
    item: MediaItem,
    ingested: { rel: string; bytes: number },
    p: ProcessedImport
  ): Promise<void> => {
    item.file = ingested.rel
    item.linked = !copy
    item.bytes = ingested.bytes
    if (p.width) item.width = p.width
    if (p.height) item.height = p.height
    if (p.durationMs !== undefined) item.durationMs = p.durationMs
    if (p.thumbTimeMs !== undefined) item.thumbTimeMs = p.thumbTimeMs
    if (p.phash) item.phash = p.phash
    if (p.hist) item.hist = p.hist
    if (p.color) item.color = p.color
    if (p.thumb) {
      await l.writeThumb(item.id, p.thumb)
      item.thumbVersion += 1
    }
    item.updatedAt = Date.now()
  }

  for (const p of payload) {
    try {
      const now = Date.now()
      const id = randomUUID()

      if (p.kind === 'comic' && p.pages?.length) {
        const pages = []
        let total = 0
        let coverSha = ''
        const created: string[] = []
        for (let i = 0; i < p.pages.length; i++) {
          const page = p.pages[i]
          const ingested = await l.ingest(page.path, copy)
          if (ingested.created) created.push(ingested.rel)
          if (i === 0) coverSha = ingested.sha
          total += ingested.bytes
          pages.push({ file: ingested.rel, width: page.width, height: page.height, bytes: page.bytes })
        }
        const coverIndex = Math.min(Math.max(0, p.coverIndex ?? 0), pages.length - 1)
        const existing = coverSha ? knownSha.get(coverSha) : undefined
        if (existing) {
          const missing = !existsSync(l.abs(existing.file))
          // `ingest` recreates the exact destination path when it was missing,
          // so by now the file can exist again even though the item was broken.
          const repairedInPlace = created.includes(existing.file)
          let restored = false
          if (missing || repairedInPlace) {
            // The library only had metadata left; take over the fresh pages.
            existing.pages = pages
            existing.coverIndex = coverIndex
            existing.file = pages[coverIndex].file
            existing.linked = !copy
            existing.bytes = total
            existing.width = p.width || pages[coverIndex].width
            existing.height = p.height || pages[coverIndex].height
            if (p.phash) existing.phash = p.phash
            if (p.hist) existing.hist = p.hist
            if (p.color) existing.color = p.color
            if (p.thumb) {
              await l.writeThumb(existing.id, p.thumb)
              existing.thumbVersion += 1
            }
            existing.updatedAt = Date.now()
            restored = true
          } else {
            // Only remove copies this import actually created. Deleting
            // `pages[].file` blindly used to remove the library's own files.
            for (const rel of created) await fs.unlink(l.abs(rel)).catch(() => {})
          }
          if (!existing.inbox) {
            existing.inbox = true
            existing.updatedAt = Date.now()
            restored = true
          }
          if (restored) {
            l.scheduleSave()
            result.restored.push(existing)
          } else {
            result.skipped++
          }
          continue
        }
        const item: MediaItem = {
          id,
          kind: 'comic',
          title: p.title || 'Untitled comic',
          file: pages[coverIndex].file,
          linked: !copy,
          bytes: total,
          addedAt: now,
          updatedAt: now,
          width: p.width || pages[coverIndex].width,
          height: p.height || pages[coverIndex].height,
          pages,
          coverIndex,
          thumbVersion: 1,
          tags: [],
          inbox: true,
          aiQueue: false,
          phash: p.phash,
          hist: p.hist,
          color: p.color,
          sha256: coverSha,
          note: p.note
        }
        if (p.thumb) {
          await l.writeThumb(id, p.thumb)
        }
        l.addItem(item)
        if (coverSha) knownSha.set(coverSha, item)
        result.added.push(item)
        continue
      }

      const ingested = await l.ingest(p.path, copy)
      const existing = knownSha.get(ingested.sha)
      if (existing) {
        const missing = !existsSync(l.abs(existing.file))
        // `ingest` may have just recreated the item's own file path. In that
        // case the item is repaired even though the path now exists again.
        const repairedInPlace =
          ingested.created && l.abs(existing.file) === l.abs(ingested.rel)
        let restored = false
        if (missing || repairedInPlace) {
          await adoptFile(existing, ingested, p)
          restored = true
        } else if (copy && ingested.created) {
          // The same bytes already live in the library; drop the extra copy
          // instead of the original.
          await fs.unlink(l.abs(ingested.rel)).catch(() => {})
        }
        if (!existing.inbox) {
          existing.inbox = true
          existing.updatedAt = Date.now()
          restored = true
        }
        if (restored) {
          l.scheduleSave()
          result.restored.push(existing)
        } else {
          result.skipped++
        }
        continue
      }
      const item: MediaItem = {
        id,
        kind: p.kind,
        title: p.title || defaultTitle(path.basename(p.path)),
        file: ingested.rel,
        linked: !copy,
        bytes: ingested.bytes,
        addedAt: now,
        updatedAt: now,
        width: p.width,
        height: p.height,
        durationMs: p.durationMs,
        thumbTimeMs: p.thumbTimeMs,
        thumbVersion: 1,
        tags: [],
        inbox: true,
        aiQueue: false,
        phash: p.phash,
        hist: p.hist,
        color: p.color,
        sha256: ingested.sha,
        note: p.note
      }
      if (p.thumb) await l.writeThumb(id, p.thumb)
      l.addItem(item)
      knownSha.set(ingested.sha, item)
      result.added.push(item)
    } catch (err) {
      result.failed.push({ path: p.path, error: err instanceof Error ? err.message : String(err) })
    }
  }

  await l.flush()
  return result
}

export function registerIpc(): void {
  ipcMain.handle('app:info', () => {
    const l = currentLibrary()
    return {
      version: app.getVersion(),
      root: l.root,
      platform: process.platform,
      name: l.data.name,
      stats: l.stats()
    }
  })

  ipcMain.handle('library:data', () => libraryData())

  ipcMain.handle('library:chooseRoot', async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a library folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: currentLibrary().root
    })
    if (res.canceled || !res.filePaths[0]) return null
    const l = await openLibraryAt(res.filePaths[0])
    win?.webContents.send('library:changed')
    return l.data
  })

  ipcMain.handle('dialog:pickFiles', async () => {
    if (!win) return []
    const res = await dialog.showOpenDialog(win, {
      title: 'Add media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All media', extensions: [...Object.keys({ '.jpg': 1, '.jpeg': 1, '.png': 1, '.webp': 1, '.avif': 1, '.bmp': 1, '.gif': 1, '.mp4': 1, '.webm': 1, '.mov': 1, '.m4v': 1, '.mkv': 1 }).map((e) => e.slice(1))] },
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif'] },
        { name: 'Video', extensions: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'wmv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('dialog:pickFolders', async () => {
    if (!win) return []
    const res = await dialog.showOpenDialog(win, {
      title: 'Add folders (each folder becomes a comic)',
      properties: ['openDirectory', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('import:scan', (_e, paths: string[]) => scanPaths(paths))

  ipcMain.handle('import:commit', (_e, payload: ProcessedImport[]) => commitImport(payload))

  ipcMain.handle('item:update', (_e, id: string, patch: Partial<MediaItem>) => {
    const l = currentLibrary()
    const safe: Partial<MediaItem> = {}
    for (const key of UPDATABLE) {
      if (key in patch) (safe as Record<string, unknown>)[key] = patch[key]
    }
    return l.updateItem(id, safe)
  })

  ipcMain.handle('item:delete', async (_e, ids: string[]) => {
    const l = currentLibrary()
    const res = await l.deleteItems(ids)
    return res
  })

  ipcMain.handle('set:create', async (_e, ids: string[]) => {
    const l = currentLibrary()
    const item = await l.createImageSet(ids)
    await l.flush()
    return item
  })

  ipcMain.handle('trash:info', () => currentLibrary().trashInfo())

  ipcMain.handle('trash:empty', () => currentLibrary().emptyTrash())

  ipcMain.handle(
    'image:convert',
    async (
      _e,
      id: string,
      pageIndex: number | null,
      data: ArrayBuffer,
      width: number,
      height: number
    ) => currentLibrary().replaceWithWebp(id, pageIndex, data, width, height)
  )

  ipcMain.handle('thumb:set', async (_e, id: string, data: ArrayBuffer, meta: { thumbTimeMs?: number; coverIndex?: number; custom?: boolean }) => {
    const l = currentLibrary()
    const item = l.get(id)
    if (!item) return null
    await l.writeThumb(id, data)
    const patch: Partial<MediaItem> = { thumbVersion: item.thumbVersion + 1 }
    if (meta.custom) {
      patch.thumbCustom = true
      // An uploaded image is not a video frame, so clear the poster time.
      patch.thumbTimeMs = undefined
    } else if (meta.thumbTimeMs !== undefined) {
      patch.thumbTimeMs = meta.thumbTimeMs
      patch.thumbCustom = false
    }
    if (meta.coverIndex !== undefined) {
      patch.coverIndex = meta.coverIndex
      const page = item.pages?.[meta.coverIndex]
      if (page) {
        patch.file = page.file
        patch.width = page.width
        patch.height = page.height
      }
    }
    return l.updateItem(id, patch)
  })

  ipcMain.handle('tag:add', (_e, name: string, color?: string) => currentLibrary().addTag(name, color))

  ipcMain.handle('tag:rename', (_e, id: string, name: string) => currentLibrary().renameTag(id, name))

  ipcMain.handle('tag:delete', (_e, id: string) => {
    currentLibrary().deleteTag(id)
    return true
  })

  ipcMain.handle('category:add', (_e, name: string, color?: string, parentId?: string | null) =>
    currentLibrary().addCategory(name, color, parentId)
  )

  ipcMain.handle('category:setParent', (_e, id: string, parentId: string | null) =>
    currentLibrary().setCategoryParent(id, parentId)
  )

  ipcMain.handle('category:rename', (_e, id: string, name: string) =>
    currentLibrary().renameCategory(id, name)
  )

  ipcMain.handle('category:delete', (_e, id: string) => {
    currentLibrary().deleteCategory(id)
    return true
  })

  ipcMain.handle('tag:setCategory', (_e, tagId: string, categoryId: string | null) =>
    currentLibrary().setTagCategory(tagId, categoryId)
  )

  ipcMain.handle('tags:apply', (_e, ids: string[], add: string[], remove: string[]) => {
    return currentLibrary().applyTags(ids, add, remove)
  })

  ipcMain.handle(
    'queue:setMembership',
    (_e, ids: string[], patch: { inbox?: boolean; aiQueue?: boolean }) => {
      return currentLibrary().setMembership(ids, patch)
    }
  )

  ipcMain.handle('dupes:find', (_e, threshold: number) => currentLibrary().findDuplicates(threshold))

  ipcMain.handle('ai:suggest', async (_e, ids: string[], useModel: boolean) => {
    const l = currentLibrary()
    const settings = l.data.settings.ai
    const results: AiRunResult[] = []
    for (const id of ids) {
      const item = l.get(id)
      if (!item) continue
      try {
        let suggestions = localSuggestions(l, item, settings)
        if (useModel && settings.provider === 'openai' && settings.apiKey) {
          try {
            const model = await modelSuggestions(l, item, settings)
            if (model.length) {
              // Keep the model's choices, but do not lose a very strong local
              // match (usually a title/filename match) that the model omitted.
              const merged = new Map(model.map((s) => [s.tag, s]))
              for (const local of suggestions) {
                if (local.score >= 0.9 && !merged.has(local.tag)) merged.set(local.tag, local)
              }
              suggestions = [...merged.values()]
                .sort((a, b) => b.score - a.score)
                .slice(0, settings.maxTags || 5)
            }
          } catch (err) {
            // Keep local suggestions, but surface the model failure.
            l.setSuggestions(id, suggestions, 'local')
            results.push({
              id,
              suggestions,
              error: err instanceof Error ? err.message : 'Model request failed'
            })
            continue
          }
        }
        const updated = l.setSuggestions(id, suggestions, useModel ? 'model' : 'local')
        results.push({ id, suggestions: updated?.ai ?? [] })
      } catch (err) {
        results.push({ id, suggestions: [], error: err instanceof Error ? err.message : String(err) })
      }
    }
    await l.flush()
    return results
  })

  ipcMain.handle('ai:accept', (_e, id: string, tags: string[], rejected?: string[]) => {
    return currentLibrary().acceptSuggestions(id, tags, rejected)
  })

  ipcMain.handle(
    'ai:acceptMany',
    (_e, entries: { id: string; tags: string[]; rejected?: string[] }[]) => {
      const l = currentLibrary()
      return entries
        .map((e) => l.acceptSuggestions(e.id, e.tags, e.rejected))
        .filter(Boolean)
    }
  )

  ipcMain.handle('ai:reject', (_e, ids: string[]) => {
    const l = currentLibrary()
    return ids.map((id) => l.rejectSuggestions(id)).filter(Boolean)
  })

  ipcMain.handle('ai:evaluate', (_e, maxItems?: number) =>
    evaluateLocal(currentLibrary(), maxItems)
  )

  ipcMain.handle('ai:test', () => testConnection(currentLibrary().data.settings.ai))

  ipcMain.handle('settings:set', (_e, patch: Partial<LibrarySettings>) => {
    const l = currentLibrary()
    l.data.settings = {
      ...l.data.settings,
      ...patch,
      ai: { ...l.data.settings.ai, ...(patch.ai ?? {}) }
    }
    l.scheduleSave()
    return l.data.settings
  })

  ipcMain.handle('shell:reveal', (_e, id: string) => {
    const l = currentLibrary()
    const item = l.get(id)
    if (!item) return false
    shell.showItemInFolder(l.abs(item.file))
    return true
  })

  ipcMain.handle('shell:openRoot', () => {
    void shell.openPath(currentLibrary().root)
    return true
  })

  /*
   * Immersive views (comic reader, image viewer) hide the native caption
   * buttons by putting the window into full screen. Remember whether the user
   * had it full screen already so closing the view restores their state. The
   * small exit delay absorbs React's dev-mode mount/unmount/mount cycle.
   */
  ipcMain.handle('window:setImmersive', (_e, on: boolean) => {
    if (!win) return
    if (on) {
      // Resuming inside the exit window (viewer item changed, StrictMode
      // remount): keep the original was-full-screen record and stay put.
      if (immersiveExit) {
        clearTimeout(immersiveExit)
        immersiveExit = null
        immersive = true
        return
      }
      if (immersive) return
      immersive = true
      immersiveWasFullScreen = win.isFullScreen()
      if (!immersiveWasFullScreen) win.setFullScreen(true)
    } else if (immersive) {
      immersive = false
      if (immersiveExit) clearTimeout(immersiveExit)
      immersiveExit = setTimeout(() => {
        immersiveExit = null
        if (!immersive && win && !immersiveWasFullScreen) win.setFullScreen(false)
        immersiveWasFullScreen = false
      }, 150)
    }
  })

  ipcMain.handle('debug:writeTemp', async (_e, name: string, data: ArrayBuffer) => {
    const dir = path.join(app.getPath('temp'), 'vault-smoke')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, name)
    await fs.writeFile(file, Buffer.from(data))
    return file
  })

  ipcMain.handle('debug:path', () => path.join(app.getPath('temp'), 'vault-smoke'))
}

export function isLibraryReady(): boolean {
  return !!lib
}

export { existsSync }
