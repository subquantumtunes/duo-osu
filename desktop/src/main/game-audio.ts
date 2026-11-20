import { execFile } from 'node:child_process'
import type { GameAudioStatus } from '../shared/api'

type Capture = { start(pid: number, cb: (chunk: Buffer) => void): void; stop(): void }
type CaptureCtor = new () => Capture

const POLL_MS = 2000
const PROCESS_NAMES = ['osu!.exe']

type ProcessFinder = (names: string[]) => number | null

let nativeFinder: ProcessFinder | null | undefined

/**
 * Lists processes through Toolhelp32 instead of launching tasklist.exe. Spawning a console process
 * every poll can briefly take the foreground, which knocks a fullscreen osu! out and pauses it.
 */
function loadNativeFinder(): ProcessFinder | null {
  if (nativeFinder !== undefined) return nativeFinder
  nativeFinder = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const ENTRY = koffi.struct('DUOSU_PROCESSENTRY32W', {
      dwSize: 'uint32',
      cntUsage: 'uint32',
      th32ProcessID: 'uint32',
      th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32',
      cntThreads: 'uint32',
      th32ParentProcessID: 'uint32',
      pcPriClassBase: 'int32',
      dwFlags: 'uint32',
      szExeFile: koffi.array('char16_t', 260, 'String'),
    })
    const kernel32 = koffi.load('kernel32.dll')
    const CreateToolhelp32Snapshot = kernel32.func('__stdcall', 'CreateToolhelp32Snapshot', 'intptr_t', ['uint32', 'uint32'])
    const Process32FirstW = kernel32.func('__stdcall', 'Process32FirstW', 'bool', ['intptr_t', koffi.inout(koffi.pointer(ENTRY))])
    const Process32NextW = kernel32.func('__stdcall', 'Process32NextW', 'bool', ['intptr_t', koffi.inout(koffi.pointer(ENTRY))])
    const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['intptr_t'])
    const TH32CS_SNAPPROCESS = 0x2
    const size = koffi.sizeof(ENTRY)

    nativeFinder = (names) => {
      const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) as number
      if (snapshot === -1 || snapshot === 0) return null
      try {
        const entry = { dwSize: size } as { dwSize: number; th32ProcessID: number; szExeFile: string }
        let ok = Process32FirstW(snapshot, entry) as boolean
        while (ok) {
          if (names.includes(String(entry.szExeFile).toLowerCase())) return entry.th32ProcessID
          entry.dwSize = size
          ok = Process32NextW(snapshot, entry) as boolean
        }
        return null
      } finally {
        CloseHandle(snapshot)
      }
    }
  } catch {
    nativeFinder = null
  }
  return nativeFinder
}

function findOsuPid(): Promise<number | null> {
  const native = loadNativeFinder()
  if (native) {
    try {
      return Promise.resolve(native(PROCESS_NAMES))
    } catch {}
  }
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
    if (!this.Ctor) {
      this.onStatus(this.status)
      return this.status
    }
    if (this.timer) return this.status
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
