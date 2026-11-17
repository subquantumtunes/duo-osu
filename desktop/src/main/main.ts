import os from 'node:os'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  type DesktopCapturerSource,
  desktopCapturer,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  powerSaveBlocker,
  screen,
  session,
  shell,
} from 'electron'
import { IPC, type ScreenSource } from '../shared/api'
import { createInjector } from './input'
import { OsuWatcher } from './osu-watcher'

const TOSU_PORT = 24050

// The host window sits behind osu! the whole session. Chromium normally throttles timers and
// renderer work for background and covered windows, which delays pings, clock packets and input.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('force_high_performance_gpu')

if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
let sources: DesktopCapturerSource[] = []
let selected: DesktopCapturerSource | null = null
const injector = createInjector()

const watcher = new OsuWatcher(TOSU_PORT, {
  status: (status) => win?.webContents.send(IPC.osu, status),
  time: (ms) => win?.webContents.send(IPC.time, ms),
  map: (map) => win?.webContents.send(IPC.map, map),
})

function fromHostWindow(event: IpcMainEvent | IpcMainInvokeEvent) {
  return win !== null && event.sender === win.webContents
}

function displayFor(source: DesktopCapturerSource) {
  const displays = screen.getAllDisplays()
  return displays.find((d) => String(d.id) === source.display_id) ?? screen.getPrimaryDisplay()
}

/** Physical pixel bounds, which is what SendInput works in. */
function physicalBounds(display: Electron.Display) {
  if (process.platform === 'win32') return screen.dipToScreenRect(null, display.bounds)
  const { x, y, width, height } = display.bounds
  const s = display.scaleFactor
  return { x: Math.round(x * s), y: Math.round(y * s), width: Math.round(width * s), height: Math.round(height * s) }
}

function raisePriority(pid: number) {
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL)
  } catch {}
}

function registerIpc() {
  ipcMain.handle(IPC.listScreens, async (event): Promise<ScreenSource[]> => {
    if (!fromHostWindow(event)) return []
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } })
    const primary = screen.getPrimaryDisplay().id
    return sources.map((source, index) => {
      const display = displayFor(source)
      const bounds = physicalBounds(display)
      return {
        id: source.id,
        name: sources.length > 1 ? `Screen ${index + 1}` : 'Your screen',
        width: bounds.width,
        height: bounds.height,
        primary: display.id === primary,
        thumbnail: source.thumbnail.toDataURL(),
      }
    })
  })

  ipcMain.handle(IPC.selectScreen, (event, id: unknown) => {
    if (!fromHostWindow(event) || typeof id !== 'string') return null
    const source = sources.find((s) => s.id === id)
    if (!source) return null
    selected = source
    const bounds = physicalBounds(displayFor(source))
    injector.setRegion(bounds)
    return { width: bounds.width, height: bounds.height }
  })

  ipcMain.handle(IPC.inputStatus, (event) =>
    fromHostWindow(event) ? { native: injector.native, reason: injector.reason } : null,
  )

  ipcMain.handle(IPC.osuSnapshot, (event) =>
    fromHostWindow(event) ? { status: watcher.status, map: watcher.map } : null,
  )

  ipcMain.handle(IPC.setBindings, (event, k1: unknown, k2: unknown) => {
    if (!fromHostWindow(event) || typeof k1 !== 'string' || typeof k2 !== 'string') return false
    return injector.setBindings(k1, k2)
  })

  ipcMain.on(IPC.aim, (event, x: unknown, y: unknown) => {
    if (!fromHostWindow(event) || typeof x !== 'number' || typeof y !== 'number') return
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    injector.aim(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)))
  })

  ipcMain.on(IPC.key, (event, slot: unknown, down: unknown) => {
    if (!fromHostWindow(event) || (slot !== 'k1' && slot !== 'k2')) return
    injector.key(slot, down === true)
  })

  ipcMain.on(IPC.release, (event) => {
    if (fromHostWindow(event)) injector.releaseAll()
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0b10',
    title: 'osu! co-op host',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('did-finish-load', () => {
    if (win) raisePriority(win.webContents.getOSProcessId())
  })
  win.webContents.on('render-process-gone', () => injector.releaseAll())
  win.on('closed', () => {
    injector.releaseAll()
    win = null
  })

  void win.loadFile(path.join(__dirname, 'index.html'))
}

app.whenReady().then(() => {
  raisePriority(process.pid)
  powerSaveBlocker.start('prevent-app-suspension')

  const ses = session.defaultSession
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(wc === win?.webContents && (permission === 'media' || permission === 'display-capture'))
  })
  // Capture the screen picked in the app instead of showing the system picker. On Windows the
  // loopback device carries the game audio.
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (!selected) return callback(null)
      callback(process.platform === 'win32' ? { video: selected, audio: 'loopback' } : { video: selected })
    },
    { useSystemPicker: false },
  )

  registerIpc()
  createWindow()
  watcher.start()
})

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.on('window-all-closed', () => app.quit())

app.on('will-quit', () => {
  watcher.stop()
  injector.dispose()
})
