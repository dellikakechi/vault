import { app } from 'electron'
import { promises as fs, existsSync, createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  AiSuggestion,
  ComicPage,
  DuplicateEntry,
  DuplicateGroup,
  LibraryData,
  LibrarySettings,
  MediaItem,
  MediaKind,
  Tag,
  TagCategory
} from '../shared/types'

export const MEDIA_EXT: Record<string, MediaKind> = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.bmp': 'image',
  '.tif': 'image',
  '.tiff': 'image',
  '.jfif': 'image',
  '.gif': 'gif',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.m4v': 'video',
  '.mkv': 'video',
  '.avi': 'video',
  '.ogv': 'video',
  '.wmv': 'video'
}

export const IMAGE_EXT = new Set(
  Object.entries(MEDIA_EXT)
    .filter(([, k]) => k === 'image' || k === 'gif')
    .map(([e]) => e)
)

export function kindForFile(file: string): MediaKind | null {
  return MEDIA_EXT[path.extname(file).toLowerCase()] ?? null
}

export const DEFAULT_SETTINGS: LibrarySettings = {
  copyOnImport: true,
  duplicateThreshold: 6,
  autoTagOnImport: false,
  tileSize: 210,
  ai: {
    enabled: true,
    provider: 'local',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    minScore: 0.6,
    maxTags: 5
  }
}

export function slug(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60)
  return s || 'file'
}

export function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

async function copyAndHash(src: string, dest: string): Promise<string> {
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk)
      cb(null, chunk)
    }
  })
  await pipeline(createReadStream(src), tap, createWriteStream(dest))
  return hash.digest('hex')
}

/**
 * A WebP is lossless when it contains a VP8L chunk. Simple lossless files put
 * it first; extended containers may wrap it in VP8X, so walk the RIFF chunks.
 */
function isLosslessWebp(buf: Buffer): boolean {
  if (
    buf.length < 16 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return false
  }
  let offset = 12
  while (offset + 8 <= buf.length) {
    const type = buf.toString('ascii', offset, offset + 4)
    if (type === 'VP8L') return true
    const length = buf.readUInt32LE(offset + 4)
    const next = offset + 8 + length + (length & 1)
    if (next <= offset || next > buf.length) break
    offset = next
  }
  return false
}

function emptyLibrary(root: string): LibraryData {
  return {
    version: 1,
    id: randomUUID(),
    name: path.basename(root) || 'Vault',
    createdAt: Date.now(),
    root,
    items: {},
    tags: [],
    categories: [],
    settings: structuredClone(DEFAULT_SETTINGS)
  }
}

export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 48)
}

export function normalizeCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 48)
}

export class Library {
  root: string
  data: LibraryData
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(root: string, data: LibraryData) {
    this.root = root
    this.data = data
    this.data.root = root
    // Fill in defaults for libraries created by older versions.
    this.data.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...this.data.settings,
      ai: { ...DEFAULT_SETTINGS.ai, ...(this.data.settings?.ai ?? {}) }
    }
    this.data.items ??= {}
    this.data.tags ??= []
    this.data.categories ??= []
    this.sanitizeCategories()
    this.migrateMembership()
  }

  /**
   * Older libraries have flat categories. Treat a missing parent as top level
   * and drop references that would otherwise create orphaned or cyclic trees.
   */
  private sanitizeCategories(): void {
    const ids = new Set(this.data.categories.map((category) => category.id))
    for (const category of this.data.categories) {
      if (!category.parentId || category.parentId === category.id || !ids.has(category.parentId)) {
        category.parentId = undefined
      }
    }
    for (const category of this.data.categories) {
      const seen = new Set<string>([category.id])
      let parentId = category.parentId
      while (parentId) {
        if (seen.has(parentId)) {
          category.parentId = undefined
          break
        }
        seen.add(parentId)
        parentId = this.data.categories.find((candidate) => candidate.id === parentId)?.parentId
      }
    }
  }

  private categoryDescendants(id: string): Set<string> {
    const out = new Set<string>()
    let changed = true
    while (changed) {
      changed = false
      for (const category of this.data.categories) {
        if (category.id === id || !category.parentId || out.has(category.id)) continue
        if (category.parentId === id || out.has(category.parentId)) {
          out.add(category.id)
          changed = true
        }
      }
    }
    return out
  }

  /**
   * Older libraries inferred inbox and AI membership from tags and suggestions.
   * Freeze that inference into explicit flags so tagging an item no longer
   * silently removes it from the inbox.
   */
  private migrateMembership(): void {
    for (const item of Object.values(this.data.items)) {
      if (!item.tags) item.tags = []
      if (item.inbox === undefined) item.inbox = item.tags.length === 0 && !item.ai?.length
      if (item.aiQueue === undefined) item.aiQueue = !!item.ai?.length
    }
  }

  static async open(root: string): Promise<Library> {
    await fs.mkdir(path.join(root, 'media'), { recursive: true })
    await fs.mkdir(path.join(root, 'thumbs'), { recursive: true })
    await fs.mkdir(path.join(root, 'trash'), { recursive: true })
    const file = path.join(root, 'library.json')
    let data: LibraryData
    if (existsSync(file)) {
      data = JSON.parse(await fs.readFile(file, 'utf8')) as LibraryData
      if (!data.items) data.items = {}
      if (!data.tags) data.tags = []
      if (!data.categories) data.categories = []
    } else {
      data = emptyLibrary(root)
    }
    const lib = new Library(root, data)
    await lib.flush()
    return lib
  }

  get mediaDir(): string {
    return path.join(this.root, 'media')
  }

  get thumbsDir(): string {
    return path.join(this.root, 'thumbs')
  }

  get trashDir(): string {
    return path.join(this.root, 'trash')
  }

  abs(rel: string): string {
    return path.isAbsolute(rel) ? rel : path.join(this.root, rel)
  }

  items(): MediaItem[] {
    return Object.values(this.data.items)
  }

  get(id: string): MediaItem | undefined {
    return this.data.items[id]
  }

  scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, 350)
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const payload = JSON.stringify(this.data, null, 2)
    const file = path.join(this.root, 'library.json')
    const tmp = `${file}.${process.pid}.tmp`
    this.writing = this.writing.then(async () => {
      await fs.writeFile(tmp, payload, 'utf8')
      await fs.rename(tmp, file)
    })
    return this.writing
  }

  async ingest(
    sourcePath: string,
    copy: boolean
  ): Promise<{ rel: string; sha: string; bytes: number; created: boolean }> {
    const stat = await fs.stat(sourcePath)
    if (!copy) {
      const sha = await hashFile(sourcePath)
      return { rel: sourcePath, sha, bytes: stat.size, created: false }
    }
    const ext = path.extname(sourcePath).toLowerCase()
    const incoming = path.join(this.mediaDir, `.incoming-${randomUUID()}${ext}`)
    const sha = await copyAndHash(sourcePath, incoming)
    const base = slug(path.basename(sourcePath, path.extname(sourcePath)))
    const name = `${base}-${sha.slice(0, 10)}${ext}`
    const dest = path.join(this.mediaDir, name)
    if (existsSync(dest)) {
      // The exact file is already in the library. Keep it and drop the temp copy.
      await fs.unlink(incoming).catch(() => {})
      return { rel: `media/${name}`, sha, bytes: stat.size, created: false }
    }
    await fs.rename(incoming, dest)
    return { rel: `media/${name}`, sha, bytes: stat.size, created: true }
  }

  async writeThumb(id: string, data: ArrayBuffer): Promise<void> {
    const buf = Buffer.from(data)
    await fs.writeFile(path.join(this.thumbsDir, `${id}.webp`), buf)
  }

  /**
   * Replace one library-owned image (or one comic page) with a lossless WebP
   * produced by the renderer. The old file goes to the trash, never outside the
   * library. Linked items are rejected before this method is called, but the
   * guard is repeated here so a stale renderer can never modify user files.
   */
  async replaceWithWebp(
    id: string,
    pageIndex: number | null,
    data: ArrayBuffer,
    width: number,
    height: number
  ): Promise<MediaItem> {
    const item = this.data.items[id]
    if (!item) throw new Error('Item not found')
    if (item.linked) throw new Error('Linked files are never modified')
    if (!width || !height) throw new Error('Invalid image dimensions')

    let rel: string
    if (pageIndex === null) {
      if (item.kind === 'comic' || item.kind === 'set') {
        throw new Error('Paged items need a page index')
      }
      rel = item.file
    } else {
      if (item.kind !== 'comic' && item.kind !== 'set') throw new Error('Only paged items have pages')
      const page = item.pages?.[pageIndex]
      if (!page) throw new Error('Page not found')
      rel = page.file
    }
    if (!rel || path.isAbsolute(rel)) throw new Error('Unsafe media path')

    const buf = Buffer.from(data)
    // RIFF/WEBP with a VP8L chunk is a true lossless WebP. Reject anything else
    // so a canvas/lossy encode can never be committed silently.
    if (!isLosslessWebp(buf)) {
      throw new Error('Encoder did not produce a lossless WebP')
    }

    const sha = createHash('sha256').update(buf).digest('hex')
    const oldAbs = this.abs(rel)
    const base = slug(path.basename(rel, path.extname(rel))) || 'image'
    let name = `${base}-${sha.slice(0, 10)}.webp`
    let destAbs = path.join(this.mediaDir, name)
    if (existsSync(destAbs) && path.resolve(destAbs) !== path.resolve(oldAbs)) {
      // Never share a file between items; deleting one would break the other.
      name = `${base}-${sha.slice(0, 10)}-${randomUUID().slice(0, 8)}.webp`
      destAbs = path.join(this.mediaDir, name)
    }
    const destRel = `media/${name}`
    const tmp = path.join(this.mediaDir, `.convert-${randomUUID()}.webp`)
    await fs.writeFile(tmp, buf)
    try {
      if (path.resolve(destAbs) === path.resolve(oldAbs)) {
        // The source already is the exact lossless file we would write.
        await fs.unlink(tmp)
      } else {
        await fs.rename(tmp, destAbs)
      }
    } catch (err) {
      await fs.unlink(tmp).catch(() => {})
      throw err
    }

    if (path.resolve(destAbs) !== path.resolve(oldAbs)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await fs
        .rename(oldAbs, path.join(this.trashDir, `${stamp}-${path.basename(oldAbs)}`))
        .catch(() => {})
    }

    if (pageIndex === null) {
      item.file = destRel
      item.bytes = buf.length
      item.width = width
      item.height = height
      item.sha256 = sha
      item.convertedToWebp = true
    } else {
      const pages = item.pages!
      const page = pages[pageIndex]
      const wasCover = item.file === rel || item.coverIndex === pageIndex
      page.file = destRel
      page.bytes = buf.length
      page.width = width
      page.height = height
      page.convertedToWebp = true
      item.bytes = pages.reduce((sum, candidate) => sum + candidate.bytes, 0)
      if (wasCover) {
        item.file = destRel
        item.width = width
        item.height = height
        // Image sets are composites: they must never join duplicate matching
        // just because their cover page matches a source image.
        if (item.kind !== 'set') item.sha256 = sha
      }
      item.convertedToWebp = pages.every((candidate) => candidate.convertedToWebp)
    }

    item.updatedAt = Date.now()
    this.scheduleSave()
    await this.flush()
    return item
  }

  addItem(item: MediaItem): MediaItem {
    this.data.items[item.id] = item
    this.scheduleSave()
    return item
  }

  /**
   * Turn selected images/GIFs into one paged item. Pages live under
   * `media/sets/<id>/` as hard links when possible, so the set owns its paths
   * while the originals stay independent (deleting one never breaks the other).
   */
  async createImageSet(ids: string[]): Promise<MediaItem> {
    const sources: MediaItem[] = []
    for (const id of new Set(ids)) {
      const item = this.data.items[id]
      if (!item) continue
      if (item.kind !== 'image' && item.kind !== 'gif') continue
      sources.push(item)
    }
    if (sources.length < 2) throw new Error('Select at least two images or GIFs')

    // The set carries every tag from its pages, so it shows up under all the
    // combinations the originals belonged to.
    const tags = [...new Set(sources.flatMap((source) => source.tags))].sort()

    const id = randomUUID()
    const dirRel = `media/sets/${id}`
    const dirAbs = path.join(this.root, dirRel)
    await fs.mkdir(dirAbs, { recursive: true })
    const pages: ComicPage[] = []
    let total = 0
    try {
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index]
        const srcAbs = this.abs(source.file)
        const ext = path.extname(source.file).toLowerCase()
        const name = `${String(index + 1).padStart(3, '0')}${ext}`
        const destAbs = path.join(dirAbs, name)
        try {
          await fs.link(srcAbs, destAbs)
        } catch {
          // Different volume, unsupported filesystem, or a missing source:
          // fall back to an independent copy.
          await fs.copyFile(srcAbs, destAbs)
        }
        const stat = await fs.stat(destAbs)
        total += stat.size
        pages.push({
          file: `${dirRel}/${name}`,
          width: source.width,
          height: source.height,
          bytes: stat.size
        })
      }
    } catch (err) {
      await fs.rm(dirAbs, { recursive: true, force: true }).catch(() => {})
      throw err
    }

    // Reuse the first source's thumbnail so the set has a cover immediately.
    for (const source of sources) {
      const from = path.join(this.thumbsDir, `${source.id}.webp`)
      if (!existsSync(from)) continue
      await fs.copyFile(from, path.join(this.thumbsDir, `${id}.webp`)).catch(() => {})
      break
    }

    const now = Date.now()
    const cover = pages[0]
    const item: MediaItem = {
      id,
      kind: 'set',
      title: 'Image set',
      file: cover.file,
      linked: false,
      bytes: total,
      addedAt: now,
      updatedAt: now,
      width: cover.width,
      height: cover.height,
      pages,
      coverIndex: 0,
      thumbVersion: 1,
      tags,
      inbox: false,
      aiQueue: false
    }
    return this.addItem(item)
  }

  updateItem(id: string, patch: Partial<MediaItem>): MediaItem | null {
    const item = this.data.items[id]
    if (!item) return null
    Object.assign(item, patch, { updatedAt: Date.now() })
    this.scheduleSave()
    return item
  }

  /**
   * Explicitly add or remove items from the inbox and/or AI queue. Membership
   * is independent of tags, so applying a tag never moves an item by itself.
   */
  setMembership(
    ids: string[],
    patch: { inbox?: boolean; aiQueue?: boolean }
  ): MediaItem[] {
    const changed: MediaItem[] = []
    for (const id of ids) {
      const item = this.data.items[id]
      if (!item) continue
      if (patch.inbox !== undefined) item.inbox = patch.inbox
      if (patch.aiQueue !== undefined) item.aiQueue = patch.aiQueue
      item.updatedAt = Date.now()
      changed.push(item)
    }
    if (changed.length) this.scheduleSave()
    return changed
  }

  /**
   * Summary of what is waiting in the trash folder. Only regular files sitting
   * directly inside this library's own `trash/` are counted; the folder is
   * skipped by imports, so these are always files the app deleted.
   */
  async trashInfo(): Promise<{ files: number; bytes: number }> {
    const info = { files: 0, bytes: 0 }
    let entries
    try {
      entries = await fs.readdir(this.trashDir, { withFileTypes: true })
    } catch {
      return info
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        const stat = await fs.lstat(path.join(this.trashDir, entry.name))
        info.files++
        info.bytes += stat.size
      } catch {
        /* vanished while listing */
      }
    }
    return info
  }

  /**
   * Permanently delete the contents of `trash/`. Only regular files directly
   * inside this library's trash folder are removed — symlinks, directories and
   * anything outside the folder are left untouched, so a stray link can never
   * delete user files.
   */
  async emptyTrash(): Promise<{ files: number; bytes: number }> {
    const removed = { files: 0, bytes: 0 }
    const dir = path.resolve(this.trashDir)
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return removed
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const target = path.resolve(dir, entry.name)
      if (path.dirname(target) !== dir) continue
      let bytes = 0
      try {
        bytes = (await fs.lstat(target)).size
      } catch {
        continue
      }
      try {
        await fs.unlink(target)
        removed.files++
        removed.bytes += bytes
      } catch {
        /* locked or already gone: leave it for the next attempt */
      }
    }
    return removed
  }

  /** Move an item's files to the trash folder and drop it from the library. */
  async deleteItems(ids: string[]): Promise<{ removed: number; kept: number }> {
    let removed = 0
    let kept = 0
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const id of ids) {
      const item = this.data.items[id]
      if (!item) continue
      const files = [item.file, ...(item.pages ?? []).map((p) => p.file)]
      for (const rel of new Set(files)) {
        if (!rel) continue
        const abs = this.abs(rel)
        if (item.linked) {
          // Never touch files outside the library.
          kept++
          continue
        }
        try {
          const target = path.join(this.trashDir, `${stamp}-${path.basename(abs)}`)
          await fs.rename(abs, target)
        } catch {
          /* file may already be gone */
        }
      }
      await fs.unlink(path.join(this.thumbsDir, `${id}.webp`)).catch(() => {})
      delete this.data.items[id]
      removed++
    }
    this.scheduleSave()
    return { removed, kept }
  }

  addTag(name: string, color?: string): Tag {
    const clean = normalizeTagName(name)
    const existing = this.data.tags.find((t) => t.name === clean)
    if (existing) return existing
    const tag: Tag = { id: randomUUID(), name: clean, color, createdAt: Date.now() }
    this.data.tags.push(tag)
    this.scheduleSave()
    return tag
  }

  renameTag(id: string, name: string): Tag | null {
    const tag = this.data.tags.find((t) => t.id === id)
    if (!tag) return null
    const clean = normalizeTagName(name)
    if (!clean) return tag
    if (clean === tag.name) return tag

    const prev = tag.name
    // Renaming onto an existing tag merges the two definitions instead of
    // leaving two tags with the same name.
    const existing = this.data.tags.find((t) => t.name === clean && t.id !== id)
    if (!existing) tag.name = clean
    else if (!existing.categoryId && tag.categoryId) existing.categoryId = tag.categoryId

    for (const item of this.items()) {
      if (!item.tags.includes(prev)) continue
      const set = new Set(item.tags)
      set.delete(prev)
      set.add(clean)
      item.tags = [...set]
      item.updatedAt = Date.now()
    }

    if (existing) this.data.tags = this.data.tags.filter((t) => t.id !== id)
    this.scheduleSave()
    return existing ?? tag
  }

  deleteTag(id: string): void {
    const tag = this.data.tags.find((t) => t.id === id)
    if (!tag) return
    this.data.tags = this.data.tags.filter((t) => t.id !== id)
    for (const item of this.items()) {
      if (item.tags.includes(tag.name)) {
        item.tags = item.tags.filter((n) => n !== tag.name)
        item.updatedAt = Date.now()
      }
    }
    this.scheduleSave()
  }

  addCategory(name: string, color?: string, parentId?: string | null): TagCategory {
    const clean = normalizeCategoryName(name)
    const existing = this.data.categories.find(
      (c) => c.name.toLowerCase() === clean.toLowerCase()
    )
    if (existing) return existing
    const parent =
      parentId && this.data.categories.some((category) => category.id === parentId)
        ? parentId
        : undefined
    const category: TagCategory = {
      id: randomUUID(),
      name: clean,
      color,
      parentId: parent,
      createdAt: Date.now()
    }
    if (!parent) delete category.parentId
    this.data.categories.push(category)
    this.scheduleSave()
    return category
  }

  setCategoryParent(id: string, parentId: string | null): TagCategory | null {
    const category = this.data.categories.find((c) => c.id === id)
    if (!category) return null
    if (parentId) {
      if (parentId === id) return null
      if (!this.data.categories.some((candidate) => candidate.id === parentId)) return null
      // Reparenting under one of its own descendants would create a cycle.
      if (this.categoryDescendants(id).has(parentId)) return null
      category.parentId = parentId
    } else {
      delete category.parentId
    }
    this.scheduleSave()
    return category
  }

  renameCategory(id: string, name: string): TagCategory | null {
    const category = this.data.categories.find((c) => c.id === id)
    if (!category) return null
    const clean = normalizeCategoryName(name)
    if (!clean) return category
    if (clean === category.name) return category
    // Merging two categories moves every tag into the surviving one.
    const existing = this.data.categories.find(
      (c) => c.id !== id && c.name.toLowerCase() === clean.toLowerCase()
    )
    if (existing) {
      // Renaming a parent onto one of its own descendants is ambiguous and
      // would leave the hierarchy with a cycle.
      if (this.categoryDescendants(id).has(existing.id)) return null
      for (const tag of this.data.tags) {
        if (tag.categoryId === id) tag.categoryId = existing.id
      }
      for (const child of this.data.categories) {
        if (child.id === existing.id || child.parentId !== id) continue
        child.parentId = existing.id
      }
      // If the survivor was a direct child of the category being removed, it
      // takes that category's place in the tree.
      if (existing.parentId === id) {
        if (category.parentId) existing.parentId = category.parentId
        else delete existing.parentId
      }
      this.data.categories = this.data.categories.filter((c) => c.id !== id)
      this.scheduleSave()
      return existing
    }
    category.name = clean
    this.scheduleSave()
    return category
  }

  deleteCategory(id: string): void {
    const category = this.data.categories.find((c) => c.id === id)
    if (!category) return
    const parentId =
      category.parentId && this.data.categories.some((candidate) => candidate.id === category.parentId)
        ? category.parentId
        : undefined
    // Child categories move up one level; tags directly inside move to the
    // same place, so deleting a folder never loses its contents.
    for (const child of this.data.categories) {
      if (child.parentId !== id) continue
      if (parentId) child.parentId = parentId
      else delete child.parentId
    }
    for (const tag of this.data.tags) {
      if (tag.categoryId !== id) continue
      if (parentId) tag.categoryId = parentId
      else tag.categoryId = undefined
    }
    this.data.categories = this.data.categories.filter((c) => c.id !== id)
    this.scheduleSave()
  }

  setTagCategory(tagId: string, categoryId: string | null): Tag | null {
    const tag = this.data.tags.find((t) => t.id === tagId)
    if (!tag) return null
    if (categoryId && !this.data.categories.some((c) => c.id === categoryId)) return tag
    if (categoryId) tag.categoryId = categoryId
    else tag.categoryId = undefined
    this.scheduleSave()
    return tag
  }

  applyTags(ids: string[], add: string[], remove: string[]): MediaItem[] {
    const changed: MediaItem[] = []
    const addNames = add.map(normalizeTagName).filter(Boolean)
    const removeNames = remove.map(normalizeTagName).filter(Boolean)
    for (const name of addNames) this.addTag(name)
    for (const id of ids) {
      const item = this.data.items[id]
      if (!item) continue
      const set = new Set(item.tags)
      for (const n of addNames) set.add(n)
      for (const n of removeNames) set.delete(n)
      item.tags = [...set]
      // Adding a tag manually clears any earlier negative feedback for it.
      if (addNames.length && item.rejectedTags?.length) {
        const added = new Set(addNames)
        const left = item.rejectedTags.filter((tag) => !added.has(tag))
        item.rejectedTags = left.length ? left : undefined
      }
      item.updatedAt = Date.now()
      changed.push(item)
    }
    this.scheduleSave()
    return changed
  }

  setSuggestions(id: string, suggestions: AiSuggestion[], source: 'local' | 'model'): MediaItem | null {
    const item = this.data.items[id]
    if (!item) return null
    const rejected = new Set(item.rejectedTags ?? [])
    // If the user has since applied one of those tags manually, the negative
    // feedback is stale and should not keep suppressing it.
    if (rejected.size) {
      for (const tag of item.tags) rejected.delete(tag)
      item.rejectedTags = rejected.size ? [...rejected] : undefined
    }
    const seen = new Set<string>()
    item.ai = suggestions
      .filter((s) => s.tag && !item.tags.includes(s.tag) && !rejected.has(s.tag))
      .filter((s) => (seen.has(s.tag) ? false : (seen.add(s.tag), true)))
      .sort((a, b) => b.score - a.score)
    item.aiSource = source
    // Suggestions belong to the AI review area, so make sure the item is
    // visible there even if it was analysed through another entry point.
    item.aiQueue = true
    item.updatedAt = Date.now()
    this.scheduleSave()
    return item
  }

  acceptSuggestions(id: string, tags: string[], rejected: string[] = []): MediaItem | null {
    const item = this.data.items[id]
    if (!item) return null
    const set = new Set(item.tags)
    const accepted = new Set<string>()
    for (const t of tags) {
      const clean = normalizeTagName(t)
      if (!clean) continue
      this.addTag(clean)
      set.add(clean)
      accepted.add(clean)
    }
    item.tags = [...set]
    const negatives = new Set(item.rejectedTags ?? [])
    for (const tag of rejected) {
      const clean = normalizeTagName(tag)
      if (clean && !accepted.has(clean) && !set.has(clean)) negatives.add(clean)
    }
    for (const tag of accepted) negatives.delete(tag)
    item.rejectedTags = negatives.size ? [...negatives] : undefined
    item.ai = undefined
    item.updatedAt = Date.now()
    this.scheduleSave()
    return item
  }

  rejectSuggestions(id: string): MediaItem | null {
    const item = this.data.items[id]
    if (!item) return null
    // Rejecting a suggestion is useful training data: remember the negative so
    // the local tagger and the model prompt stop proposing it for this item.
    if (item.ai?.length) {
      const negatives = new Set(item.rejectedTags ?? [])
      for (const suggestion of item.ai) negatives.add(suggestion.tag)
      item.rejectedTags = [...negatives]
    }
    item.ai = undefined
    item.updatedAt = Date.now()
    this.scheduleSave()
    return item
  }

  stats(): { items: number; tags: number; bytes: number } {
    const list = this.items()
    return {
      items: list.length,
      tags: this.data.tags.length,
      bytes: list.reduce((n, i) => n + (i.bytes || 0), 0)
    }
  }

  /**
   * Find byte-identical files *and* near-identical variations (crops, colour
   * tweaks, re-encodes, small overlays). The scan always runs; the threshold
   * controls how different a perceptual hash may be before it counts as a
   * duplicate. Variations are grouped when their hashes are somewhat apart but
   * their colour histograms and aspect ratios still line up.
   */
  findDuplicates(threshold: number): DuplicateGroup[] {
    const items = this.items().filter((i) => i.phash || i.sha256)
    const parent = new Map<string, string>()
    const find = (x: string): string => {
      let r = x
      while (parent.get(r) !== r) r = parent.get(r)!
      let c = x
      while (parent.get(c) !== c) {
        const n = parent.get(c)!
        parent.set(c, r)
        c = n
      }
      return r
    }
    const union = (a: string, b: string): void => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    for (const i of items) parent.set(i.id, i.id)

    // Exact file matches.
    const shaMap = new Map<string, string>()
    for (const i of items) {
      if (!i.sha256) continue
      const prev = shaMap.get(i.sha256)
      if (prev) union(prev, i.id)
      else shaMap.set(i.sha256, i.id)
    }

    const hashed = items.filter((i) => !!i.phash && /^[0-9a-f]{16}$/i.test(i.phash))
    // Hash distances above the slider value can still be the same artwork with
    // a small edit. Cap the extra allowance so unrelated images stay apart,
    // while never shrinking below the threshold the user picked.
    const near = Math.max(threshold, Math.min(threshold + 8, 15))
    const seen = new Set<string>()

    const compare = (a: MediaItem, b: MediaItem): void => {
      const key = a.id < b.id ? a.id + b.id : b.id + a.id
      if (seen.has(key)) return
      seen.add(key)
      if (a.kind !== b.kind) return
      const d = hamming(a.phash!, b.phash!)
      if (d > near) return
      if (d <= threshold) {
        if (d === 0) {
          union(a.id, b.id)
          return
        }
        // A couple of bits of drift is normal for a re-encode, but beyond that
        // two unrelated images can still share a coarse shape. Require their
        // colour signatures to agree before calling them the same artwork.
        const hist = histCosine(a.hist, b.hist)
        if (aspectDelta(a, b) <= 0.2 && (d <= 2 || hist >= 0.9)) union(a.id, b.id)
        return
      }
      // Hash distance alone is not enough for bigger edits; a crop or colour
      // shift keeps the aspect ratio and the overall palette.
      if (aspectDelta(a, b) > 0.12) return
      if (histCosine(a.hist, b.hist) < 0.975) return
      union(a.id, b.id)
    }

    if (hashed.length <= 5000) {
      // Exhaustive: every pair is checked, so a variation cannot slip through
      // because it happened to miss a coarse hash bucket.
      for (let a = 0; a < hashed.length; a++) {
        for (let b = a + 1; b < hashed.length; b++) compare(hashed[a], hashed[b])
      }
    } else {
      // For very large collections, bucket by nibble. Any pair within 15 bits
      // is guaranteed to share at least one nibble.
      const buckets = new Map<number, MediaItem[]>()
      for (const i of hashed) {
        const bits = BigInt('0x' + i.phash)
        for (let shift = 0; shift < 64; shift += 4) {
          const key = shift * 16 + Number((bits >> BigInt(shift)) & 0xfn)
          const arr = buckets.get(key)
          if (arr) arr.push(i)
          else buckets.set(key, [i])
        }
      }
      for (const bucket of buckets.values()) {
        for (let a = 0; a < bucket.length; a++) {
          for (let b = a + 1; b < bucket.length; b++) compare(bucket[a], bucket[b])
        }
      }
    }

    const groups = new Map<string, MediaItem[]>()
    for (const i of items) {
      const r = find(i.id)
      const arr = groups.get(r)
      if (arr) arr.push(i)
      else groups.set(r, [i])
    }

    const isIdentical = (item: MediaItem, keeper: MediaItem): boolean => {
      if (item.sha256 && keeper.sha256) return item.sha256 === keeper.sha256
      return !!item.phash && item.phash === keeper.phash
    }

    const out: DuplicateGroup[] = []
    for (const members of groups.values()) {
      if (members.length < 2) continue
      const keep = [...members].sort((a, b) => {
        const res = b.width * b.height - a.width * a.height
        if (res !== 0) return res
        if (b.bytes !== a.bytes) return b.bytes - a.bytes
        return a.addedAt - b.addedAt
      })[0]
      const entries: DuplicateEntry[] = members
        .map((item) => {
          const identical = isIdentical(item, keep)
          const distance = identical ? 0 : hamming(item.phash ?? '', keep.phash ?? '')
          return {
            item,
            distance,
            identical,
            // Byte-identical copies are safe to remove. Edited variations are
            // kept by default so the user can compare and choose.
            suggested:
              identical && item.id !== keep.id
                ? ('delete' as const)
                : ('keep' as const)
          }
        })
        .sort((a, b) => a.distance - b.distance || b.item.bytes - a.item.bytes)
      const allIdentical = entries.every((e) => e.identical)
      const someIdentical = entries.some((e) => e.identical && e.item.id !== keep.id)
      const kind: DuplicateGroup['kind'] = allIdentical
        ? 'identical'
        : someIdentical
          ? 'mixed'
          : 'variation'
      const reclaimable = entries
        .filter((e) => e.suggested === 'delete')
        .reduce((n, e) => n + e.item.bytes, 0)
      out.push({ id: keep.id, items: entries, keep: keep.id, kind, reclaimable })
    }
    return out.sort((a, b) => b.reclaimable - a.reclaimable)
  }
}

/** Cosine similarity of two normalised colour histograms. */
export function histCosine(a?: number[], b?: number[]): number {
  if (!a || !b || !a.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom ? dot / denom : 0
}

/** Relative difference between two aspect ratios (0 = identical shape). */
export function aspectDelta(a: MediaItem, b: MediaItem): number {
  if (!a.width || !a.height || !b.width || !b.height) return 1
  const ra = a.width / a.height
  const rb = b.width / b.height
  return Math.abs(ra - rb) / Math.max(ra, rb)
}

export function hamming(a: string, b: string): number {
  if (!a || !b) return 64
  if (a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) {
      d += x & 1
      x >>= 1
    }
  }
  return d
}

// ---------------------------------------------------------------------------
// Config (points at the active library root)
// ---------------------------------------------------------------------------

export interface AppConfig {
  libraryRoot?: string
  window?: { x?: number; y?: number; width: number; height: number }
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

export function readConfig(): AppConfig {
  try {
    return JSON.parse(require('node:fs').readFileSync(configPath(), 'utf8')) as AppConfig
  } catch {
    return {}
  }
}

export function writeConfig(cfg: AppConfig): void {
  try {
    const file = configPath()
    require('node:fs').mkdirSync(path.dirname(file), { recursive: true })
    require('node:fs').writeFileSync(file, JSON.stringify(cfg, null, 2))
  } catch {
    /* non-fatal */
  }
}

export function defaultRoot(): string {
  return path.join(app.getPath('documents'), 'Vault')
}
