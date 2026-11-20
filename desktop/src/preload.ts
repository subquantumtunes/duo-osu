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
  setLaneBindings: (codes) => ipcRenderer.invoke(IPC.setLaneBindings, codes),
  setClient: (client) => ipcRenderer.send(IPC.setClient, client),
  aim: (x, y) => ipcRenderer.send(IPC.aim, x, y),
  key: (slot, down) => ipcRenderer.send(IPC.key, slot, down),
  release: () => ipcRenderer.send(IPC.release),
  onCaptureLost: (cb) => subscribe(IPC.captureLost, cb),
  onOsu: (cb) => subscribe(IPC.osu, cb),
  onTime: (cb) => subscribe(IPC.time, cb),
  onMap: (cb) => subscribe(IPC.map, cb),
  onSkin: (cb) => subscribe(IPC.skin, cb),
  startGameAudio: () => ipcRenderer.invoke(IPC.gameAudioStart),
  stopGameAudio: () => ipcRenderer.send(IPC.gameAudioStop),
  onGameAudio: (cb) => subscribe(IPC.gameAudio, cb),
  onGameAudioStatus: (cb) => subscribe(IPC.gameAudioStatus, cb),
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),
}

contextBridge.exposeInMainWorld('coop', api)
