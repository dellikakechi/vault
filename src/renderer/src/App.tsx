import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { runImport } from './lib/importRunner'
import { installSmokeHooks } from './smokeHooks'
import { TitleBar, IconRail } from './components/Chrome'
import { DetailPanel } from './components/DetailPanel'
import { VideoFramePicker } from './components/VideoFramePicker'
import { ComicCoverPicker } from './components/ComicCoverPicker'
import { ComicReader } from './components/ComicReader'
import { ImageViewer } from './components/ImageViewer'
import { TagManager } from './components/TagManager'
import { ConfirmDialog, ConvertDock, ImportDock, Toasts } from './components/ui'
import { Icon } from './components/Icon'
import { InboxView } from './views/InboxView'
import { LibraryView } from './views/LibraryView'
import { DuplicatesView } from './views/DuplicatesView'
import { AiView } from './views/AiView'
import { SettingsView } from './views/SettingsView'

type ImportKind = 'files' | 'folder'

export default function App(): React.JSX.Element {
  const lib = useStore((s) => s.lib)
  const loadError = useStore((s) => s.loadError)
  const view = useStore((s) => s.view)
  const init = useStore((s) => s.init)

  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => installSmokeHooks(), [])

  // Switching the library folder replaces every item, so reload from disk.
  useEffect(() => {
    return window.vault.onLibraryChanged(() => {
      void window.vault.getLibrary().then((next) => {
        useStore.getState().hydrate(next)
        useStore.getState().setView('inbox')
      })
    })
  }, [])

  const openImport = useCallback(async (kind: ImportKind) => {
    const paths =
      kind === 'files' ? await window.vault.pickFiles() : await window.vault.pickFolders()
    if (paths.length) await runImport(paths)
  }, [])

  const onDragEnter = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  const onDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const paths = [...e.dataTransfer.files]
      .map((file) => window.vault.pathForFile(file))
      .filter((p): p is string => !!p)
    if (paths.length) await runImport(paths)
  }

  // Global shortcuts. Escape always peels one layer at a time.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('.titlebar-search input')?.focus()
        return
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openImport('files')
        return
      }
      if (e.key === 'Escape') {
        const store = useStore.getState()
        if (store.confirm) return store.closeConfirm()
        if (store.readerId) return store.setReader(null)
        if (store.videoToolId) return store.setVideoTool(null)
        if (store.coverToolId) return store.setCoverTool(null)
        if (store.tagManagerOpen) return store.setTagManagerOpen(false)
        if (store.detailId) return store.setDetail(null)
        if (store.selected.size) return store.clearSelection()
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
        const store = useStore.getState()
        if (store.confirm || store.readerId || store.videoToolId || store.coverToolId || store.detailId || store.tagManagerOpen) return
        if (!store.selected.size) return
        e.preventDefault()
        const ids = [...store.selected]
        store.confirmAction({
          title: `Delete ${ids.length} ${ids.length === 1 ? 'item' : 'items'}?`,
          body: 'Files move to the library trash folder, so they can be recovered from disk if needed.',
          confirmLabel: 'Move to trash',
          danger: true,
          onConfirm: () => void useStore.getState().deleteItems(ids)
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openImport])

  if (!lib) {
    return (
      <div className="splash">
        <div className="splash-inner">
          <div className="splash-mark" />
          {loadError ? (
            <>
              <span style={{ color: 'var(--danger)', maxWidth: 460, textAlign: 'center' }}>
                {loadError}
              </span>
              <button className="btn" onClick={() => void init()}>
                Try again
              </button>
            </>
          ) : (
            <span>Opening your vault…</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      <TitleBar onImport={(kind) => void openImport(kind)} />

      <div className="shell">
        <IconRail />
        <div className="main">
          {view === 'inbox' ? <InboxView /> : null}
          {view === 'library' ? (
            <LibraryView onImport={(kind) => void openImport(kind)} />
          ) : null}
          {view === 'duplicates' ? <DuplicatesView /> : null}
          {view === 'ai' ? <AiView /> : null}
          {view === 'settings' ? <SettingsView /> : null}

          <DetailPanel />
        </div>
      </div>

      <VideoFramePicker />
      <ComicCoverPicker />
      <ComicReader />
      <ImageViewer />
      <TagManager />
      <ConfirmDialog />
      <ImportDock />
      <ConvertDock />
      <Toasts />

      {dragging ? (
        <div className="drop-overlay">
          <div className="drop-frame">
            <Icon name="inbox" size={30} />
            <h2>Drop into the inbox</h2>
            <p>Images, GIFs and video are added as-is. A folder becomes a comic.</p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
