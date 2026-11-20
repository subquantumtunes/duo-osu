'use client'

import { type RefObject, useEffect, useRef } from 'react'
import type { Beatmap, DrumNote, ManiaNote } from '@/lib/beatmap'
import { MOD_HIDDEN, scrollPosition } from '@/lib/beatmap'
import { RULESET_TAIKO } from '@/lib/lanes'
import { type LaneSettings, laneColor, type ManiaBlackout, maniaUnitsPerMs, noteHueColor } from '@/lib/lane-settings'
import { type Skin, maniaLayoutFor } from '@/lib/skin'
import type { SyncClock } from '@/lib/sync-clock'

const DON = '#eb4f4f'
const KAT = '#4fa9eb'
const ROLL = '#fcb81e'
const SWELL = '#f59a3c'
const HIT_GLOW = '255,214,102'
/** Presses this close to a note (in song milliseconds) count as hitting it. */
const MANIA_WINDOW_MS = 150
const TAIKO_WINDOW_MS = 120
/** How long a missed note keeps fading after its window closes. */
const MISS_FADE_MS = 220
const FLASH_MS = 160
/** osu! taiko multiplies slider velocity by 1.4 for scrolling. */
const TAIKO_VELOCITY_MULTIPLIER = 1.4

/** A partner key press or release on a lane, stamped with `performance.now()`. */
export type LaneInput = { lane: number; down: boolean; at: number }

export type LaneView = {
  ruleset: number
  /** Lanes the partner plays; the rest belong to the host. */
  lanes: number[]
  /** Pressed state per lane. */
  pressedRef: RefObject<boolean[]>
  /** Presses waiting to be judged, drained every frame. */
  inputsRef: RefObject<LaneInput[]>
  /** What to paint black over the stream in mania; already `off` outside a live map. */
  blackoutRef: RefObject<ManiaBlackout>
  /** The partner's own scroll speeds, independent of the host's. */
  settingsRef: RefObject<LaneSettings>
}

type Rect = { left: number; top: number; width: number; height: number }

const PENDING = 0
const HIT = 1
const HOLDING = 2
const MISSED = 3

type Judge = {
  state: Uint8Array
  /** Song time a note was missed or a hold was let go, for fading it out. */
  missedAt: Float64Array
  holding: Map<number, number>
  flashAt: number[]
}

function contentRect(stage: HTMLElement, video: HTMLVideoElement | null): Rect {
  const width = stage.clientWidth
  const height = stage.clientHeight
  const vw = video?.videoWidth || 16
  const vh = video?.videoHeight || 9
  const scale = Math.min(width / vw, height / vh)
  return { left: (width - vw * scale) / 2, top: (height - vh * scale) / 2, width: vw * scale, height: vh * scale }
}

function firstVisible<T extends { time: number; end: number }>(list: T[], from: number) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].end < from) lo = mid + 1
    else hi = mid
  }
  return lo
}

function newJudge(count: number): Judge {
  return { state: new Uint8Array(count), missedAt: new Float64Array(count), holding: new Map(), flashAt: [] }
}

function isKat(lane: number) {
  return lane === 0 || lane === 3
}

function judgeTaiko(drums: DrumNote[], judge: Judge, input: LaneInput, at: number) {
  if (!input.down) return
  const kind = isKat(input.lane) ? 'kat' : 'don'
  for (let i = firstVisible(drums, at - TAIKO_WINDOW_MS); i < drums.length; i++) {
    const note = drums[i]
    if (note.time > at + TAIKO_WINDOW_MS) break
    if (note.kind !== kind || judge.state[i] !== PENDING) continue
    if (Math.abs(note.time - at) > TAIKO_WINDOW_MS) continue
    judge.state[i] = HIT
    judge.flashAt[input.lane] = performance.now()
    return
  }
}

function judgeMania(notes: ManiaNote[], judge: Judge, input: LaneInput, at: number) {
  const { lane } = input
  if (!input.down) {
    const index = judge.holding.get(lane)
    if (index === undefined) return
    judge.holding.delete(lane)
    if (at >= notes[index].end - MANIA_WINDOW_MS) {
      judge.state[index] = HIT
      judge.flashAt[lane] = performance.now()
    } else {
      judge.state[index] = MISSED
      judge.missedAt[index] = at
    }
    return
  }
  for (let i = firstVisible(notes, at - MANIA_WINDOW_MS); i < notes.length; i++) {
    const note = notes[i]
    if (note.time > at + MANIA_WINDOW_MS) break
    if (note.column !== lane || judge.state[i] !== PENDING) continue
    if (Math.abs(note.time - at) > MANIA_WINDOW_MS) continue
    judge.flashAt[lane] = performance.now()
    if (note.end > note.time) {
      judge.state[i] = HOLDING
      judge.holding.set(lane, i)
    } else {
      judge.state[i] = HIT
    }
    return
  }
}

function drawTaiko(
  ctx: CanvasRenderingContext2D,
  c: Rect,
  map: Beatmap,
  judge: Judge,
  time: number,
  view: LaneView,
  hidden: boolean,
) {
  const drums = map.drums
  const settings = view.settingsRef.current
  const speedScale = settings?.taikoSpeed ?? 1
  const constant = Boolean(settings?.taikoConstant)
  const velocityOf = (note: DrumNote) => (constant ? map.baseVelocity : note.velocity)
  // osu!stable's taiko layout: the playfield starts 135/480 down the screen, the hit circle sits
  // 160/480 of the height from the left, and notes scroll at 0.1px/ms per 100 slider velocity.
  const unit = c.height / 480
  const aspect = c.width / c.height
  const trackH = Math.min((200 / 768) * c.height * Math.max(1, aspect / (16 / 9)), c.height / 3)
  const top = c.top + 135 * unit
  const cy = top + trackH / 2
  const hitX = c.left + 160 * unit
  const r = trackH * 0.2375
  const pxPerMs = TAIKO_VELOCITY_MULTIPLIER * unit * speedScale
  const now = performance.now()
  const mine = new Set(view.lanes)
  const playsKat = mine.has(0) || mine.has(3)
  const playsDon = mine.has(1) || mine.has(2)

  ctx.fillStyle = 'rgba(14, 10, 14, 0.92)'
  ctx.fillRect(c.left, top, c.width, trackH)
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(hitX, cy, r * 1.05, 0, Math.PI * 2)
  ctx.stroke()

  const pressed = view.pressedRef.current ?? []
  for (let lane = 0; lane < 4; lane++) {
    const kat = isKat(lane)
    const left = lane < 2
    const start = left ? Math.PI / 2 : -Math.PI / 2
    const end = left ? Math.PI * 1.5 : Math.PI / 2
    if (pressed[lane]) {
      ctx.fillStyle = kat ? 'rgba(79,169,235,0.45)' : 'rgba(235,79,79,0.45)'
      ctx.beginPath()
      if (!kat) ctx.moveTo(hitX, cy)
      ctx.arc(hitX, cy, kat ? r * 1.05 : r * 0.8, start, end)
      ctx.fill()
    }
    const flash = 1 - (now - (judge.flashAt[lane] ?? -Infinity)) / FLASH_MS
    if (flash > 0) {
      ctx.globalAlpha = flash
      ctx.fillStyle = `rgba(${HIT_GLOW},0.55)`
      ctx.beginPath()
      ctx.arc(hitX, cy, r * (1.1 + (1 - flash) * 0.5), 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }
  }

  const start = firstVisible(drums, time - TAIKO_WINDOW_MS - MISS_FADE_MS)
  const visible: number[] = []
  for (let i = start; i < drums.length; i++) {
    const note = drums[i]
    // Notes are sorted by time, not position, so a slow note can't end the scan early.
    if (note.time - time > 30000) break
    if (hitX + (note.time - time) * velocityOf(note) * pxPerMs > c.left + c.width + r * 2) continue
    visible.push(i)
  }
  // Back to front, so earlier notes sit on top as in osu!.
  for (let v = visible.length - 1; v >= 0; v--) {
    const i = visible[v]
    const note = drums[i]
    const speed = velocityOf(note) * pxPerMs
    const x = hitX + (note.time - time) * speed
    const nr = note.big ? r * 1.5 : r
    if (hidden && x < hitX + c.width * 0.35 && x > hitX) continue
    if (note.kind === 'roll' || note.kind === 'swell') {
      if (time > note.end) continue
      if (note.kind === 'roll') {
        const endX = hitX + (note.end - time) * speed
        const from = Math.max(x, hitX)
        ctx.fillStyle = ROLL
        ctx.globalAlpha = 0.85
        ctx.beginPath()
        ctx.roundRect(from - nr * 0.8, cy - nr * 0.8, Math.max(0, endX - from) + nr * 1.6, nr * 1.6, nr * 0.8)
        ctx.fill()
      } else {
        ctx.fillStyle = SWELL
        ctx.beginPath()
        ctx.arc(time >= note.time ? hitX : x, cy, r * 1.2, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      continue
    }
    const kat = note.kind === 'kat'
    const partners = kat ? playsKat : playsDon
    const state = judge.state[i]
    if (state === HIT) continue
    let alpha = 1
    if (partners) {
      if (state === PENDING && time > note.time + TAIKO_WINDOW_MS) {
        judge.state[i] = MISSED
        judge.missedAt[i] = time
      }
      if (judge.state[i] === MISSED) alpha = Math.max(0, 1 - (time - judge.missedAt[i]) / MISS_FADE_MS) * 0.6
    } else {
      // The host's notes: we can't see their judgements, so they leave as they reach the circle.
      if (time >= note.time) continue
      alpha = 0.35
    }
    if (alpha <= 0) continue
    ctx.globalAlpha = alpha
    ctx.fillStyle = kat ? KAT : DON
    ctx.beginPath()
    ctx.arc(x, cy, nr, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = Math.max(2, nr * 0.12)
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

function drawMania(
  ctx: CanvasRenderingContext2D,
  c: Rect,
  map: Beatmap,
  skin: Skin | null,
  judge: Judge,
  time: number,
  rate: number,
  view: LaneView,
  hidden: boolean,
) {
  const keys = map.keys
  const layout = maniaLayoutFor(skin, keys)
  const unit = c.height / 480
  const settings = view.settingsRef.current
  // Scaling the whole stage from its centre keeps every column edge, note, and blackout in step,
  // so a stage that reads slightly narrow lines up at both outer edges, not just the middle.
  const scale = (settings?.maniaStageScale ?? 100) / 100
  const xUnit = unit * scale
  const xs: number[] = []
  const ws: number[] = []
  let total = 0
  for (let k = 0; k < keys; k++) {
    xs.push(total)
    ws.push(layout.widths[k] * xUnit)
    total += layout.widths[k] * xUnit + (k < keys - 1 ? layout.spacing[k] * xUnit : 0)
  }
  // osu! centres the stage horizontally; the offset lets the partner nudge it onto the stream.
  const stageLeft = c.left + (c.width - total) / 2 + (settings?.maniaStageOffset ?? 0) * unit
  for (let k = 0; k < keys; k++) xs[k] += stageLeft
  const judgeY = c.top + layout.hitPosition * unit
  // osu! keeps the scroll speed in pixels per ms the same whatever the skin's hit position, and
  // the speed is per real millisecond, so DT and HT change how much song time is on screen.
  const pxPerSongMs = (maniaUnitsPerMs(settings?.maniaSpeed ?? 20) * unit) / rate
  const scroll = settings?.maniaConstant ? [] : map.scroll
  const nowPos = scrollPosition(scroll, time)
  const pressed = view.pressedRef.current ?? []
  const mine = new Set(view.lanes)
  const mode = view.blackoutRef.current ?? 'off'
  const hides = (k: number) => mode === 'all' || (mode === 'host' && !mine.has(k))
  const now = performance.now()
  const laneHue = settings?.laneHue ?? 320
  const laneBrightness = settings?.laneBrightness ?? 8
  const laneOpacity = settings?.laneOpacity ?? 92
  // Whole-pixel edges, so the blackout never leaves an anti-aliased sliver of stream at a column edge.
  const edgeL = (k: number) => Math.floor(xs[k])
  const edgeW = (k: number) => Math.ceil(xs[k] + ws[k]) - Math.floor(xs[k])

  if (mode === 'all') {
    ctx.fillStyle = '#000'
    ctx.fillRect(Math.floor(stageLeft), c.top, Math.ceil(stageLeft + total) - Math.floor(stageLeft), c.height)
  }
  for (let k = 0; k < keys; k++) {
    const own = mine.has(k)
    if (!own && mode !== 'off') continue
    ctx.fillStyle = hides(k)
      ? laneColor(laneHue, laneBrightness)
      : laneColor(laneHue, laneBrightness, own ? laneOpacity : laneOpacity * 0.6)
    ctx.fillRect(xs[k], c.top, ws[k], c.height)
    if (pressed[k]) {
      const glow = ctx.createLinearGradient(0, judgeY, 0, judgeY - c.height * 0.3)
      glow.addColorStop(0, 'rgba(255,102,170,0.45)')
      glow.addColorStop(1, 'rgba(255,102,170,0)')
      ctx.fillStyle = glow
      ctx.fillRect(xs[k], judgeY - c.height * 0.3, ws[k], c.height * 0.3)
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'
    ctx.lineWidth = 1
    ctx.strokeRect(xs[k] + 0.5, c.top, ws[k] - 1, c.height)
  }
  // Host columns are blacked out before the notes so the partner's notes are never hidden under it.
  // Neighbouring host columns are joined so any column spacing between them is covered too.
  if (mode !== 'off') {
    ctx.fillStyle = '#000'
    for (let k = 0; k < keys; k++) {
      if (mine.has(k)) continue
      const right = k + 1 < keys && !mine.has(k + 1) ? Math.ceil(xs[k + 1]) : edgeL(k) + edgeW(k)
      ctx.fillRect(edgeL(k), c.top, right - edgeL(k), c.height)
    }
  }

  const hue = settings?.maniaNoteHue
  const skinColors = skin?.maniaNoteColors
  const noteColor = (k: number) => {
    if (hue != null) return noteHueColor(hue)
    if (keys % 2 === 1 && k === (keys - 1) / 2) return skinColors?.noteS ?? '#fcb81e'
    // osu! mirrors note1/note2 out from the stage edges, e.g. 1 2 2 1 in 4K.
    return Math.min(k, keys - 1 - k) % 2 === 0 ? (skinColors?.note1 ?? '#f4f4f5') : (skinColors?.note2 ?? '#ff66aa')
  }

  const yFor = (t: number) => judgeY - (scrollPosition(scroll, t) - nowPos) * pxPerSongMs
  const noteH = Math.max(6, 12 * unit)
  const start = firstVisible(map.notes, time - MANIA_WINDOW_MS - MISS_FADE_MS)
  for (let i = start; i < map.notes.length; i++) {
    const note = map.notes[i]
    // Scroll position only grows with time, so the first note above the stage ends the scan.
    if (note.time > time && yFor(note.time) < c.top - noteH) break
    const k = note.column
    if (k >= keys) continue
    const own = mine.has(k)
    if (!own && mode !== 'off') continue
    const hold = note.end > note.time
    let state = judge.state[i]
    if (state === HIT) continue
    let alpha = 1
    let headTime = note.time
    if (own) {
      if (state === PENDING && time > note.time + MANIA_WINDOW_MS) {
        judge.state[i] = state = MISSED
        judge.missedAt[i] = time
      }
      if (state === HOLDING) {
        headTime = Math.max(note.time, time)
        // Held through the end: the release window passing finishes it.
        if (time > note.end + MANIA_WINDOW_MS) {
          judge.state[i] = HIT
          judge.holding.delete(k)
          continue
        }
      }
      if (state === MISSED) {
        const fadeFrom = hold ? Math.max(judge.missedAt[i], note.end) : judge.missedAt[i]
        alpha = Math.max(0, 1 - (time - fadeFrom) / MISS_FADE_MS) * 0.45
      }
    } else {
      // The host's notes leave at the judgement line; their holds shrink into it.
      if (time >= note.end && (hold || time >= note.time)) continue
      headTime = Math.max(note.time, time)
      alpha = 0.4
    }
    if (alpha <= 0) continue
    const headY = yFor(headTime)
    if (hidden && headY > c.top + (judgeY - c.top) * 0.55 && !hold) continue
    ctx.fillStyle = noteColor(k)
    if (hold) {
      const tailY = yFor(note.end)
      ctx.globalAlpha = alpha * 0.55
      ctx.fillRect(xs[k] + ws[k] * 0.15, tailY, ws[k] * 0.7, Math.max(0, headY - tailY))
    }
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.roundRect(xs[k] + 1, headY - noteH, ws[k] - 2, noteH, 3)
    ctx.fill()
    ctx.globalAlpha = 1
  }

  // Judgement line, then hit bursts above it so they read over the notes.
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  for (let k = 0; k < keys; k++) {
    if (!mine.has(k) && mode !== 'off') continue
    ctx.fillRect(xs[k], judgeY - 1, ws[k], 3)
  }
  for (let k = 0; k < keys; k++) {
    const flash = 1 - (now - (judge.flashAt[k] ?? -Infinity)) / FLASH_MS
    const holding = judge.holding.has(k)
    const strength = holding ? Math.max(flash, 0.6) : flash
    if (strength <= 0) continue
    const glow = ctx.createRadialGradient(xs[k] + ws[k] / 2, judgeY, 0, xs[k] + ws[k] / 2, judgeY, ws[k] * 0.9)
    glow.addColorStop(0, `rgba(${HIT_GLOW},${0.85 * strength})`)
    glow.addColorStop(1, `rgba(${HIT_GLOW},0)`)
    ctx.fillStyle = glow
    ctx.fillRect(xs[k] - ws[k] * 0.4, judgeY - ws[k] * 0.9, ws[k] * 1.8, ws[k] * 1.8)
  }
}

export function LanePlayfield({
  map,
  mods,
  skin,
  clockRef,
  leadMsRef,
  videoRef,
  view,
}: {
  map: Beatmap
  mods: number
  skin: Skin | null
  clockRef: RefObject<SyncClock>
  leadMsRef: RefObject<number>
  videoRef: RefObject<HTMLVideoElement | null>
  view: LaneView
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const skinRef = useRef(skin)
  skinRef.current = skin

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = canvas?.parentElement
    const ctx = canvas?.getContext('2d')
    if (!canvas || !stage || !ctx) return
    const hidden = (mods & MOD_HIDDEN) !== 0
    const taiko = () => viewRef.current.ruleset === RULESET_TAIKO
    const count = () => (taiko() ? map.drums.length : map.notes.length)
    let judge = newJudge(count())
    let lastTime = -Infinity
    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const dpr = window.devicePixelRatio || 1
      const w = stage.clientWidth
      const h = stage.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const clock = clockRef.current
      const current = viewRef.current
      const inputs = current.inputsRef.current ?? []
      if (!clock?.ready) {
        inputs.length = 0
        return
      }
      const lead = clock.rate * (leadMsRef.current ?? 0)
      const time = clock.at(performance.now()) + lead
      // A retry or seek back starts the map over, so every note is pending again.
      if (time < lastTime - 500 || judge.state.length !== count()) judge = newJudge(count())
      lastTime = time
      for (const input of inputs.splice(0)) {
        const at = clock.at(input.at) + lead
        if (taiko()) judgeTaiko(map.drums, judge, input, at)
        else judgeMania(map.notes, judge, input, at)
      }
      const content = contentRect(stage, videoRef.current)
      ctx.save()
      ctx.beginPath()
      ctx.rect(content.left, content.top, content.width, content.height)
      ctx.clip()
      if (taiko()) drawTaiko(ctx, content, map, judge, time, current, hidden)
      else drawMania(ctx, content, map, skinRef.current, judge, time, clock.rate || 1, current, hidden)
      ctx.restore()
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [map, mods, clockRef, leadMsRef, videoRef])

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />
}
