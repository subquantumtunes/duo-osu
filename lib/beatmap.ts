export type Vec = { x: number; y: number }

export type SliderPath = { points: Vec[]; lengths: number[]; length: number }

export type HitObject = {
  kind: 'circle' | 'slider' | 'spinner'
  time: number
  end: number
  x: number
  y: number
  comboIndex: number
  comboNumber: number
  path?: SliderPath
  slides?: number
  slideDuration?: number
}

export type Beatmap = {
  checksum: string
  title: string
  cs: number
  ar: number
  objects: HitObject[]
}

export const MOD_EASY = 2
export const MOD_HARD_ROCK = 16
export const MOD_DOUBLE_TIME = 64
export const MOD_HALF_TIME = 256
export const MOD_NIGHTCORE = 512

export function clockRate(mods: number) {
  if (mods & (MOD_DOUBLE_TIME | MOD_NIGHTCORE)) return 1.5
  if (mods & MOD_HALF_TIME) return 0.75
  return 1
}

export function difficultyFor(map: Beatmap, mods: number) {
  let { cs, ar } = map
  if (mods & MOD_HARD_ROCK) {
    cs = Math.min(10, cs * 1.3)
    ar = Math.min(10, ar * 1.4)
  } else if (mods & MOD_EASY) {
    cs *= 0.5
    ar *= 0.5
  }
  const preempt = ar < 5 ? 1200 + (600 * (5 - ar)) / 5 : 1200 - (750 * (ar - 5)) / 5
  return {
    radius: 54.4 - 4.48 * cs,
    preempt,
    fadeIn: 400 * Math.min(1, preempt / 450),
    flipY: (mods & MOD_HARD_ROCK) !== 0,
  }
}

export function readTitle(text: string) {
  const field = (key: string) => text.match(new RegExp(`^${key}\\s*:(.*)$`, 'm'))?.[1]?.trim() ?? ''
  const title = `${field('Artist')} - ${field('Title')}`
  const version = field('Version')
  return version ? `${title} [${version}]` : title
}

const dist = (a: Vec, b: Vec) => Math.hypot(b.x - a.x, b.y - a.y)
const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

function polylineLength(points: Vec[]) {
  let total = 0
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i])
  return total
}

function bezier(controls: Vec[]): Vec[] {
  if (controls.length < 3) return controls
  const steps = Math.min(200, Math.max(8, Math.ceil(polylineLength(controls) / 4)))
  const out: Vec[] = []
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    let level = controls
    while (level.length > 1) {
      const next: Vec[] = []
      for (let i = 0; i < level.length - 1; i++) next.push(lerp(level[i], level[i + 1], t))
      level = next
    }
    out.push(level[0])
  }
  return out
}

function bezierChain(points: Vec[]): Vec[] {
  const out: Vec[] = []
  let segment: Vec[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const prev = points[i - 1]
    // A repeated control point marks a sharp corner between bezier segments.
    if (p.x === prev.x && p.y === prev.y) {
      out.push(...bezier(segment))
      segment = [p]
    } else {
      segment.push(p)
    }
  }
  out.push(...bezier(segment))
  return out
}

function arc(a: Vec, b: Vec, c: Vec): Vec[] | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-6) return null
  const a2 = a.x * a.x + a.y * a.y
  const b2 = b.x * b.x + b.y * b.y
  const c2 = c.x * c.x + c.y * c.y
  const center = {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  }
  const radius = dist(center, a)
  const start = Math.atan2(a.y - center.y, a.x - center.x)
  let end = Math.atan2(c.y - center.y, c.x - center.x)
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  if (cross > 0) while (end < start) end += Math.PI * 2
  else while (end > start) end -= Math.PI * 2
  const sweep = end - start
  const steps = Math.min(200, Math.max(8, Math.ceil((Math.abs(sweep) * radius) / 4)))
  const out: Vec[] = []
  for (let s = 0; s <= steps; s++) {
    const angle = start + (sweep * s) / steps
    out.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius })
  }
  return out
}

function fitToLength(raw: Vec[], length: number): SliderPath {
  const points: Vec[] = [raw[0]]
  const lengths = [0]
  for (let i = 1; i < raw.length; i++) {
    const seg = dist(raw[i - 1], raw[i])
    if (seg === 0) continue
    const before = lengths[lengths.length - 1]
    if (before + seg >= length) {
      points.push(lerp(raw[i - 1], raw[i], (length - before) / seg))
      lengths.push(length)
      return { points, lengths, length }
    }
    points.push(raw[i])
    lengths.push(before + seg)
  }
  const total = lengths[lengths.length - 1]
  // Some maps declare a longer pixel length than the curve; stable extends the final segment.
  if (length > total && points.length > 1) {
    const a = points[points.length - 2]
    const b = points[points.length - 1]
    const seg = dist(a, b)
    points.push(lerp(a, b, (seg + length - total) / seg))
    lengths.push(length)
    return { points, lengths, length }
  }
  return { points, lengths, length: total }
}

function buildPath(type: string, controls: Vec[], length: number): SliderPath {
  let raw: Vec[]
  if (type === 'L' || type === 'C') raw = controls
  else if (type === 'P' && controls.length === 3) raw = arc(controls[0], controls[1], controls[2]) ?? bezierChain(controls)
  else raw = bezierChain(controls)
  const target = length > 0 ? length : polylineLength(raw)
  return fitToLength(raw, target)
}

export function positionAt(path: SliderPath, distance: number): Vec {
  const { points, lengths } = path
  if (distance <= 0 || points.length === 1) return points[0]
  if (distance >= path.length) return points[points.length - 1]
  let lo = 0
  let hi = lengths.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (lengths[mid] < distance) lo = mid
    else hi = mid
  }
  const span = lengths[hi] - lengths[lo]
  return lerp(points[lo], points[hi], span > 0 ? (distance - lengths[lo]) / span : 0)
}

export function sliderBallAt(obj: HitObject, time: number): Vec | null {
  if (!obj.path || !obj.slideDuration || time < obj.time || time > obj.end) return null
  const progress = (time - obj.time) / obj.slideDuration
  const slide = Math.min(Math.floor(progress), (obj.slides ?? 1) - 1)
  let fraction = progress - slide
  if (slide % 2 === 1) fraction = 1 - fraction
  return positionAt(obj.path, Math.min(1, Math.max(0, fraction)) * obj.path.length)
}

type TimingPoint = { time: number; beatLength: number; uninherited: boolean }

/** Parses an osu!standard .osu file into what the partner playfield needs to draw. */
export function parseBeatmap(text: string, checksum: string): Beatmap | null {
  let section = ''
  let mode = 0
  const difficulty: Record<string, number> = {}
  const timing: TimingPoint[] = []
  const rows: string[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1)
      continue
    }
    if (section === 'General' || section === 'Difficulty') {
      const i = line.indexOf(':')
      if (i < 0) continue
      const key = line.slice(0, i).trim()
      const value = Number(line.slice(i + 1).trim())
      if (section === 'General' && key === 'Mode') mode = value
      else if (section === 'Difficulty') difficulty[key] = value
    } else if (section === 'TimingPoints') {
      const p = line.split(',')
      if (p.length < 2) continue
      const beatLength = Number(p[1])
      timing.push({ time: Number(p[0]), beatLength, uninherited: p.length > 6 ? p[6] === '1' : beatLength > 0 })
    } else if (section === 'HitObjects') {
      rows.push(line)
    }
  }
  if (mode !== 0) return null

  timing.sort((a, b) => a.time - b.time)
  const sliderMultiplier = difficulty.SliderMultiplier || 1.4
  const cs = difficulty.CircleSize ?? 5
  const ar = difficulty.ApproachRate ?? difficulty.OverallDifficulty ?? 5

  let beatLength = timing.find((t) => t.uninherited)?.beatLength ?? 500
  let sv = 1
  let timingIndex = 0
  let comboIndex = 0
  let comboNumber = 0
  let afterSpinner = false
  const objects: HitObject[] = []

  for (const row of rows) {
    const p = row.split(',')
    if (p.length < 4) continue
    const x = Number(p[0])
    const y = Number(p[1])
    const time = Number(p[2])
    const type = Number(p[3])
    if (!Number.isFinite(time)) continue

    while (timingIndex < timing.length && timing[timingIndex].time <= time + 1) {
      const point = timing[timingIndex++]
      if (point.uninherited) {
        beatLength = point.beatLength
        sv = 1
      } else if (point.beatLength < 0) {
        sv = Math.min(10, Math.max(0.1, -100 / point.beatLength))
      }
    }

    const isSpinner = (type & 8) !== 0
    if (!isSpinner) {
      if (objects.length === 0 || type & 4 || afterSpinner) {
        comboIndex += 1 + ((type >> 4) & 7)
        comboNumber = 1
      } else {
        comboNumber++
      }
    }
    afterSpinner = isSpinner

    if (type & 2) {
      const [curveType, ...rest] = (p[5] ?? 'L').split('|')
      const controls: Vec[] = [{ x, y }]
      for (const pair of rest) {
        const [cx, cy] = pair.split(':').map(Number)
        if (Number.isFinite(cx) && Number.isFinite(cy)) controls.push({ x: cx, y: cy })
      }
      const slides = Math.max(1, Number(p[6]) || 1)
      const path = buildPath(curveType, controls, Number(p[7]) || 0)
      const slideDuration = (path.length / (sliderMultiplier * 100 * sv)) * beatLength
      objects.push({
        kind: 'slider',
        time,
        end: time + slideDuration * slides,
        x,
        y,
        comboIndex,
        comboNumber,
        path,
        slides,
        slideDuration,
      })
    } else if (isSpinner) {
      objects.push({ kind: 'spinner', time, end: Number(p[5]) || time, x: 256, y: 192, comboIndex, comboNumber: 0 })
    } else {
      objects.push({ kind: 'circle', time, end: time, x, y, comboIndex, comboNumber })
    }
  }

  return { checksum, title: readTitle(text), cs, ar, objects }
}
