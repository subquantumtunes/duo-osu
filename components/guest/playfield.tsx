'use client'

import { type RefObject, useEffect, useRef } from 'react'
import { type Beatmap, type HitObject, difficultyFor, sliderBallAt } from '@/lib/beatmap'
import type { Skin, SkinSprite } from '@/lib/skin'
import type { SyncClock } from '@/lib/sync-clock'

const COMBO_COLORS = ['#ff66aa', '#66ccff', '#ffcc33', '#99ee77']
const FADE_OUT_MS = 150
/** osu! sizes skin textures so a 128px (SD) hitcircle spans a 64 osu!px radius. */
const SD_RADIUS_PX = 64
const NUMBER_SCALE = 0.8

type Ctx = CanvasRenderingContext2D

function drawSprite(ctx: Ctx, sprite: SkinSprite | CanvasImageSource, hd: boolean, x: number, y: number, unit: number) {
  const image = 'image' in sprite ? sprite.image : sprite
  const w = ((image as ImageBitmap).width / (hd ? 2 : 1)) * unit
  const h = ((image as ImageBitmap).height / (hd ? 2 : 1)) * unit
  ctx.drawImage(image, x - w / 2, y - h / 2, w, h)
}

/** Multiplies a sprite by a combo colour, keeping its alpha, the way osu! tints hitcircles. */
function makeTinter() {
  const cache = new Map<ImageBitmap, Map<string, HTMLCanvasElement>>()
  return (sprite: SkinSprite, color: string) => {
    let byColor = cache.get(sprite.image)
    if (!byColor) cache.set(sprite.image, (byColor = new Map()))
    const hit = byColor.get(color)
    if (hit) return hit
    const canvas = document.createElement('canvas')
    canvas.width = sprite.image.width
    canvas.height = sprite.image.height
    const c = canvas.getContext('2d')!
    c.drawImage(sprite.image, 0, 0)
    c.globalCompositeOperation = 'multiply'
    c.fillStyle = color
    c.fillRect(0, 0, canvas.width, canvas.height)
    c.globalCompositeOperation = 'destination-in'
    c.drawImage(sprite.image, 0, 0)
    byColor.set(color, canvas)
    return canvas
  }
}

function drawNumber(ctx: Ctx, skin: Skin, value: number, x: number, y: number, unit: number) {
  const digits = skin.digits
  if (!digits) return false
  const sprites = String(value)
    .split('')
    .map((d) => digits[Number(d)])
  const scale = unit * NUMBER_SCALE
  const widths = sprites.map((s) => (s.image.width / (s.hd ? 2 : 1)) * scale)
  const overlap = skin.digitOverlap * scale
  const total = widths.reduce((sum, w) => sum + w, 0) - overlap * (sprites.length - 1)
  let left = x - total / 2
  sprites.forEach((sprite, i) => {
    drawSprite(ctx, sprite, sprite.hd, left + widths[i] / 2, y, scale)
    left += widths[i] - overlap
  })
  return true
}

type Rect = { left: number; top: number; width: number; height: number }

/** Where osu! stable puts its 512x384 playfield inside a fullscreen game of the given size. */
function playfieldRect(screen: Rect) {
  const scale = screen.height / 480
  const width = 512 * scale
  const height = 384 * scale
  return {
    scale,
    left: screen.left + (screen.width - width) / 2,
    top: screen.top + (screen.height - height) / 2 + 8 * scale,
  }
}

function contentRect(stage: HTMLElement, video: HTMLVideoElement | null): Rect {
  const width = stage.clientWidth
  const height = stage.clientHeight
  const vw = video?.videoWidth || 16
  const vh = video?.videoHeight || 9
  const scale = Math.min(width / vw, height / vh)
  return { left: (width - vw * scale) / 2, top: (height - vh * scale) / 2, width: vw * scale, height: vh * scale }
}

export function Playfield({
  map,
  mods,
  clockRef,
  leadMsRef,
  videoRef,
  skin = null,
}: {
  /** The host's osu! skin; any missing piece falls back to the built-in drawing. */
  skin?: Skin | null
  map: Beatmap
  mods: number
  clockRef: RefObject<SyncClock>
  /** How far ahead of the host's song position to draw, so input lands on time. */
  leadMsRef: RefObject<number>
  videoRef: RefObject<HTMLVideoElement | null>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = canvas?.parentElement
    const ctx = canvas?.getContext('2d')
    if (!canvas || !stage || !ctx) return
    const diff = difficultyFor(map, mods)
    const colors = skin?.comboColors ?? COMBO_COLORS
    const tint = makeTinter()
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
      if (!clock?.ready) return
      const time = clock.at(performance.now()) + clock.rate * (leadMsRef.current ?? 0)
      const field = playfieldRect(contentRect(stage, videoRef.current))
      const toScreen = (x: number, y: number) => ({
        x: field.left + x * field.scale,
        y: field.top + (diff.flipY ? 384 - y : y) * field.scale,
      })
      const radius = diff.radius * field.scale
      const unit = radius / SD_RADIUS_PX

      const visible: HitObject[] = []
      for (const obj of map.objects) {
        if (obj.time - diff.preempt > time) break
        if (obj.kind === 'spinner' || obj.end + FADE_OUT_MS < time) continue
        visible.push(obj)
      }

      for (let i = visible.length - 1; i >= 0; i--) {
        const obj = visible[i]
        const color = colors[obj.comboIndex % colors.length]
        const appear = obj.time - diff.preempt
        const fadeIn = Math.min(1, (time - appear) / diff.fadeIn)
        const fadeOut = time > obj.end ? 1 - (time - obj.end) / FADE_OUT_MS : 1
        ctx.globalAlpha = Math.max(0, Math.min(fadeIn, fadeOut))

        if (obj.kind === 'slider' && obj.path) {
          ctx.beginPath()
          obj.path.points.forEach((p, idx) => {
            const s = toScreen(obj.x + p.x - obj.path!.points[0].x, obj.y + p.y - obj.path!.points[0].y)
            if (idx === 0) ctx.moveTo(s.x, s.y)
            else ctx.lineTo(s.x, s.y)
          })
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          ctx.strokeStyle = skin ? (skin.sliderBorder ?? '#fff') : 'rgba(255,255,255,0.85)'
          ctx.lineWidth = radius * 2
          ctx.stroke()
          ctx.lineWidth = radius * 1.8
          if (skin) {
            ctx.strokeStyle = skin.sliderTrack ?? color
            ctx.stroke()
            ctx.strokeStyle = 'rgba(0,0,0,0.55)'
            ctx.stroke()
          } else {
            ctx.strokeStyle = 'rgba(20,16,28,0.9)'
            ctx.stroke()
          }
          const ball = time >= obj.time ? sliderBallAt(obj, time) : null
          if (ball) {
            const b = toScreen(ball.x, ball.y)
            if (skin?.sliderBall) {
              drawSprite(ctx, skin.sliderBall, skin.sliderBall.hd, b.x, b.y, unit)
            } else {
              ctx.beginPath()
              ctx.arc(b.x, b.y, radius * 0.8, 0, Math.PI * 2)
              ctx.fillStyle = color
              ctx.fill()
            }
          }
        }

        if (time < obj.time + FADE_OUT_MS) {
          const c = toScreen(obj.x, obj.y)
          const number = () => {
            if (skin && drawNumber(ctx, skin, obj.comboNumber, c.x, c.y, unit)) return
            ctx.fillStyle = '#fff'
            ctx.font = `600 ${Math.round(radius * 0.8)}px Geist, sans-serif`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(String(obj.comboNumber), c.x, c.y + 1)
          }

          if (skin?.hitcircle) {
            drawSprite(ctx, tint(skin.hitcircle, color), skin.hitcircle.hd, c.x, c.y, unit)
            const overlay = () => skin.overlay && drawSprite(ctx, skin.overlay, skin.overlay.hd, c.x, c.y, unit)
            if (skin.overlayAboveNumber) {
              number()
              overlay()
            } else {
              overlay()
              number()
            }
          } else {
            ctx.beginPath()
            ctx.arc(c.x, c.y, radius, 0, Math.PI * 2)
            ctx.fillStyle = color
            ctx.fill()
            ctx.lineWidth = Math.max(2, radius * 0.12)
            ctx.strokeStyle = '#fff'
            ctx.stroke()
            number()
          }

          if (time < obj.time) {
            const progress = (obj.time - time) / diff.preempt
            if (skin?.approach) {
              const ring = tint(skin.approach, color)
              drawSprite(ctx, ring, skin.approach.hd, c.x, c.y, unit * (1 + 3 * progress))
            } else {
              ctx.beginPath()
              ctx.arc(c.x, c.y, radius * (1 + 3 * progress), 0, Math.PI * 2)
              ctx.strokeStyle = color
              ctx.lineWidth = Math.max(2, radius * 0.1)
              ctx.stroke()
            }
          }
        }
      }
      ctx.globalAlpha = 1
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [map, mods, clockRef, leadMsRef, videoRef, skin])

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />
}
