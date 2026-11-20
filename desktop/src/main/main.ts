import os from 'node:os'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  type DesktopCapturerSource,
  desktopCapturer,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  powerSaveBlocker,
  screen,
  session,
  shell,
} from 'electron'
import { IPC, isTapSlot, type ScreenSource } from '../shared/api'
import { GameAudio } from './game-audio'
import { createInjector } from './input'
import { OsuWatcher } from './osu-watcher'
import { TosuManager } from './tosu'
import { createWindowTools, hwndFromSourceId } from './window-target'

const TOSU_PORT = 24050

// The host window sits behind osu! the whole session. Chromium normally throttles timers and
// renderer work for background and covered windows, which delays pings, clock packets and input.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('force_high_performance_gpu')
// Windows Graphics Capture often delivers no frames or black frames for a fullscreen game on
// another window's monitor. The DXGI desktop duplicator captures what the display shows.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'AllowWgcScreenCapturer')

if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
let sources: DesktopCapturerSource[] = []
let selected: DesktopCapturerSource | null = null
let tosu: TosuManager | null = null
const injector = createInjector()
const windows = createWindowTools()
const OSU_EXE = 'osu!.exe'
let trackTimer: NodeJS.Timeout | null = null

function stopTracking() {
  if (trackTimer) clearInterval(trackTimer)
  trackTimer = null
}

/** Keeps the aim region on the osu! window as it moves or resizes, and reports when it closes. */
function trackWindow(hwnd: number) {
  stopTracking()
  trackTimer = setInterval(() => {
    if (!windows?.alive(hwnd)) {
      stopTracking()
      send(IPC.captureLost)
      return
    }
    const bounds = windows.bounds(hwnd)
    if (bounds) injector.setRegion(bounds)
  }, 500)
}

const OSU_PLAYING = 2

/** Sends to the host window, skipping it once closing has destroyed its webContents. */
function send(channel: string, ...args: unknown[]) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, ...args)
}

/** The partner only drives input while a map is being played, never in menus or song select. */
function partnerInputAllowed() {
  return watcher.status.source !== null && watcher.status.state === OSU_PLAYING
}

let wasPlaying = false

const watcher = new OsuWatcher(TOSU_PORT, {
  status: (status) => {
    const playing = status.source !== null && status.state === OSU_PLAYING
    if (wasPlaying && !playing) injector.releaseAll()
    wasPlaying = playing
    send(IPC.osu, status)
  },
  time: (ms) => send(IPC.time, ms),
  map: (map) => send(IPC.map, map),
  skin: (skin) => send(IPC.skin, skin),
})

const gameAudio = new GameAudio(
  (chunk) => send(IPC.gameAudio, chunk),
  (status) => send(IPC.gameAudioStatus, status),
)

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
    const all = await desktopCapturer.getSources({
      types: windows ? ['window', 'screen'] : ['screen'],
      thumbnailSize: { width: 320, height: 180 },
    })
    // Only offer osu!'s own window, matched by its executable so browser tabs titled "osu!" don't show up.
    const osuWindows = all.filter((s) => {
      const hwnd = hwndFromSourceId(s.id)
      return hwnd !== null && windows?.exeName(hwnd) === OSU_EXE
    })
    const screens = all.filter((s) => s.id.startsWith('screen:'))
    sources = [...osuWindows, ...screens]
    const primary = screen.getPrimaryDisplay().id
    const windowList: ScreenSource[] = osuWindows.map((source) => {
      const bounds = windows?.bounds(hwndFromSourceId(source.id) ?? 0)
      return {
        id: source.id,
        kind: 'window',
        name: osuWindows.length > 1 ? `osu! window (${source.name})` : 'osu! window',
        width: bounds?.width ?? 0,
        height: bounds?.height ?? 0,
        primary: false,
        thumbnail: source.thumbnail.toDataURL(),
      }
    })
    const screenList: ScreenSource[] = screens.map((source, index) => {
      const display = displayFor(source)
      const bounds = physicalBounds(display)
      return {
        id: source.id,
        kind: 'screen',
        name: screens.length > 1 ? `Screen ${index + 1}` : 'Your screen',
        width: bounds.width,
        height: bounds.height,
        primary: display.id === primary,
        thumbnail: source.thumbnail.toDataURL(),
      }
    })
    return [...windowList, ...screenList]
  })

  ipcMain.handle(IPC.selectScreen, (event, id: unknown) => {
    if (!fromHostWindow(event) || typeof id !== 'string') return null
    const source = sources.find((s) => s.id === id)
    if (!source) return null
    const hwnd = hwndFromSourceId(source.id)
    if (hwnd !== null) {
      const bounds = windows?.bounds(hwnd)
      if (!bounds) return null
      selected = source
      injector.setRegion(bounds)
      trackWindow(hwnd)
      return { width: bounds.width, height: bounds.height }
    }
    stopTracking()
    selected = source
    const bounds = physicalBounds(displayFor(source))
    injector.setRegion(bounds)
    return { width: bounds.width, height: bounds.height }
  })

  ipcMain.handle(IPC.inputStatus, (event) =>
    fromHostWindow(event) ? { native: injector.native, reason: injector.reason } : null,
  )

  ipcMain.handle(IPC.osuSnapshot, (event) =>
    fromHostWindow(event) ? { status: watcher.status, map: watcher.map, skin: watcher.skin } : null,
  )

  ipcMain.handle(IPC.setBindings, (event, k1: unknown, k2: unknown) => {
    if (!fromHostWindow(event) || typeof k1 !== 'string' || typeof k2 !== 'string') return false
    return injector.setBindings(k1, k2)
  })

  ipcMain.handle(IPC.setLaneBindings, (event, codes: unknown) => {
    if (!fromHostWindow(event) || !Array.isArray(codes) || codes.length > 10) return false
    if (!codes.every((code) => typeof code === 'string')) return false
    return injector.setLaneBindings(codes)
  })

  ipcMain.on(IPC.setClient, (event, client: unknown) => {
    if (!fromHostWindow(event) || (client !== 'stable' && client !== 'lazer')) return
    watcher.setClient(client)
  })

  ipcMain.on(IPC.aim, (event, x: unknown, y: unknown) => {
    if (!fromHostWindow(event) || typeof x !== 'number' || typeof y !== 'number') return
    if (!Number.isFinite(x) || !Number.isFinite(y) || !partnerInputAllowed()) return
    injector.aim(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)))
  })

  ipcMain.on(IPC.key, (event, slot: unknown, down: unknown) => {
    if (!fromHostWindow(event) || !isTapSlot(slot)) return
    if (down === true && !partnerInputAllowed()) return
    injector.key(slot, down === true)
  })

  ipcMain.on(IPC.release, (event) => {
    if (fromHostWindow(event)) injector.releaseAll()
  })

  ipcMain.handle(IPC.gameAudioStart, (event) => (fromHostWindow(event) ? gameAudio.start() : null))

  // The renderer's permission handler denies clipboard access, so copy through the main process.
  ipcMain.handle(IPC.copyText, (event, text: unknown) => {
    if (!fromHostWindow(event) || typeof text !== 'string' || text.length > 256) return false
    clipboard.writeText(text)
    return true
  })

  ipcMain.on(IPC.gameAudioStop, (event) => {
    if (fromHostWindow(event)) gameAudio.stop()
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0b10',
    title: 'duosu host',
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
    win = null
    stopTracking()
    injector.releaseAll()
    gameAudio.stop()
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
  // Capture the screen picked in the app instead of showing the system picker. Audio is not taken
  // from here: system loopback would include Discord and everything else, so GameAudio captures
  // the osu! process on its own.
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (!selected) return callback(null)
      callback({ video: selected })
    },
    { useSystemPicker: false },
  )

  registerIpc()
  createWindow()
  watcher.start()

  tosu = new TosuManager(
    TOSU_PORT,
    path.join(app.getPath('userData'), 'tosu'),
    app.isPackaged ? path.join(process.resourcesPath, 'tosu') : null,
    (message) => win?.setTitle(`duosu host — ${message}`),
  )
  tosu
    .ensure()
    .then(() => win?.setTitle('duosu host'))
    .catch((error: unknown) => {
      win?.setTitle('duosu host')
      const detail = error instanceof Error ? error.message : String(error)
      void dialog.showMessageBox({
        type: 'warning',
        title: 'tosu',
        message: 'duosu could not start tosu automatically.',
        detail: `${detail}\n\nYou can download tosu from github.com/tosuapp/tosu and run it yourself.`,
      })
    })
})

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.on('window-all-closed', () => app.quit())

app.on('will-quit', () => {
  tosu?.stop()
  watcher.stop()
  injector.dispose()
})
