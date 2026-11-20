'use client'

import { type RefObject, useEffect, useRef } from 'react'
import type { Beatmap, DrumNote, ManiaNote } from '@/lib/beatmap'
import { MOD_HIDDEN } from '@/lib/beatmap'
import { RULESET_TAIKO } from '@/lib/lanes'
import type { SyncClock } from '@/lib/sync-clock'

const DON = '#eb4f4f'
const KAT = '#4fa9eb'
const ROLL = '#fcb81e'
const SWELL = '#f59a3c'
/** How long a mania note is on screen before its hit time, in real milliseconds. */
const MANIA_SCROLL_MS = 650
/** Taiko notes sit about this many real milliseconds ahead of the hit circle per track width. */
const TAIKO_BASE_VELOCITY = 1.4

export type LaneView = {
  ruleset: number
  /** Lanes the partner plays; the rest are drawn dimmed. */
  lanes: number[]
  /** Pressed state per lane. */
  pressedRef: RefObject<boolean[]>
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

function drawTaiko(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  drums: DrumNote[],
  time: number,
  rate: number,
  view: LaneView,
  hidden: boolean,
) {
  const trackH = Math.min(h * 0.32, 180)
  const top = (h - trackH) / 2
  const hitX = Math.max(trackH * 0.9, w * 0.14)
  const r = trackH * 0.28
  const scale = (w / 1024) * TAIKO_BASE_VELOCITY
  ctx.fillStyle = 'rgba(14, 10, 14, 0.92)'
  ctx.fillRect(0, top, w, trackH)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(hitX, top + trackH / 2, r * 1.05, 0, Math.PI * 2)
  ctx.stroke()

  const pressed = view.pressedRef.current ?? []
  const playsKat = view.lanes.includes(0) || view.lanes.includes(3)
  const playsDon = view.lanes.includes(1) || view.lanes.includes(2)
  // Drum halves light up so the partner sees which of their keys is down.
  for (let lane = 0; lane < 4; lane++) {
    if (!pressed[lane]) continue
    const kat = lane === 0 || lane === 3
    ctx.fillStyle = kat ? 'rgba(79,169,235,0.55)' : 'rgba(235,79,79,0.55)'
    ctx.beginPath()
    const left = lane < 2
    ctx.arc(hitX, top + trackH / 2, kat ? r * 1.05 : r * 0.8, left ? Math.PI / 2 : -Math.PI / 2, left ? Math.PI * 1.5 : Math.PI / 2)
    ctx.fill()
  }

  const fromTime = time - 200
  const start = firstVisible(drums, fromTime)
  const cy = top + trackH / 2
  // Draw back to front so earlier notes sit on top, as in osu!.
  const visible: DrumNote[] = []
  for (let i = start; i < drums.length; i++) {
    const note = drums[i]
    const x = hitX + (note.time - time) * note.velocity * scale
    if (x > w + r * 2) break
    visible.push(note)
  }
  for (let i = visible.length - 1; i >= 0; i--) {
    const note = visible[i]
    const speed = note.velocity * scale
    const x = hitX + (note.time - time) * speed
    const nr = note.big ? r * 1.4 : r
    if (hidden && x < hitX + w * 0.35) continue
    if (note.kind === 'roll' || note.kind === 'swell') {
      const endX = note.kind === 'swell' ? x : hitX + (note.end - time) * speed
      if (endX < hitX - nr && note.kind === 'roll') continue
      if (note.kind === 'roll') {
        ctx.fillStyle = ROLL
        ctx.globalAlpha = 0.85
        ctx.beginPath()
        ctx.roundRect(Math.max(x, hitX) - nr * 0.8, cy - nr * 0.8, Math.max(0, endX - Math.max(x, hitX)) + nr * 1.6, nr * 1.6, nr * 0.8)
        ctx.fill()
      } else {
        const sx = time >= note.time && time <= note.end ? hitX : x
        ctx.fillStyle = SWELL
        ctx.beginPath()
        ctx.arc(sx, cy, r * 1.2, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      continue
    }
    if (time > note.time + 100) continue
    const kat = note.kind === 'kat'
    const mine = kat ? playsKat : playsDon
    ctx.globalAlpha = mine ? 1 : 0.28
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
  w: number,
  h: number,
  notes: ManiaNote[],
  keys: number,
  time: number,
  rate: number,
  view: LaneView,
  hidden: boolean,
) {
  const colW = Math.min(72, (w * 0.7) / keys)
  const left = (w - colW * keys) / 2
  const judgeY = h - Math.max(64, h * 0.12)
  const span = MANIA_SCROLL_MS * rate
  const pressed = view.pressedRef.current ?? []
  ctx.fillStyle = 'rgba(14, 10, 14, 0.92)'
  ctx.fillRect(left, 0, colW * keys, h)
  for (let c = 0; c < keys; c++) {
    const x = left + c * colW
    const mine = view.lanes.includes(c)
    if (mine) {
      ctx.fillStyle = 'rgba(255,102,170,0.06)'
      ctx.fillRect(x, 0, colW, h)
    }
    if (pressed[c]) {
      const glow = ctx.createLinearGradient(0, judgeY, 0, judgeY - h * 0.3)
      glow.addColorStop(0, 'rgba(255,102,170,0.45)')
      glow.addColorStop(1, 'rgba(255,102,170,0)')
      ctx.fillStyle = glow
      ctx.fillRect(x, judgeY - h * 0.3, colW, h * 0.3)
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.fillRect(left, judgeY, colW * keys, 3)

  const yFor = (t: number) => judgeY - ((t - time) / span) * judgeY
  const start = firstVisible(notes, time - 150)
  const noteH = Math.max(10, colW * 0.32)
  for (let i = start; i < notes.length; i++) {
    const note = notes[i]
    if (note.time > time + span * 1.05) break
    if (note.column >= keys) continue
    const mine = view.lanes.includes(note.column)
    const x = left + note.column * colW + 2
    const headY = yFor(Math.max(note.time, note.end > note.time ? time : note.time))
    if (hidden && headY > judgeY * 0.55 && note.end <= note.time) continue
    ctx.globalAlpha = mine ? 1 : 0.25
    const color = keys % 2 === 1 && note.column === (keys - 1) / 2 ? '#fcb81e' : note.column % 2 === 0 ? '#f4f4f5' : '#ff66aa'
    if (note.end > note.time) {
      if (note.end < time - 50) {
        ctx.globalAlpha = 1
        continue
      }
      const tailY = yFor(note.end)
      ctx.fillStyle = color
      ctx.globalAlpha *= 0.55
      ctx.fillRect(x + colW * 0.15, tailY, colW - 4 - colW * 0.3, Math.max(0, headY - tailY))
      ctx.globalAlpha = mine ? 1 : 0.25
    } else if (note.time < time - 100) {
      ctx.globalAlpha = 1
      continue
    }
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(x, headY - noteH, colW - 4, noteH, 3)
    ctx.fill()
    ctx.globalAlpha = 1
  }
}

export function LanePlayfield({
  map,
  mods,
  clockRef,
  leadMsRef,
  view,
}: {
  map: Beatmap
  mods: number
  clockRef: RefObject<SyncClock>
  leadMsRef: RefObject<number>
  view: LaneView
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const hidden = (mods & MOD_HIDDEN) !== 0
    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const clock = clockRef.current
      if (!clock) return
      const time = clock.at(performance.now()) + clock.rate * (leadMsRef.current ?? 0)
      const rate = clock.rate || 1
      const current = viewRef.current
      if (current.ruleset === RULESET_TAIKO) drawTaiko(ctx, w, h, map.drums, time, rate, current, hidden)
      else drawMania(ctx, w, h, map.notes, map.keys, time, rate, current, hidden)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [map, mods, clockRef, leadMsRef])

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />
}
