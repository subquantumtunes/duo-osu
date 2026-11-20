'use client'

import { useCallback, useEffect, useState } from 'react'
import { RULESET_MANIA, RULESET_TAIKO } from '@/lib/lanes'
import type { JudgementSpriteName, Skin } from '@/lib/skin'

/** The judgements the partner is shown; 300s are left out on purpose so only mistakes stand out. */
export type Judgement = 100 | 50 | 0

/** `at` is the host's song time when osu! counted it; `shown` is the partner's `performance.now()` on arrival. */
export type JudgementEvent = { j: Judgement; at: number; shown: number; x?: number; y?: number }

const MAX_KEPT = 24

export function isJudgement(value: unknown): value is Judgement {
  return value === 100 || value === 50 || value === 0
}

export function pushJudgement(list: JudgementEvent[], j: Judgement, at: number) {
  list.push({ j, at, shown: performance.now() })
  if (list.length > MAX_KEPT) list.splice(0, list.length - MAX_KEPT)
}

/** How the partner wants judgements drawn: `size` and `opacity` are percentages, `duration` is in ms. */
export type JudgementStyle = { on: boolean; kind: JudgementKind; size: number; opacity: number; duration: number }

/** `skin` uses the host skin's sprites, `traditional` draws 100/50/x text, `modern` draws coloured circles. */
export type JudgementKind = 'skin' | 'traditional' | 'modern'

export const JUDGEMENT_KINDS: { value: JudgementKind; label: string }[] = [
  { value: 'skin', label: "Host's skin" },
  { value: 'traditional', label: 'Traditional (100 / 50 / x)' },
  { value: 'modern', label: 'Modern (coloured circles)' },
]

function isJudgementKind(value: unknown): value is JudgementKind {
  return value === 'skin' || value === 'traditional' || value === 'modern'
}

export const JUDGEMENT_SIZE_MIN = 50
export const JUDGEMENT_SIZE_MAX = 250
export const JUDGEMENT_OPACITY_MIN = 10
export const JUDGEMENT_OPACITY_MAX = 100
export const JUDGEMENT_DURATION_MIN = 200
export const JUDGEMENT_DURATION_MAX = 2000

export const DEFAULT_JUDGEMENT_STYLE: JudgementStyle = {
  on: true,
  kind: 'skin',
  size: 100,
  opacity: 100,
  duration: 650,
}

const COLORS: Record<Judgement, string> = { 100: '#6ee06e', 50: '#f2c14e', 0: '#ff4d4d' }

function labelFor(j: Judgement, ruleset: number | null) {
  if (j === 0) return ruleset === RULESET_TAIKO || ruleset === RULESET_MANIA ? 'MISS' : '\u00d7'
  if (ruleset === RULESET_TAIKO) return 'GOOD'
  return String(j)
}

/** The host skin's sprite for a judgement, as osu! picks it for each mode. */
function spriteFor(skin: Skin | null | undefined, j: Judgement, ruleset: number | null) {
  if (!skin) return null
  let name: JudgementSpriteName
  if (ruleset === RULESET_TAIKO) name = j === 0 ? 'taiko-hit0' : 'taiko-hit100'
  else if (ruleset === RULESET_MANIA) name = `mania-hit${j}`
  else name = `hit${j}`
  return skin.judgementSprites?.[name] ?? null
}

/**
 * Pops in, drifts up a little, and fades, like osu!'s own judgement sprites. Uses the host's
 * skin sprite when it has one, and falls back to coloured text otherwise.
 */
export function drawJudgement(
  ctx: CanvasRenderingContext2D,
  event: JudgementEvent,
  ruleset: number | null,
  x: number,
  y: number,
  size: number,
  now: number,
  style: JudgementStyle = DEFAULT_JUDGEMENT_STYLE,
  skin?: Skin | null,
) {
  const duration = style.duration
  const age = now - event.shown
  if (age < 0 || age > duration) return
  const fadeMs = Math.min(220, duration * 0.4)
  const pop = age < 90 ? 1.35 - (age / 90) * 0.35 : 1
  const fade = age > duration - fadeMs ? (duration - age) / fadeMs : 1
  const scale = (style.size / 100) * pop
  const dy = -(age / duration) * size * 0.4
  ctx.save()
  ctx.globalAlpha = Math.max(0, fade) * (style.opacity / 100)

  if (style.kind === 'modern') {
    const r = size * scale * 0.42
    ctx.beginPath()
    ctx.arc(x, y + dy, r, 0, Math.PI * 2)
    ctx.fillStyle = COLORS[event.j]
    ctx.fill()
    ctx.lineWidth = Math.max(2, r * 0.22)
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'
    ctx.stroke()
    ctx.restore()
    return
  }

  const sprite = style.kind === 'skin' ? spriteFor(skin, event.j, ruleset) : null
  if (sprite) {
    // Skin sprites are drawn at their own size, scaled with the playfield (`size` is 30 osu! pixels).
    const unit = (size / 30) * scale / (sprite.hd ? 2 : 1)
    const w = sprite.image.width * unit
    const h = sprite.image.height * unit
    ctx.drawImage(sprite.image, x - w / 2, y + dy - h / 2, w, h)
    ctx.restore()
    return
  }

  const label = style.kind === 'traditional' ? (event.j === 0 ? '\u00d7' : String(event.j)) : labelFor(event.j, ruleset)
  const px = size * scale * (label === '\u00d7' ? 1.6 : 1)
  ctx.font = `800 ${Math.round(px)}px ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(2, px * 0.14)
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.strokeText(label, x, y + dy)
  ctx.fillStyle = COLORS[event.j]
  ctx.fillText(label, x, y + dy)
  ctx.restore()
}

/** The host's combo; `changed` is the partner's `performance.now()` when it last went up. */
export type ComboState = { value: number; changed: number }

export function setCombo(state: ComboState, value: number) {
  if (value > state.value) state.changed = performance.now()
  state.value = value
}

/** osu!'s combo counter: hidden below 2, with a short bump each time it goes up. */
export function drawCombo(
  ctx: CanvasRenderingContext2D,
  combo: ComboState,
  x: number,
  y: number,
  size: number,
  now: number,
) {
  if (combo.value < 2) return
  const age = now - combo.changed
  const bump = age >= 0 && age < 120 ? 1.18 - (age / 120) * 0.18 : 1
  const px = size * bump
  ctx.save()
  ctx.font = `800 ${Math.round(px)}px ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(2, px * 0.12)
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  const label = String(combo.value)
  ctx.strokeText(label, x, y)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(label, x, y)
  ctx.restore()
}

const STORAGE_KEY = 'duosu:judgements'
const STYLE_KEY = 'duosu:judgement-style'

function clamp(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

/** The partner's judgement settings; remembered on this device. */
export function useJudgementSettings() {
  const [style, setStyle] = useState<JudgementStyle>(DEFAULT_JUDGEMENT_STYLE)

  useEffect(() => {
    try {
      const on = window.localStorage.getItem(STORAGE_KEY) !== '0'
      const saved = JSON.parse(window.localStorage.getItem(STYLE_KEY) ?? '{}') as Partial<JudgementStyle>
      setStyle({
        on,
        kind: isJudgementKind(saved.kind) ? saved.kind : DEFAULT_JUDGEMENT_STYLE.kind,
        size: clamp(saved.size, JUDGEMENT_SIZE_MIN, JUDGEMENT_SIZE_MAX, DEFAULT_JUDGEMENT_STYLE.size),
        opacity: clamp(saved.opacity, JUDGEMENT_OPACITY_MIN, JUDGEMENT_OPACITY_MAX, DEFAULT_JUDGEMENT_STYLE.opacity),
        duration: clamp(saved.duration, JUDGEMENT_DURATION_MIN, JUDGEMENT_DURATION_MAX, DEFAULT_JUDGEMENT_STYLE.duration),
      })
    } catch {}
  }, [])

  const update = useCallback((patch: Partial<JudgementStyle>) => {
    setStyle((prev) => {
      const next = { ...prev, ...patch }
      try {
        window.localStorage.setItem(STORAGE_KEY, next.on ? '1' : '0')
        window.localStorage.setItem(
          STYLE_KEY,
          JSON.stringify({ kind: next.kind, size: next.size, opacity: next.opacity, duration: next.duration }),
        )
      } catch {}
      return next
    })
  }, [])

  return [style, update] as const
}
