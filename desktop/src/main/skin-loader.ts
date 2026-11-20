import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { OsuSkin, SkinImage } from '../shared/api'

const TIMEOUT_MS = 3000
const MAX_IMAGE_BYTES = 768_000
const MAX_INI_BYTES = 64_000
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

/** Wire name -> file name in the skin folder (without @2x or .png). */
const SPRITES: [string, string][] = [
  ['hitcircle', 'hitcircle'],
  ['hitcircleoverlay', 'hitcircleoverlay'],
  ['approachcircle', 'approachcircle'],
  ['sliderb', 'sliderb0'],
  ['reversearrow', 'reversearrow'],
  ['sliderfollowcircle', 'sliderfollowcircle'],
  ['cursor', 'cursor'],
]

/** Where skin files come from: the skin folder on disk, or tosu's /files/skin route. */
interface SkinSource {
  /** Returns the file only if it exists; never errors on a missing file. */
  read(name: string, max: number): Promise<Buffer | null>
}

function cleanParts(name: string) {
  return name.split(/[\\/]/).filter((part) => part && part !== '.' && part !== '..')
}

/**
 * Lists each folder once and only opens files that are in the listing, so a skin without
 * @2x files is never asked for them. Names match case-insensitively, like osu! on Windows.
 */
function diskSource(root: string): SkinSource {
  const listings = new Map<string, Promise<Map<string, string>>>()
  const list = (dir: string) => {
    let listing = listings.get(dir)
    if (!listing) {
      listing = readdir(dir)
        .then((names) => new Map(names.map((n) => [n.toLowerCase(), n])))
        .catch(() => new Map<string, string>())
      listings.set(dir, listing)
    }
    return listing
  }
  return {
    async read(name, max) {
      const parts = cleanParts(name)
      const file = parts.pop()
      if (!file) return null
      const dir = path.join(root, ...parts)
      const actual = (await list(dir)).get(file.toLowerCase())
      if (!actual) return null
      try {
        const full = path.join(dir, actual)
        const info = await stat(full)
        if (!info.isFile() || info.size === 0 || info.size > max) return null
        return await readFile(full)
      } catch {
        return null
      }
    },
  }
}

function tosuSource(port: number): SkinSource {
  const base = `http://127.0.0.1:${port}/files/skin`
  return {
    async read(name, max) {
      try {
        const url = `${base}/${cleanParts(name).map(encodeURIComponent).join('/')}`
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        if (!res.ok) return null
        const buf = Buffer.from(await res.arrayBuffer())
        return buf.length > 0 && buf.length <= max ? buf : null
      } catch {
        return null
      }
    },
  }
}

/** Prefers the @2x file like osu! does on high resolutions, and uses the plain file otherwise. */
async function image(source: SkinSource, name: string): Promise<SkinImage | null> {
  for (const hd of [true, false]) {
    const buf = await source.read(`${name}${hd ? '@2x' : ''}.png`, MAX_IMAGE_BYTES)
    if (buf && PNG_MAGIC.every((byte, i) => buf[i] === byte)) return { hd, data: buf.toString('base64') }
  }
  return null
}

function iniValue(ini: string, section: string, key: string) {
  let current = ''
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      current = header[1].trim().toLowerCase()
      continue
    }
    if (current !== section.toLowerCase()) continue
    const sep = line.indexOf(':')
    if (sep > 0 && line.slice(0, sep).trim().toLowerCase() === key.toLowerCase()) return line.slice(sep + 1).trim()
  }
  return null
}

async function isDir(dir: string) {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function firstDir(candidates: (string | null)[]) {
  for (const dir of candidates) if (dir && path.isAbsolute(dir) && (await isDir(dir))) return dir
  return null
}

/**
 * Reads the skin osu! stable is using, straight from its folder on disk. Asking tosu's
 * /files/skin route for a file the skin doesn't have (e.g. a missing @2x) can crash tosu,
 * so tosu is only used when the caller opts in and no folder was found.
 */
export async function fetchSkin(
  port: number,
  id: string,
  skinDirs: (string | null)[],
  allowTosu = false,
): Promise<OsuSkin | null> {
  const dir = await firstDir(skinDirs)
  if (!dir && !allowTosu) {
    console.warn(`[duosu] Couldn't find the skin folder for "${id}" (tried ${skinDirs.filter(Boolean).join(', ') || 'nothing'}).`)
    return null
  }
  const source = dir ? diskSource(dir) : tosuSource(port)
  const iniBuf = await source.read('skin.ini', MAX_INI_BYTES)
  const ini = iniBuf ? iniBuf.toString('utf8').replace(/^\uFEFF/, '') : null
  const prefix = (ini && iniValue(ini, 'Fonts', 'HitCirclePrefix'))?.replace(/\\/g, '/') || 'default'
  const entries: [string, string][] = [
    ...SPRITES,
    ...Array.from({ length: 10 }, (_, d): [string, string] => [`digit-${d}`, `${prefix}-${d}`]),
  ]
  const loaded = await Promise.all(entries.map(async ([key, file]) => [key, await image(source, file)] as const))
  const images: Record<string, SkinImage> = {}
  for (const [key, img] of loaded) if (img) images[key] = img
  if (Object.keys(images).length === 0) return null
  return { id, ini, images }
}
