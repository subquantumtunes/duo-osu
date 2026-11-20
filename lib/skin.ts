export type SkinSprite = { image: ImageBitmap; hd: boolean }

export type Skin = {
  hitcircle: SkinSprite | null
  overlay: SkinSprite | null
  approach: SkinSprite | null
  sliderBall: SkinSprite | null
  reverseArrow: SkinSprite | null
  followCircle: SkinSprite | null
  cursor: SkinSprite | null
  /** Only set when all ten digits exist, so numbers never mix fonts. */
  digits: SkinSprite[] | null
  comboColors: string[] | null
  sliderBorder: string | null
  sliderTrack: string | null
  overlayAboveNumber: boolean
  digitOverlap: number
  /** The skin.ini `[Mania]` sections, keyed by their key count. */
  mania: Map<number, ManiaLayout>
  /** Average colour of the skin's mania-note1, mania-note2 and mania-noteS images. */
  maniaNoteColors: ManiaNoteColors
  /** The skin's hit100/hit50/hit0 sprites (and mania-/taiko- versions), keyed by file name. */
  judgementSprites: Partial<Record<JudgementSpriteName, SkinSprite>>
}

export const JUDGEMENT_SPRITE_NAMES = [
  'hit100',
  'hit50',
  'hit0',
  'mania-hit100',
  'mania-hit50',
  'mania-hit0',
  'taiko-hit100',
  'taiko-hit0',
] as const

export type JudgementSpriteName = (typeof JUDGEMENT_SPRITE_NAMES)[number]

export type ManiaNoteColors = { note1: string | null; note2: string | null; noteS: string | null }

/** The opacity-weighted average colour of a sprite. Closes the sprite, since only the colour is kept. */
function averageColor(sprite: SkinSprite | null): string | null {
  if (!sprite) return null
  const { image } = sprite
  try {
    const w = Math.max(1, Math.min(image.width, 64))
    const h = Math.max(1, Math.min(image.height, 64))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(image, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    let r = 0
    let g = 0
    let b = 0
    let weight = 0
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]
      if (a < 64) continue
      r += data[i] * a
      g += data[i + 1] * a
      b += data[i + 2] * a
      weight += a
    }
    if (weight === 0) return null
    return `rgb(${Math.round(r / weight)}, ${Math.round(g / weight)}, ${Math.round(b / weight)})`
  } catch {
    return null
  } finally {
    image.close()
  }
}

/** A mania stage as osu!stable lays it out, in its 480px-tall coordinate space. */
export type ManiaLayout = { widths: number[]; spacing: number[]; hitPosition: number }

const DEFAULT_COLUMN_WIDTH = 30
const DEFAULT_HIT_POSITION = 402

function numberList(value: string | undefined) {
  return (value ?? '').split(',').map((p) => Number(p.trim()))
}

function parseManiaSections(text: string) {
  const layouts = new Map<number, ManiaLayout>()
  let section: Map<string, string> | null = null
  const finish = () => {
    if (!section) return
    const keys = Number(section.get('keys'))
    if (Number.isInteger(keys) && keys >= 1 && keys <= 18 && !layouts.has(keys)) {
      layouts.set(keys, buildManiaLayout(keys, section))
    }
    section = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      finish()
      if (header[1].trim().toLowerCase() === 'mania') section = new Map()
      continue
    }
    const sep = line.indexOf(':')
    if (section && sep > 0) section.set(line.slice(0, sep).trim().toLowerCase(), line.slice(sep + 1).trim())
  }
  finish()
  return layouts
}

function buildManiaLayout(keys: number, values: Map<string, string> | null): ManiaLayout {
  const widths = numberList(values?.get('columnwidth'))
  const spacing = numberList(values?.get('columnspacing'))
  const hit = Number(values?.get('hitposition'))
  return {
    widths: Array.from({ length: keys }, (_, i) => {
      const w = widths[i]
      return Number.isFinite(w) && w > 0 ? Math.min(w, 200) : DEFAULT_COLUMN_WIDTH
    }),
    spacing: Array.from({ length: Math.max(0, keys - 1) }, (_, i) => {
      const s = spacing[i]
      return Number.isFinite(s) ? Math.max(-100, Math.min(s, 200)) : 0
    }),
    // osu!stable keeps the judgement line in the lower half of the screen.
    hitPosition: Number.isFinite(hit) ? Math.max(240, Math.min(hit, 480)) : DEFAULT_HIT_POSITION,
  }
}

/** The host's column layout for a key count, or osu!'s defaults when the skin doesn't set one. */
export function maniaLayoutFor(skin: Skin | null, keys: number): ManiaLayout {
  return skin?.mania.get(keys) ?? buildManiaLayout(keys, null)
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const MAX_SIDE = 2048

async function decode(entry: unknown): Promise<SkinSprite | null> {
  if (!entry || typeof entry !== 'object') return null
  const { hd, data } = entry as { hd?: unknown; data?: unknown }
  if (typeof data !== 'string' || !BASE64.test(data)) return null
  try {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    if (image.width > MAX_SIDE || image.height > MAX_SIDE) {
      image.close()
      return null
    }
    return { image, hd: hd === true }
  } catch {
    return null
  }
}

function parseIni(text: string) {
  const values = new Map<string, string>()
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      section = header[1].trim().toLowerCase()
      continue
    }
    const sep = line.indexOf(':')
    if (sep > 0) values.set(`${section}.${line.slice(0, sep).trim().toLowerCase()}`, line.slice(sep + 1).trim())
  }
  return values
}

function rgb(value: string | undefined) {
  if (!value) return null
  const parts = value.split(',').map((p) => Number(p.trim()))
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`
}

export async function loadSkin(text: string): Promise<Skin | null> {
  let payload: { ini?: unknown; images?: Record<string, unknown> }
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  const images = payload.images && typeof payload.images === 'object' ? payload.images : {}
  const [hitcircle, overlay, approach, sliderBall, reverseArrow, followCircle, cursor, note1, note2, noteS, ...digits] = await Promise.all(
    [
      'hitcircle',
      'hitcircleoverlay',
      'approachcircle',
      'sliderb',
      'reversearrow',
      'sliderfollowcircle',
      'cursor',
      'mania-note1',
      'mania-note2',
      'mania-noteS',
      ...Array.from({ length: 10 }, (_, d) => `digit-${d}`),
    ].map(
      (name) => decode(images[name]),
    ),
  )
  const judgementSprites: Partial<Record<JudgementSpriteName, SkinSprite>> = {}
  const decodedJudgements = await Promise.all(JUDGEMENT_SPRITE_NAMES.map((name) => decode(images[name])))
  JUDGEMENT_SPRITE_NAMES.forEach((name, i) => {
    const sprite = decodedJudgements[i]
    if (sprite) judgementSprites[name] = sprite
  })
  const iniText = typeof payload.ini === 'string' ? payload.ini : ''
  const ini = parseIni(iniText)
  const comboColors = Array.from({ length: 8 }, (_, i) => rgb(ini.get(`colours.combo${i + 1}`))).filter(
    (c): c is string => c !== null,
  )
  const above = ini.get('general.hitcircleoverlayabovenumber') ?? ini.get('general.hitcircleoverlayabovenumer')
  const overlap = Number(ini.get('fonts.hitcircleoverlap'))
  const allDigits = digits.every((d): d is SkinSprite => d !== null)
  if (!allDigits) digits.forEach((d) => d?.image.close())

  return {
    hitcircle,
    overlay,
    approach,
    sliderBall,
    reverseArrow,
    followCircle,
    cursor,
    digits: allDigits ? digits : null,
    comboColors: comboColors.length > 0 ? comboColors : null,
    sliderBorder: rgb(ini.get('colours.sliderborder')),
    sliderTrack: rgb(ini.get('colours.slidertrackoverride')),
    overlayAboveNumber: above !== '0',
    digitOverlap: Number.isFinite(overlap) ? overlap : -2,
    mania: parseManiaSections(iniText),
    maniaNoteColors: { note1: averageColor(note1), note2: averageColor(note2), noteS: averageColor(noteS) },
    judgementSprites,
  }
}

export function closeSkin(skin: Skin | null) {
  if (!skin) return
  for (const sprite of [skin.hitcircle, skin.overlay, skin.approach, skin.sliderBall, skin.reverseArrow, skin.followCircle, skin.cursor, ...(skin.digits ?? []), ...Object.values(skin.judgementSprites)]) {
    sprite?.image.close()
  }
}
