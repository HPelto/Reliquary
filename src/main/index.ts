import { app, shell, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { autoUpdater } from 'electron-updater'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

const VOID_0 = '#07080C'

/**
 * Auto-update. The app checks a release feed (configured via electron-builder's
 * publish block) on launch and every 6 hours, downloads new versions silently,
 * and installs them on the next quit/restart — user data lives outside the
 * install dir, so it always survives. Disabled in dev (no app-update.yml).
 */
function sendUpdate(payload: Record<string, unknown>): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update:event', payload)
  }
}

function setupAutoUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  // install ONLY when the user chooses "Update now" — so "Ignore"/"Remind me
  // tomorrow" are honored and an update never installs behind their back on quit.
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => sendUpdate({ status: 'checking-for-update' }))
  autoUpdater.on('update-available', (i) => sendUpdate({ status: 'update-available', version: i.version }))
  autoUpdater.on('update-not-available', () => sendUpdate({ status: 'update-not-available' }))
  autoUpdater.on('download-progress', (p) =>
    sendUpdate({ status: 'download-progress', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ status: 'update-downloaded', version: i.version }))
  autoUpdater.on('error', (e) => sendUpdate({ status: 'error', message: String(e?.message ?? e) }))

  void autoUpdater.checkForUpdates().catch(() => {})
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 24 * 60 * 60 * 1000)
}

/**
 * Durable key-value storage for the renderer (identity, saved keeps).
 * localStorage proved lossy — Chromium flushes it lazily, so a hard kill
 * of the dev process ate user data. This is a plain JSON file written
 * atomically (temp file + rename), so it survives any kind of shutdown.
 */
class FileStorage {
  private path: string
  private data: Record<string, string> = {}

  constructor() {
    this.path = join(app.getPath('userData'), 'reliquary-data.json')
    try {
      this.data = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>
    } catch {
      this.data = {}
    }
  }

  get(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null
  }

  set(key: string, value: string): void {
    this.data[key] = value
    this.flush()
  }

  remove(key: string): void {
    delete this.data[key]
    this.flush()
  }

  private flush(): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      const tmp = this.path + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.path)
    } catch (err) {
      console.error('storage flush failed:', err)
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    // Native (but themed) caption buttons on Windows — keeps Snap Layouts,
    // hover flyouts and accessibility for free. Everything else is ours.
    titleBarOverlay: {
      color: VOID_0,
      symbolColor: '#9BA1B5',
      height: 38
    },
    backgroundColor: VOID_0,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const sendWindowState = (): void => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:state', win.isMaximized())
    }
  }
  win.on('maximize', sendWindowState)
  win.on('unmaximize', sendWindowState)

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'

  const storage = new FileStorage()
  // sync get: the renderer needs identity state before first paint
  ipcMain.on('storage:get', (e, key: string) => {
    e.returnValue = storage.get(key)
  })
  ipcMain.on('storage:set', (_e, key: string, value: string) => storage.set(key, value))
  ipcMain.on('storage:remove', (_e, key: string) => storage.remove(key))

  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { disabled: true }
    try {
      const r = await autoUpdater.checkForUpdates()
      return { ok: true, version: r?.updateInfo?.version }
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) }
    }
  })
  ipcMain.handle('update:install', () => {
    if (app.isPackaged) autoUpdater.quitAndInstall()
  })
  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  createWindow()
  setupAutoUpdate()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
