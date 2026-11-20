import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'

const run = promisify(execFile)
const RELEASE_API = 'https://api.github.com/repos/tosuapp/tosu/releases/latest'

type Release = { tag_name: string; assets: { name: string; browser_download_url: string }[] }

function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(1000)
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('timeout', () => (socket.destroy(), resolve(false)))
    socket.once('error', () => resolve(false))
  })
}

async function findExe(dir: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && /^tosu.*\.exe$/i.test(entry.name)) return full
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findExe(path.join(dir, entry.name))
    if (found) return found
  }
  return null
}

async function download(dir: string, onStatus: (message: string) => void, signal: AbortSignal) {
  onStatus('Downloading tosu…')
  const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' }, signal })
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when looking up tosu`)
  const release = (await res.json()) as Release
  const asset = release.assets.find((a) => /^tosu-windows-.*\.zip$/i.test(a.name))
  if (!asset) throw new Error(`tosu ${release.tag_name} has no Windows download`)

  const file = await fetch(asset.browser_download_url, { signal })
  if (!file.ok || !file.body) throw new Error(`tosu download failed (${file.status})`)

  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  const zip = path.join(dir, 'tosu.zip')
  await pipeline(Readable.fromWeb(file.body as WebReadableStream), createWriteStream(zip))

  onStatus('Unpacking tosu…')
  await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', zip, dir],
    { windowsHide: true, signal },
  )
  await fs.rm(zip, { force: true })
}

async function copyBundled(from: string, to: string) {
  if (!(await findExe(from))) return false
  await fs.rm(to, { recursive: true, force: true })
  await fs.cp(from, to, { recursive: true })
  return true
}

/**
 * Makes sure tosu is running for the session: reuses one the user already started, otherwise
 * runs the copy shipped with the installer (copied into the app's data folder so tosu can write
 * its config there and it survives app updates), and only downloads it if neither exists.
 */
export class TosuManager {
  private child: ChildProcess | null = null
  private readonly abort = new AbortController()

  constructor(
    private readonly port: number,
    private readonly dir: string,
    private readonly bundledDir: string | null,
    private readonly onStatus: (message: string) => void,
  ) {}

  async ensure() {
    if (process.platform !== 'win32') return
    if (await portOpen(this.port)) return

    let exe = await findExe(this.dir)
    if (!exe && this.bundledDir && (await copyBundled(this.bundledDir, this.dir))) {
      exe = await findExe(this.dir)
    }
    if (!exe) {
      await download(this.dir, this.onStatus, this.abort.signal)
      exe = await findExe(this.dir)
      if (!exe) throw new Error('tosu was downloaded but tosu.exe was not found in it')
    }
    if (this.abort.signal.aborted) return

    this.onStatus('Starting tosu…')
    const child = spawn(exe, [], { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore' })
    child.once('exit', () => {
      if (this.child === child) this.child = null
    })
    this.child = child
  }

  /** Cancels a download in progress and ends the tosu duosu started, along with anything it spawned. */
  stop() {
    this.abort.abort()
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.pid === undefined) return
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000, stdio: 'ignore' })
    } catch {
      child.kill()
    }
  }
}
