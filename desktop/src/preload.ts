import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { type CoopApi, IPC } from './shared/api'

function subscribe<T>(channel: string, cb: (value: T) => void) {
  const listener = (_event: IpcRendererEvent, value: T) => cb(value)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: CoopApi = {
  listScreens: () => ipcRenderer.invoke(IPC.listScreens),
  selectScreen: (id) => ipcRenderer.invoke(IPC.selectScreen, id),
  inputStatus: () => ipcRenderer.invoke(IPC.inputStatus),
  osuSnapshot: () => ipcRenderer.invoke(IPC.osuSnapshot),
  setBindings: (k1, k2) => ipcRenderer.invoke(IPC.setBindings, k1, k2),
  aim: (x, y) => ipcRenderer.send(IPC.aim, x, y),
  key: (slot, down) => ipcRenderer.send(IPC.key, slot, down),
  release: () => ipcRenderer.send(IPC.release),
  onOsu: (cb) => subscribe(IPC.osu, cb),
  onTime: (cb) => subscribe(IPC.time, cb),
  onMap: (cb) => subscribe(IPC.map, cb),
  onSkin: (cb) => subscribe(IPC.skin, cb),
}

contextBridge.exposeInMainWorld('coop', api)
