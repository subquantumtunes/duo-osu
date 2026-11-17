import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import type { OsuMap, OsuStatus } from '../shared/api'

const PLAYING = 2
const MAX_MAP_BYTES = 4_000_000
const MIN_TIME_INTERVAL_MS = 3
const RETRY_MS = 3000

type Events = {
  status(status: OsuStatus): void
  time(ms: number): void
  map(map: OsuMap): void
}

type Json = Record<string, any>

/** Follows osu! stable through tosu (or gosumemory) so the partner can draw the map locally. */
export class OsuWatcher {
  status: OsuStatus = { source: null, state: null, mods: 0, offset: null }
  map: OsuMap | null = null
  private checksum: string | null = null
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

  stop() {
    this.stopped = true
    for (const ws of this.sockets) ws.terminate()
  }

  private async loop() {
    while (!this.stopped) {
      await this.followTosu()
      if (this.stopped) return
      if (this.status.source === null) await this.followGosumemory()
      this.set({ source: null, state: null })
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
        this.set({ state, mods, offset: typeof offset === 'number' ? offset : null })
        void this.loadMap(data.beatmap?.checksum, data.folders?.songs, data.directPath?.beatmapFile)
        if (!this.precise) this.time(data.beatmap?.time?.live)
      },
    )
    for (const ws of this.sockets) if (ws.url.endsWith('/precise')) ws.terminate()
    await precise
  }

  private async followGosumemory() {
    await this.stream(
      `ws://127.0.0.1:${this.port}/ws`,
      () => this.set({ source: 'gosumemory' }),
      (data) => {
        const menu = data.menu ?? {}
        const bm = menu.bm ?? {}
        const file = bm.path?.file
        this.set({ state: menu.state ?? null, mods: menu.mods?.num ?? 0 })
        void this.loadMap(bm.md5, data.settings?.folders?.songs, file ? path.join(bm.path?.folder ?? '', file) : null)
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

  private async loadMap(checksum: unknown, songs: unknown, relative: unknown) {
    if (typeof checksum !== 'string' || !checksum || typeof relative !== 'string' || !relative) return
    if (checksum === this.checksum) return
    this.checksum = checksum
    const file = path.join(typeof songs === 'string' ? songs : '', relative)
    try {
      if ((await stat(file)).size > MAX_MAP_BYTES) throw new Error('file is too large')
      const text = await readFile(file, 'utf8')
      if (this.checksum !== checksum) return
      this.map = { checksum, text }
      this.events.map(this.map)
    } catch (err) {
      console.warn(`[osu-coop] Couldn't read the beatmap file: ${err instanceof Error ? err.message : err}`)
      this.map = null
    }
  }
}
