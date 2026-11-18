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

async function get(url: string, max: number) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > 0 && buf.length <= max ? buf : null
  } catch {
    return null
  }
}

function urlPath(name: string) {
  return name
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map(encodeURIComponent)
    .join('/')
}

/** Prefers the @2x file, like osu! does on high resolutions. */
async function image(base: string, name: string): Promise<SkinImage | null> {
  for (const hd of [true, false]) {
    const buf = await get(`${base}/${urlPath(name)}${hd ? '@2x' : ''}.png`, MAX_IMAGE_BYTES)
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

/** Reads the skin osu! stable is using through tosu's /files/skin route. */
export async function fetchSkin(port: number, id: string): Promise<OsuSkin | null> {
  const base = `http://127.0.0.1:${port}/files/skin`
  const iniBuf = await get(`${base}/skin.ini`, MAX_INI_BYTES)
  const ini = iniBuf ? iniBuf.toString('utf8').replace(/^\uFEFF/, '') : null
  const prefix = (ini && iniValue(ini, 'Fonts', 'HitCirclePrefix'))?.replace(/\\/g, '/') || 'default'
  const entries: [string, string][] = [
    ...SPRITES,
    ...Array.from({ length: 10 }, (_, d): [string, string] => [`digit-${d}`, `${prefix}-${d}`]),
  ]
  const loaded = await Promise.all(entries.map(async ([key, file]) => [key, await image(base, file)] as const))
  const images: Record<string, SkinImage> = {}
  for (const [key, img] of loaded) if (img) images[key] = img
  if (Object.keys(images).length === 0) return null
  return { id, ini, images }
}
