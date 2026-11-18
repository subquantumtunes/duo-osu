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
  const [hitcircle, overlay, approach, sliderBall, reverseArrow, followCircle, cursor, ...digits] = await Promise.all(
    [
      'hitcircle',
      'hitcircleoverlay',
      'approachcircle',
      'sliderb',
      'reversearrow',
      'sliderfollowcircle',
      'cursor',
      ...Array.from({ length: 10 }, (_, d) => `digit-${d}`),
    ].map(
      (name) => decode(images[name]),
    ),
  )
  const ini = parseIni(typeof payload.ini === 'string' ? payload.ini : '')
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
  }
}

export function closeSkin(skin: Skin | null) {
  if (!skin) return
  for (const sprite of [skin.hitcircle, skin.overlay, skin.approach, skin.sliderBall, skin.reverseArrow, skin.followCircle, skin.cursor, ...(skin.digits ?? [])]) {
    sprite?.image.close()
  }
}
