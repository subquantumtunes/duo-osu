import { execFile } from 'node:child_process'
import type { GameAudioStatus } from '../shared/api'

type Capture = { start(pid: number, cb: (chunk: Buffer) => void): void; stop(): void }
type CaptureCtor = new () => Capture

const POLL_MS = 2000
const PROCESS_NAMES = ['osu!.exe']

function findOsuPid(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${PROCESS_NAMES[0]}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 3000 },
      (err, stdout) => {
        if (err) return resolve(null)
        for (const line of stdout.split(/\r?\n/)) {
          const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''))
          if (cols.length > 1 && PROCESS_NAMES.includes(cols[0].toLowerCase())) {
            const pid = Number(cols[1])
            if (Number.isInteger(pid) && pid > 0) return resolve(pid)
          }
        }
        resolve(null)
      },
    )
  })
}

/**
 * Captures audio from the osu! process tree only (WASAPI process loopback), so Discord, music
 * players and notifications on the host PC never reach the partner. Follows osu! if it restarts.
 */
export class GameAudio {
  status: GameAudioStatus = { active: false, reason: null }
  private Ctor: CaptureCtor | null = null
  private capture: Capture | null = null
  private pid: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false

  constructor(
    private onChunk: (chunk: Buffer) => void,
    private onStatus: (status: GameAudioStatus) => void,
  ) {
    if (process.platform !== 'win32') {
      this.status = { active: false, reason: 'Game-only audio needs Windows 10 (2004) or newer.' }
      return
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('loopback-capture') as { LoopbackCapture?: CaptureCtor; default?: { LoopbackCapture: CaptureCtor } }
      this.Ctor = mod.LoopbackCapture ?? mod.default?.LoopbackCapture ?? null
    } catch (err) {
      this.status = { active: false, reason: `Couldn't load the audio capture module (${err instanceof Error ? err.message : String(err)}).` }
    }
  }

  start() {
    if (!this.Ctor || this.timer) return this.status
    this.timer = setInterval(() => void this.poll(), POLL_MS)
    void this.poll()
    return this.status
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.release()
    this.pid = null
    if (this.Ctor) this.setStatus({ active: false, reason: null })
  }

  private release() {
    try {
      this.capture?.stop()
    } catch {}
    this.capture = null
  }

  private async poll() {
    if (this.polling || !this.Ctor) return
    this.polling = true
    try {
      const pid = await findOsuPid()
      if (!this.timer || pid === this.pid) return
      this.release()
      this.pid = pid
      if (pid === null) {
        this.setStatus({ active: false, reason: 'Waiting for osu! to start.' })
        return
      }
      try {
        const capture = new this.Ctor()
        capture.start(pid, (chunk) => this.onChunk(chunk))
        this.capture = capture
        this.setStatus({ active: true, reason: null })
      } catch (err) {
        this.setStatus({ active: false, reason: `Couldn't capture osu! audio (${err instanceof Error ? err.message : String(err)}).` })
      }
    } finally {
      this.polling = false
    }
  }

  private setStatus(status: GameAudioStatus) {
    this.status = status
    this.onStatus(status)
  }
}
