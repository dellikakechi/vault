import type {
  AiEvaluation,
  AiRunResult,
  AiTestResult,
  AppInfo,
  DuplicateGroup,
  ImportResult,
  LibraryData,
  LibrarySettings,
  MediaItem,
  ProcessedImport,
  ScanEntry,
  Tag,
  TagCategory,
  TrashInfo
} from './types'

export interface VaultApi {
  smoke: boolean
  info(): Promise<AppInfo>
  getLibrary(): Promise<LibraryData>
  chooseRoot(): Promise<LibraryData | null>
  pickFiles(): Promise<string[]>
  pickFolders(): Promise<string[]>
  scan(paths: string[]): Promise<ScanEntry[]>
  commitImport(items: ProcessedImport[]): Promise<ImportResult>
  updateItem(id: string, patch: Partial<MediaItem>): Promise<MediaItem | null>
  deleteItems(ids: string[]): Promise<{ removed: number; kept: number }>
  createImageSet(ids: string[]): Promise<MediaItem | null>
  trashInfo(): Promise<TrashInfo>
  emptyTrash(): Promise<TrashInfo>
  convertImage(
    id: string,
    pageIndex: number | null,
    data: ArrayBuffer,
    width: number,
    height: number
  ): Promise<MediaItem | null>
  setThumb(
    id: string,
    data: ArrayBuffer,
    meta: { thumbTimeMs?: number; coverIndex?: number; custom?: boolean }
  ): Promise<MediaItem | null>
  addTag(name: string, color?: string): Promise<Tag>
  renameTag(id: string, name: string): Promise<Tag | null>
  deleteTag(id: string): Promise<boolean>
  addCategory(name: string, color?: string, parentId?: string | null): Promise<TagCategory>
  setCategoryParent(id: string, parentId: string | null): Promise<TagCategory | null>
  renameCategory(id: string, name: string): Promise<TagCategory | null>
  deleteCategory(id: string): Promise<boolean>
  setTagCategory(tagId: string, categoryId: string | null): Promise<Tag | null>
  applyTags(ids: string[], add: string[], remove: string[]): Promise<MediaItem[]>
  setMembership(
    ids: string[],
    patch: { inbox?: boolean; aiQueue?: boolean }
  ): Promise<MediaItem[]>
  findDuplicates(threshold: number): Promise<DuplicateGroup[]>
  aiSuggest(ids: string[], useModel: boolean): Promise<AiRunResult[]>
  aiAccept(id: string, tags: string[], rejected?: string[]): Promise<MediaItem | null>
  aiAcceptMany(
    entries: { id: string; tags: string[]; rejected?: string[] }[]
  ): Promise<MediaItem[]>
  aiReject(ids: string[]): Promise<MediaItem[]>
  aiEvaluate(maxItems?: number): Promise<AiEvaluation>
  aiTest(): Promise<AiTestResult>
  setSettings(patch: Partial<LibrarySettings>): Promise<LibrarySettings>
  reveal(id: string): Promise<boolean>
  openRoot(): Promise<boolean>
  /** Hide the window chrome (native caption buttons) while an immersive view is open. */
  setImmersive(on: boolean): Promise<void>
  writeTemp(name: string, data: ArrayBuffer): Promise<string>
  tempPath(): Promise<string>
  pathForFile(file: File): string
  onLibraryChanged(cb: () => void): () => void
}

export function thumbUrl(item: MediaItem): string {
  return `vault://t/${item.id}?v=${item.thumbVersion}`
}

export function encodePath(p: string): string {
  // base64url, matching the main-process decoder.
  const bytes = new TextEncoder().encode(p)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fileUrl(relOrAbs: string): string {
  return `vault://m/${encodePath(relOrAbs)}`
}

export function stagingUrl(absPath: string): string {
  return `vault://a/${encodePath(absPath)}`
}
