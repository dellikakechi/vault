/**
 * Shared types used by the main process, preload bridge and renderer.
 */

export type MediaKind = 'image' | 'gif' | 'comic' | 'set' | 'video'

export interface ComicPage {
  /** Path relative to the library root, or absolute when the item is linked. */
  file: string
  width: number
  height: number
  bytes: number
  /** Internal flag: this page is already a lossless WebP. Never shown in the UI. */
  convertedToWebp?: boolean
}

export interface AiSuggestion {
  tag: string
  score: number
  source: 'local' | 'model'
}

export interface AiTagMetric {
  tag: string
  support: number
  predicted: number
  correct: number
  precision: number
  recall: number
}

export interface AiThresholdMetric {
  threshold: number
  predicted: number
  correct: number
  precision: number
  recall: number
  f1: number
}

export interface AiEvaluation {
  /** Number of tagged items checked. */
  items: number
  predicted: number
  correct: number
  precision: number
  recall: number
  f1: number
  threshold: number
  /** Threshold with the best F1 on this library, useful as a recommendation. */
  suggestedThreshold: number
  suggestedF1: number
  curve: AiThresholdMetric[]
  perTag: AiTagMetric[]
}

export interface MediaItem {
  id: string
  kind: MediaKind
  title: string
  /** Primary file (image / gif / video). Relative to root unless `linked`. */
  file: string
  linked: boolean
  bytes: number
  addedAt: number
  updatedAt: number
  width: number
  height: number
  durationMs?: number
  pages?: ComicPage[]
  coverIndex?: number
  /** Chosen video frame, ms. */
  thumbTimeMs?: number
  /** True when the thumbnail was uploaded instead of captured from the video. */
  thumbCustom?: boolean
  thumbVersion: number
  tags: string[]
  /**
   * Explicit membership in the inbox canvas. New imports start here and stay
   * here until the user removes them, regardless of how they are tagged.
   */
  inbox?: boolean
  /** Explicit membership in the AI review queue. */
  aiQueue?: boolean
  ai?: AiSuggestion[]
  aiSource?: 'local' | 'model'
  /** Tags the user rejected for this item; used as negative feedback. */
  rejectedTags?: string[]
  note?: string
  favorite?: boolean
  sha256?: string
  phash?: string
  /** 48-bin HSV histogram, normalised. */
  hist?: number[]
  color?: [number, number, number]
  /** Internal flag: a single-image item is already a lossless WebP. */
  convertedToWebp?: boolean
}

export interface TagCategory {
  id: string
  name: string
  color?: string
  /** Parent category for nesting. Missing means a top-level category. */
  parentId?: string
  createdAt: number
}

export interface Tag {
  id: string
  name: string
  color?: string
  /** Optional grouping category. Missing means uncategorized. */
  categoryId?: string
  createdAt: number
}

export interface AiSettings {
  enabled: boolean
  provider: 'local' | 'openai'
  baseUrl: string
  apiKey: string
  model: string
  /** Minimum score a suggestion needs to be shown (0..1). */
  minScore: number
  maxTags: number
}

export interface LibrarySettings {
  copyOnImport: boolean
  duplicateThreshold: number
  autoTagOnImport: boolean
  ai: AiSettings
  tileSize: number
}

export interface LibraryData {
  version: number
  id: string
  name: string
  createdAt: number
  root: string
  items: Record<string, MediaItem>
  tags: Tag[]
  categories: TagCategory[]
  settings: LibrarySettings
}

export interface ScanEntry {
  path: string
  name: string
  kind: MediaKind
  bytes: number
  isDir: boolean
  /** Present for directories: the ordered image list. */
  images?: { path: string; name: string; bytes: number }[]
}

export interface ProcessedPage {
  path: string
  width: number
  height: number
  bytes: number
}

export interface ProcessedImport {
  path: string
  kind: MediaKind
  title: string
  width: number
  height: number
  bytes: number
  durationMs?: number
  thumb?: ArrayBuffer
  phash?: string
  hist?: number[]
  color?: [number, number, number]
  pages?: ProcessedPage[]
  coverIndex?: number
  thumbTimeMs?: number
  note?: string
}

export interface ImportResult {
  added: MediaItem[]
  /** Existing items whose missing file was repaired and/or returned to the inbox. */
  restored: MediaItem[]
  skipped: number
  failed: { path: string; error: string }[]
}

export interface DuplicateEntry {
  item: MediaItem
  /** Perceptual distance from the group's suggested keeper. 0 = identical hash. */
  distance: number
  identical: boolean
  /** Suggested action when the group first appears. */
  suggested: 'keep' | 'delete'
}

export interface DuplicateGroup {
  id: string
  items: DuplicateEntry[]
  keep: string
  /** `identical` files only, near-identical variations, or a mix of both. */
  kind: 'identical' | 'variation' | 'mixed'
  /** Bytes freed if every entry marked `delete` is removed. */
  reclaimable: number
}

export interface AppInfo {
  version: string
  root: string
  platform: string
  name: string
  stats: { items: number; tags: number; bytes: number }
}

/** Contents of the library's trash folder: deleted files awaiting purge. */
export interface TrashInfo {
  files: number
  bytes: number
}

export type ViewId = 'inbox' | 'library' | 'duplicates' | 'ai' | 'settings'

export interface AiRunResult {
  id: string
  suggestions: AiSuggestion[]
  error?: string
}

export interface AiTestResult {
  ok: boolean
  message: string
}
