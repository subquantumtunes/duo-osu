'use client'

import { useCallback, useEffect, useState } from 'react'
import { RULESET_MANIA, RULESET_TAIKO } from '@/lib/lanes'

/** The judgements the partner is shown; 300s are left out on purpose so only mistakes stand out. */
export type Judgement = 100 | 50 | 0

/** `at` is the host's song time when osu! counted it; `shown` is the partner's `performance.now()` on arrival. */
export type JudgementEvent = { j: Judgement; at: number; shown: number; x?: number; y?: number }

export const JUDGEMENT_MS = 650
const MAX_KEPT = 24

export function isJudgement(value: unknown): value is Judgement {
  return value === 100 || value === 50 || value === 0
}

export function pushJudgement(list: JudgementEvent[], j: Judgement, at: number) {
  list.push({ j, at, shown: performance.now() })
  if (list.length > MAX_KEPT) list.splice(0, list.length - MAX_KEPT)
}

const COLORS: Record<Judgement, string> = { 100: '#6ee06e', 50: '#f2c14e', 0: '#ff4d4d' }

function labelFor(j: Judgement, ruleset: number | null) {
  if (j === 0) return ruleset === RULESET_TAIKO || ruleset === RULESET_MANIA ? 'MISS' : '\u00d7'
  if (ruleset === RULESET_TAIKO) return 'GOOD'
  return String(j)
}

/** Pops in, drifts up a little, and fades, like osu!'s own judgement sprites. */
export function drawJudgement(
  ctx: CanvasRenderingContext2D,
  event: JudgementEvent,
  ruleset: number | null,
  x: number,
  y: number,
  size: number,
  now: number,
) {
  const age = now - event.shown
  if (age < 0 || age > JUDGEMENT_MS) return
  const pop = age < 90 ? 1.35 - (age / 90) * 0.35 : 1
  const fade = age > JUDGEMENT_MS - 220 ? (JUDGEMENT_MS - age) / 220 : 1
  const miss = event.j === 0
  const px = size * pop * (miss && ruleset !== RULESET_TAIKO && ruleset !== RULESET_MANIA ? 1.6 : 1)
  ctx.save()
  ctx.globalAlpha = Math.max(0, fade)
  ctx.font = `800 ${Math.round(px)}px ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(2, px * 0.14)
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  const label = labelFor(event.j, ruleset)
  const dy = -(age / JUDGEMENT_MS) * size * 0.4
  ctx.strokeText(label, x, y + dy)
  ctx.fillStyle = COLORS[event.j]
  ctx.fillText(label, x, y + dy)
  ctx.restore()
}

const STORAGE_KEY = 'duosu:judgements'

/** Whether the partner sees 100/50/miss judgements on their copy of the map; remembered on this device. */
export function useJudgementSetting() {
  const [on, setOn] = useState(true)

  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(STORAGE_KEY) !== '0')
    } catch {}
  }, [])

  const update = useCallback((next: boolean) => {
    setOn(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {}
  }, [])

  return [on, update] as const
}
