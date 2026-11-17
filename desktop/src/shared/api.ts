export type TapSlot = 'k1' | 'k2'

export type ScreenSource = {
  id: string
  name: string
  width: number
  height: number
  primary: boolean
  thumbnail: string
}

export type OsuStatus = {
  source: 'tosu' | 'gosumemory' | null
  state: number | null
  mods: number
  offset: number | null
}

export type OsuMap = { checksum: string; text: string }

export type InputStatus = { native: boolean; reason: string | null }

export type CoopApi = {
  listScreens(): Promise<ScreenSource[]>
  selectScreen(id: string): Promise<{ width: number; height: number } | null>
  inputStatus(): Promise<InputStatus>
  osuSnapshot(): Promise<{ status: OsuStatus; map: OsuMap | null }>
  setBindings(k1: string, k2: string): Promise<boolean>
  aim(x: number, y: number): void
  key(slot: TapSlot, down: boolean): void
  release(): void
  onOsu(cb: (status: OsuStatus) => void): () => void
  onTime(cb: (ms: number) => void): () => void
  onMap(cb: (map: OsuMap) => void): () => void
}

export const IPC = {
  listScreens: 'coop:list-screens',
  selectScreen: 'coop:select-screen',
  inputStatus: 'coop:input-status',
  osuSnapshot: 'coop:osu-snapshot',
  setBindings: 'coop:set-bindings',
  aim: 'coop:aim',
  key: 'coop:key',
  release: 'coop:release',
  osu: 'coop:osu',
  time: 'coop:time',
  map: 'coop:map',
} as const
