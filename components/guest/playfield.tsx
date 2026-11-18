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

function drawReverseArrow(ctx: Ctx, skin: Skin | null, x: number, y: number, angle: number, radius: number, unit: number) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  if (skin?.reverseArrow) {
    drawSprite(ctx, skin.reverseArrow, skin.reverseArrow.hd, 0, 0, unit)
  } else {
    const s = radius * 0.45
    ctx.beginPath()
    ctx.moveTo(-s * 0.5, -s)
    ctx.lineTo(s * 0.6, 0)
    ctx.lineTo(-s * 0.5, s)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = Math.max(2, radius * 0.16)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
  }
  ctx.restore()
}

/** osu! sizes cursor art for a 768px-tall screen. */
function drawCursor(ctx: Ctx, skin: Skin | null, x: number, y: number, fieldScale: number) {
  const unit = (fieldScale * 480) / 768
  if (skin?.cursor) {
    drawSprite(ctx, skin.cursor, skin.cursor.hd, x, y, unit)
    return
  }
  ctx.beginPath()
  ctx.arc(x, y, 18 * unit, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255, 204, 51, 0.35)'
  ctx.fill()
  ctx.lineWidth = Math.max(2, 4 * unit)
  ctx.strokeStyle = '#ffcc33'
  ctx.stroke()
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
  cursorRef,
}: {
  /** The partner's own aim, 0..1 across the video, drawn above the notes. */
  cursorRef?: RefObject<{ x: number; y: number } | null>
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
    const firstObject = map.objects.find((o) => o.kind !== 'spinner')
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
      const content = contentRect(stage, videoRef.current)
      const field = playfieldRect(content)
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
        const fadeInMs = diff.hidden ? diff.preempt * 0.4 : diff.fadeIn
        const fadeIn = Math.min(1, (time - appear) / fadeInMs)
        const fadeOut = time > obj.end ? 1 - (time - obj.end) / FADE_OUT_MS : 1
        const shownAlpha = Math.max(0, Math.min(fadeIn, fadeOut))
        // Hidden: the head fades away before it's hit, and slider bodies fade across their length.
        const hiddenStart = appear + fadeInMs
        const headAlpha = diff.hidden
          ? Math.max(0, Math.min(fadeIn, 1 - (time - hiddenStart) / (diff.preempt * 0.3)))
          : shownAlpha
        const bodyAlpha =
          diff.hidden && obj.end > hiddenStart
            ? Math.max(0, Math.min(fadeIn, 1 - (time - hiddenStart) / (obj.end - hiddenStart)))
            : shownAlpha
        ctx.globalAlpha = bodyAlpha

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
          const pts = obj.path.points
          const slides = obj.slides ?? 1
          if (slides > 1 && obj.slideDuration && pts.length > 1) {
            const at = (p: { x: number; y: number }) => toScreen(obj.x + p.x - pts[0].x, obj.y + p.y - pts[0].y)
            const endHead = at(pts[pts.length - 1])
            const endPrev = at(pts[pts.length - 2])
            const startHead = at(pts[0])
            const startNext = at(pts[1])
            let atEnd = false
            let atStart = false
            for (let turn = 1; turn < slides; turn++) {
              if (obj.time + turn * obj.slideDuration <= time) continue
              if (turn % 2 === 1) atEnd = true
              else atStart = true
            }
            ctx.globalAlpha = headAlpha > 0 ? Math.max(headAlpha, bodyAlpha) : bodyAlpha
            if (atEnd) {
              const angle = Math.atan2(endPrev.y - endHead.y, endPrev.x - endHead.x)
              drawReverseArrow(ctx, skin, endHead.x, endHead.y, angle, radius, unit)
            }
            if (atStart && time >= obj.time) {
              const angle = Math.atan2(startNext.y - startHead.y, startNext.x - startHead.x)
              drawReverseArrow(ctx, skin, startHead.x, startHead.y, angle, radius, unit)
            }
            ctx.globalAlpha = bodyAlpha
          }

          const ball = time >= obj.time ? sliderBallAt(obj, time) : null
          if (ball) {
            ctx.globalAlpha = shownAlpha
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
          ctx.globalAlpha = headAlpha
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

          // Hidden keeps only the very first approach circle, as osu! does.
          if (time < obj.time && (!diff.hidden || obj === firstObject)) {
            ctx.globalAlpha = shownAlpha
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
      const aim = cursorRef?.current
      if (aim) {
        drawCursor(ctx, skin, content.left + aim.x * content.width, content.top + aim.y * content.height, field.scale)
      }
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [map, mods, clockRef, leadMsRef, videoRef, skin, cursorRef])

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />
}
