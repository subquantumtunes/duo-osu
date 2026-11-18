import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import type { GameClient, OsuMap, OsuSkin, OsuStatus } from '../shared/api'
import { fetchSkin } from './skin-loader'

const PLAYING = 2
const MAX_MAP_BYTES = 4_000_000
const MIN_TIME_INTERVAL_MS = 3
const RETRY_MS = 3000
const SKIN_RETRY_MS = 15_000
const MAP_FETCH_TIMEOUT_MS = 3000
/** No images, so the partner page falls back to its own circles for every sprite. */
const BUILT_IN_SKIN: OsuSkin = { id: 'built-in', ini: null, images: {} }

type Events = {
  status(status: OsuStatus): void
  time(ms: number): void
  map(map: OsuMap): void
  skin(skin: OsuSkin): void
}

type Json = Record<string, any>

/** Follows osu! stable or lazer through tosu (or stable through gosumemory) so the partner can draw the map locally. */
export class OsuWatcher {
  status: OsuStatus = { source: null, client: 'stable', detected: null, state: null, mods: 0, offset: null }
  map: OsuMap | null = null
  skin: OsuSkin | null = null
  private lazerFiles: string | null = null
  private skinId: string | null = null
  private skinLoading = false
  private skinRetryAt = 0
  private checksum: string | null = null
  private mapRetryAt = 0
  private precise = false
  private lastTimeSent = 0
  private stopped = false
  private sockets = new Set<WebSocket>()

  constructor(
    private port: number,
    private events: Events,
  ) {}

  start() {
    void this.loop()
  }

  /**
   * Lazer keeps skins inside its file store, which tosu can't serve, so lazer always sends the
   * partner page's built-in look. Stable reloads the skin osu! is using.
   */
  setClient(client: GameClient) {
    if (client === this.status.client && (client === 'stable' || this.skin === BUILT_IN_SKIN)) return
    this.set({ client })
    this.checksum = null
    this.map = null
    if (client === 'lazer') {
      void lazerFilesDir().then((dir) => {
        this.lazerFiles = dir
      })
      this.skinId = BUILT_IN_SKIN.id
      this.skin = BUILT_IN_SKIN
      this.events.skin(BUILT_IN_SKIN)
    } else {
      this.skinId = null
      this.skin = null
      this.skinRetryAt = 0
    }
  }

  stop() {
    this.stopped = true
    for (const ws of this.sockets) ws.terminate()
  }

  private async loop() {
    while (!this.stopped) {
      await this.followTosu()
      if (this.stopped) return
      if (this.status.source === null) await this.followGosumemory()
      this.set({ source: null, detected: null, state: null })
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
    }
  }

  /** Resolves once the socket closes or fails to connect. */
  private stream(url: string, onOpen: (() => void) | null, onMessage: (data: Json) => void) {
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(url, { perMessageDeflate: false })
      this.sockets.add(ws)
      ws.on('open', () => onOpen?.())
      ws.on('message', (raw) => {
        try {
          onMessage(JSON.parse(raw.toString()))
        } catch {}
      })
      ws.on('error', () => {})
      ws.on('close', () => {
        this.sockets.delete(ws)
        resolve()
      })
    })
  }

  private async followTosu() {
    const base = `ws://127.0.0.1:${this.port}`
    let precise: Promise<void> | null = null
    await this.stream(
      `${base}/websocket/v2`,
      () => {
        this.set({ source: 'tosu' })
        // Newer tosu builds dropped currentTime from the precise feed; only switch away from
        // beatmap.time.live once this feed actually carries a time.
        precise = this.stream(`${base}/websocket/v2/precise`, null, (data) => {
          if (typeof data.currentTime !== 'number') return
          this.precise = true
          this.time(data.currentTime)
        }).then(() => {
          this.precise = false
        })
      },
      (data) => {
        const state = data.state?.number ?? null
        const mods = state === PLAYING ? (data.play?.mods?.number ?? 0) : this.status.mods
        const offset = data.settings?.audio?.offset?.universal
        const detected = typeof data.client === 'string' && data.client.toLowerCase().includes('lazer') ? 'lazer' : 'stable'
        this.set({ detected, state, mods, offset: typeof offset === 'number' ? offset : null })
        const songs = data.folders?.songs
        // Lazer reports the .osu file relative to its hashed file store (e.g. "3\38\<sha256>"),
        // with an empty songs folder, so it has to be joined to the store's location.
        const lazer = this.status.client === 'lazer' || detected === 'lazer'
        void this.loadMap(data.beatmap?.checksum, [
          ...(lazer
            ? [joinIfStrings(this.lazerFiles, data.files?.beatmap), joinIfStrings(this.lazerFiles, data.directPath?.beatmapFile)]
            : []),
          joinIfStrings(songs, data.folders?.beatmap, data.files?.beatmap),
          joinIfStrings(data.directPath?.beatmapFile),
          joinIfStrings(songs, data.directPath?.beatmapFile),
        ])
        if (!this.precise) this.time(data.beatmap?.time?.live)
        if (this.status.client === 'stable') {
          const skinName = data.folders?.skin
          void this.loadSkin(typeof skinName === 'string' && skinName ? skinName : 'current')
        }
      },
    )
    for (const ws of this.sockets) if (ws.url.endsWith('/precise')) ws.terminate()
    await precise
  }

  private async followGosumemory() {
    await this.stream(
      `ws://127.0.0.1:${this.port}/ws`,
      () => this.set({ source: 'gosumemory', detected: 'stable' }),
      (data) => {
        const menu = data.menu ?? {}
        const bm = menu.bm ?? {}
        const file = bm.path?.file
        this.set({ state: menu.state ?? null, mods: menu.mods?.num ?? 0 })
        void this.loadMap(bm.md5, [joinIfStrings(data.settings?.folders?.songs, bm.path?.folder, file)])
        this.time(bm.time?.current)
      },
    )
  }

  private set(changes: Partial<OsuStatus>) {
    const next = { ...this.status, ...changes }
    const changed = (Object.keys(changes) as (keyof OsuStatus)[]).some((key) => this.status[key] !== next[key])
    if (!changed) return
    this.status = next
    this.events.status(next)
  }

  private time(value: unknown) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    const now = performance.now()
    if (now - this.lastTimeSent < MIN_TIME_INTERVAL_MS) return
    this.lastTimeSent = now
    this.events.time(value)
  }

  /** Refetches only when the skin folder changes, or after a failed attempt has cooled down. */
  private async loadSkin(id: string) {
    if (this.skinLoading) return
    if (id === this.skinId && (this.skin || performance.now() < this.skinRetryAt)) return
    this.skinId = id
    this.skinLoading = true
    try {
      const skin = await fetchSkin(this.port, id)
      if (this.skinId !== id || this.status.client !== 'stable') return
      this.skin = skin
      if (skin) {
        this.events.skin(skin)
      } else {
        this.skinRetryAt = performance.now() + SKIN_RETRY_MS
        console.warn(`[osu-coop] Couldn't load the skin "${id}" from tosu; the partner sees the built-in circles.`)
      }
    } finally {
      this.skinLoading = false
    }
  }

  /**
   * Tries each candidate path in order; tosu versions disagree on which fields hold the folder.
   * Lazer keeps maps in a hashed file store with no Songs folder, so after the local paths fail
   * this asks tosu for the current .osu file over HTTP.
   */
  private async loadMap(checksum: unknown, candidates: (string | null)[]) {
    const files = [...new Set(candidates.filter((file): file is string => !!file && path.isAbsolute(file)))]
    if (typeof checksum !== 'string' || !checksum) return
    if (checksum === this.checksum && (this.map || performance.now() < this.mapRetryAt)) return
    this.checksum = checksum
    this.mapRetryAt = performance.now() + RETRY_MS
    let lastError: unknown = null
    for (const file of files) {
      try {
        const info = await stat(file)
        if (!info.isFile()) continue
        if (info.size > MAX_MAP_BYTES) throw new Error('file is too large')
        const text = await readFile(file, 'utf8')
        if (this.checksum !== checksum) return
        this.map = { checksum, text }
        this.events.map(this.map)
        return
      } catch (err) {
        lastError = err
      }
    }
    if (this.status.source === 'tosu') {
      const text = await this.fetchMapFromTosu()
      if (this.checksum !== checksum) return
      if (text) {
        this.map = { checksum, text }
        this.events.map(this.map)
        return
      }
    }
    console.warn(
      `[osu-coop] Couldn't read the beatmap file (tried ${files.join(', ')}): ${lastError instanceof Error ? lastError.message : (lastError ?? 'not found')}`,
    )
    this.map = null
  }

  private async fetchMapFromTosu() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/files/beatmap/file`, {
        signal: AbortSignal.timeout(MAP_FETCH_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const text = await res.text()
      return text.length > 0 && text.length <= MAX_MAP_BYTES && text.includes('[HitObjects]') ? text : null
    } catch {
      return null
    }
  }
}

/**
 * Lazer's data folder defaults to %APPDATA%\osu; moving it in lazer's settings writes the new
 * location to storage.ini there as "FullPath = ...".
 */
async function lazerFilesDir() {
  const base = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'osu')
    : path.join(os.homedir(), '.local', 'share', 'osu')
  try {
    const ini = await readFile(path.join(base, 'storage.ini'), 'utf8')
    const custom = /^\s*FullPath\s*=\s*(.+?)\s*$/m.exec(ini)?.[1]
    if (custom && path.isAbsolute(custom)) return path.join(custom, 'files')
  } catch {}
  return path.join(base, 'files')
}

function joinIfStrings(...parts: unknown[]) {
  if (parts.length === 0 || !parts.every((part): part is string => typeof part === 'string' && part.length > 0)) return null
  return path.join(...parts)
}
