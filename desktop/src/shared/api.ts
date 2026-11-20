/** `l0`..`l9` are taiko drums or mania columns, counted from the left. */
export type TapSlot = 'k1' | 'k2' | `l${number}`

export function isTapSlot(value: unknown): value is TapSlot {
  return value === 'k1' || value === 'k2' || (typeof value === 'string' && /^l\d$/.test(value))
}

export type ScreenSource = {
  id: string
  /** `window` is the osu! game window itself; `screen` is a whole monitor. */
  kind: 'window' | 'screen'
  name: string
  width: number
  height: number
  primary: boolean
  thumbnail: string
}

export type GameClient = 'stable' | 'lazer'

export type OsuStatus = {
  source: 'tosu' | 'gosumemory' | null
  /** The client picked in the host app. */
  client: GameClient
  /** The client tosu reports, used to warn when it doesn't match the pick. */
  detected: GameClient | null
  state: number | null
  mods: number
  offset: number | null
  /** The map osu! reports right now, and whether its exact .osu file has been found. */
  checksum: string | null
  mapReady: boolean
  /** The ruleset osu! is set to (0 standard, 1 taiko, 2 catch, 3 mania). */
  ruleset: number | null
  /** tosu's key count for the map in mania, which also covers converted maps. */
  keys: number | null
}

export type OsuMap = { checksum: string; text: string }

export type SkinImage = { hd: boolean; data: string }
export type OsuSkin = { id: string; ini: string | null; images: Record<string, SkinImage> }

export type InputStatus = { native: boolean; reason: string | null }

export type GameAudioStatus = { active: boolean; reason: string | null }

export type CoopApi = {
  listScreens(): Promise<ScreenSource[]>
  selectScreen(id: string): Promise<{ width: number; height: number } | null>
  inputStatus(): Promise<InputStatus>
  osuSnapshot(): Promise<{ status: OsuStatus; map: OsuMap | null; skin: OsuSkin | null }>
  setBindings(k1: string, k2: string): Promise<boolean>
  /** The osu! key for each taiko drum or mania column, left to right. */
  setLaneBindings(codes: string[]): Promise<boolean>
  setClient(client: GameClient): void
  aim(x: number, y: number): void
  key(slot: TapSlot, down: boolean): void
  release(): void
  /** The captured osu! window closed (for example osu! restarted). */
  onCaptureLost(cb: () => void): () => void
  onOsu(cb: (status: OsuStatus) => void): () => void
  onTime(cb: (ms: number) => void): () => void
  onMap(cb: (map: OsuMap) => void): () => void
  onSkin(cb: (skin: OsuSkin) => void): () => void
  startGameAudio(): Promise<GameAudioStatus>
  stopGameAudio(): void
  onGameAudio(cb: (chunk: Uint8Array) => void): () => void
  onGameAudioStatus(cb: (status: GameAudioStatus) => void): () => void
  copyText(text: string): Promise<boolean>
}

export const IPC = {
  listScreens: 'coop:list-screens',
  selectScreen: 'coop:select-screen',
  captureLost: 'coop:capture-lost',
  inputStatus: 'coop:input-status',
  osuSnapshot: 'coop:osu-snapshot',
  setBindings: 'coop:set-bindings',
  setLaneBindings: 'coop:set-lane-bindings',
  setClient: 'coop:set-client',
  aim: 'coop:aim',
  key: 'coop:key',
  release: 'coop:release',
  osu: 'coop:osu',
  time: 'coop:time',
  map: 'coop:map',
  skin: 'coop:skin',
  gameAudioStart: 'coop:game-audio-start',
  gameAudioStop: 'coop:game-audio-stop',
  gameAudio: 'coop:game-audio',
  gameAudioStatus: 'coop:game-audio-status',
  copyText: 'coop:copy-text',
} as const
