import { BrowserWindow, Menu, app, shell } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { registerScheme, installProtocol } from './protocol'
import {
  attachWindow,
  currentLibrary,
  initLibrary,
  isLibraryReady,
  registerIpc
} from './ipc'
import { readConfig, writeConfig } from './library'
import { runSmoke } from './smoke'

const isSmoke = process.argv.includes('--smoke')
const isDev = !app.isPackaged

if (isSmoke) {
  process.env.VAULT_SMOKE = '1'
  process.env.VAULT_ROOT = join(app.getPath('temp'), 'vault-smoke-lib')
  // Keep the smoke run out of the installed app's profile so it can run while
  // a normal Vault window is open.
  app.setPath('userData', join(app.getPath('temp'), 'vault-smoke-userdata'))
}

registerScheme()

const gotLock = isSmoke ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const cfg = readConfig()
  const win = new BrowserWindow({
    width: cfg.window?.width ?? 1500,
    height: cfg.window?.height ?? 950,
    x: cfg.window?.x,
    y: cfg.window?.y,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#0a0a0b',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a0b',
      symbolColor: '#8f8f9a',
      height: 46
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    if (isDev && process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' })
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  if (isSmoke) {
    win.webContents.on('console-message', (...args: unknown[]) => {
      const details = args[1] as { message?: string; level?: string } | undefined
      if (details && typeof details === 'object' && 'message' in details) {
        console.log(`[renderer:${details.level ?? 'log'}] ${details.message}`)
      } else {
        console.log('[renderer]', ...args.slice(1, 4))
      }
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[renderer gone]', details)
    })
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[load failed]', code, desc)
    })
  }

  const saveBounds = (): void => {
    if (win.isDestroyed()) return
    const b = win.getBounds()
    const c = readConfig()
    c.window = { x: b.x, y: b.y, width: b.width, height: b.height }
    writeConfig(c)
  }
  win.on('close', saveBounds)

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.ian.vault')
  Menu.setApplicationMenu(null)

  if (isSmoke && process.env.VAULT_ROOT) {
    await rm(process.env.VAULT_ROOT, { recursive: true, force: true }).catch(() => {})
  }

  await initLibrary()
  registerIpc()
  installProtocol(() => (isLibraryReady() ? currentLibrary() : null))

  mainWindow = createWindow()
  attachWindow(mainWindow)

  if (isSmoke) {
    await runSmoke(mainWindow)
    return
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      attachWindow(mainWindow)
    }
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

let flushed = false
app.on('before-quit', (event) => {
  if (flushed || !isLibraryReady()) return
  event.preventDefault()
  flushed = true
  currentLibrary()
    .flush()
    .catch(() => {})
    .finally(() => app.quit())
})
