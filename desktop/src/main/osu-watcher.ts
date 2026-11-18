import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
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
// tosu can report a new map's checksum a few updates before its file path catches up.
const UNVERIFIED_RETRY_MS = 400
const MAX_FOLDER_ENTRIES = 300
const SKIN_RETRY_MS = 15_000
const MAP_FETCH_TIMEOUT_MS = 3000
const OSU_FETCH_TIMEOUT_MS = 8000
const OSU_RETRY_MS = 10_000
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
  status: OsuStatus = {
    source: null,
    client: 'stable',
    detected: null,
    state: null,
    mods: 0,
    offset: null,
    checksum: null,
    mapReady: false,
  }
  map: OsuMap | null = null
  skin: OsuSkin | null = null
  private lazerFiles: string | null = null
  private skinId: string | null = null
  private skinLoading = false
  private skinRetryAt = 0
  private checksum: string | null = null
  private readonly mapIds = new Map<string, number>()
  private readonly downloaded = new Map<number, string>()
  private readonly downloadRetryAt = new Map<number, number>()
  private mapRetryAt = 0
  private mapVerified = false
  private mapLoading = false
  private mapWarned = false
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
    this.set({ client, checksum: null, mapReady: false })
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
        void this.loadMap(data.beatmap?.checksum, data.beatmap?.id, [
          ...(lazer
            ? [joinIfStrings(this.lazerFiles, data.files?.beatmap), joinIfStrings(this.lazerFiles, data.directPath?.beatmapFile)]
            : []),
          joinIfStrings(songs, data.folders?.beatmap, data.files?.beatmap),
          joinIfStrings(data.directPath?.beatmapFile),
          joinIfStrings(songs, data.directPath?.beatmapFile),
          joinIfStrings(songs, data.folders?.beatmap),
        ])
        if (!this.precise) this.time(data.beatmap?.time?.live)
        if (this.status.client === 'stable') {
          const skinName = data.folders?.skin
          const game = data.folders?.game
          const skinFolder = data.directPath?.skinFolder
          // tosu versions disagree on whether these are absolute, relative to the game folder,
          // or just the skin's name, so every reading is tried.
          const skinDirs = [
            joinIfStrings(skinFolder),
            joinIfStrings(game, skinFolder),
            joinIfStrings(game, 'Skins', skinFolder),
            joinIfStrings(game, 'Skins', skinName),
            joinIfStrings(game, skinName),
            joinIfStrings(process.env.LOCALAPPDATA, 'osu!', 'Skins', skinName),
          ]
          void this.loadSkin(typeof skinName === 'string' && skinName ? skinName : 'current', skinDirs)
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
        void this.loadMap(bm.md5, bm.id, [joinIfStrings(data.settings?.folders?.songs, bm.path?.folder, file)])
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
  private async loadSkin(id: string, dirs: (string | null)[]) {
    if (this.skinLoading) return
    if (id === this.skinId && (this.skin || performance.now() < this.skinRetryAt)) return
    this.skinId = id
    this.skinLoading = true
    try {
      const skin = await fetchSkin(this.port, id, dirs)
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
  private async loadMap(checksum: unknown, beatmapId: unknown, candidates: (string | null)[]) {
    if (typeof checksum !== 'string' || !checksum) return
    if (typeof beatmapId === 'number' && Number.isInteger(beatmapId) && beatmapId > 0) this.mapIds.set(checksum, beatmapId)
    const now = performance.now()
    if (checksum === this.checksum && (this.mapVerified || this.mapLoading || now < this.mapRetryAt)) return
    if (checksum !== this.checksum) {
      this.checksum = checksum
      this.mapVerified = false
      this.mapWarned = false
      this.set({ checksum, mapReady: this.map?.checksum === checksum })
    }
    this.mapLoading = true
    try {
      const text = await this.findMap(checksum, candidates)
      if (this.checksum !== checksum) return
      if (text !== null) {
        this.mapVerified = true
        if (this.map?.checksum !== checksum || this.map.text !== text) {
          this.map = { checksum, text }
          this.events.map(this.map)
        }
        // Sent after the map itself so the partner already has the file when it's told to draw it.
        this.set({ mapReady: true })
        return
      }
      // tosu's file path often lags behind the checksum for a few updates after a map change, so
      // keep retrying quickly. A file that doesn't match is a sibling difficulty or an earlier map,
      // and is never sent.
      this.mapRetryAt = performance.now() + UNVERIFIED_RETRY_MS
      if (!this.mapWarned) {
        this.mapWarned = true
        console.warn(`[osu-coop] Waiting for the beatmap file matching ${checksum} (tried ${candidates.filter(Boolean).join(', ')}).`)
      }
    } finally {
      if (this.checksum === checksum) this.mapLoading = false
    }
  }

  /** Returns the .osu text whose raw bytes hash to the checksum osu! reports, or null. */
  private async findMap(checksum: string, candidates: (string | null)[]) {
    const files = [...new Set(candidates.filter((file): file is string => !!file && path.isAbsolute(file)))]
    const wanted = checksum.toLowerCase()
    for (const file of files) {
      const bytes = await readMapFile(file)
      if (this.checksum !== checksum) return null
      if (bytes && md5(bytes) === wanted) return bytes.toString('utf8')
    }
    if (this.status.source === 'tosu') {
      const bytes = await this.fetchMapFromTosu()
      if (this.checksum !== checksum) return null
      if (bytes && md5(bytes) === wanted) return bytes.toString('utf8')
    }
    // The reported file name can point at a sibling difficulty, so look through the map's folder
    // for the .osu whose contents actually match.
    const local = await findByChecksum(
      files.map((file) => (file.toLowerCase().endsWith('.osu') ? path.dirname(file) : file)),
      wanted,
    )
    if (this.checksum !== checksum) return null
    if (local !== null) return local
    return this.fetchMapFromOsu(checksum)
  }

  /**
   * Last resort when no local file matches: osu! serves every submitted difficulty's .osu by its
   * beatmap ID, which pins the exact difficulty even if the local copy is an older revision.
   */
  private async fetchMapFromOsu(checksum: string) {
    const id = this.mapIds.get(checksum)
    if (!id) return null
    const cached = this.downloaded.get(id)
    if (cached !== undefined) return cached
    if (performance.now() < (this.downloadRetryAt.get(id) ?? 0)) return null
    try {
      const res = await fetch(`https://osu.ppy.sh/osu/${id}`, { signal: AbortSignal.timeout(OSU_FETCH_TIMEOUT_MS) })
      const bytes = res.ok ? Buffer.from(await res.arrayBuffer()) : null
      const text = bytes && bytes.length > 0 && bytes.length <= MAX_MAP_BYTES ? bytes.toString('utf8') : null
      if (text && text.trimStart().startsWith('osu file format')) {
        if (md5(bytes!) !== checksum.toLowerCase()) {
          console.warn(`[osu-coop] Using osu!'s copy of beatmap ${id}; it differs from your local file.`)
        }
        this.downloaded.set(id, text)
        return text
      }
    } catch {}
    this.downloadRetryAt.set(id, performance.now() + OSU_RETRY_MS)
    return null
  }

  /** Raw bytes, so the checksum is computed over exactly what osu! hashed. */
  private async fetchMapFromTosu() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/files/beatmap/file`, {
        signal: AbortSignal.timeout(MAP_FETCH_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const bytes = Buffer.from(await res.arrayBuffer())
      return bytes.length > 0 && bytes.length <= MAX_MAP_BYTES ? bytes : null
    } catch {
      return null
    }
  }
}

function md5(bytes: Buffer) {
  return createHash('md5').update(bytes).digest('hex')
}

async function findByChecksum(dirs: string[], wanted: string) {
  for (const dir of new Set(dirs)) {
    let names: string[]
    try {
      // Filter before capping: big sets hold hundreds of hitsounds and images besides the .osu files.
      names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.osu')).slice(0, MAX_FOLDER_ENTRIES)
    } catch {
      continue
    }
    for (const name of names) {
      const bytes = await readMapFile(path.join(dir, name))
      if (bytes && md5(bytes) === wanted) return bytes.toString('utf8')
    }
  }
  return null
}

async function readMapFile(file: string) {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_MAP_BYTES) return null
    return await readFile(file)
  } catch {
    return null
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
