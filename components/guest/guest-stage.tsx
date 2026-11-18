'use client'

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { Beatmap } from '@/lib/beatmap'
import type { Skin } from '@/lib/skin'
import type { SyncClock } from '@/lib/sync-clock'
import { Playfield } from './playfield'
import { Maximize, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { KeyLights } from '@/components/key-lights'
import type { Role, TapSlot, VideoIssue } from '@/lib/protocol'
import { cn } from '@/lib/utils'
import { VideoIssueOverlay } from './video-issue'

type Source = 'keyboard' | 'mouse'

function videoContentRect(video: HTMLVideoElement) {
  const rect = video.getBoundingClientRect()
  const vw = video.videoWidth || rect.width
  const vh = video.videoHeight || rect.height
  const scale = Math.min(rect.width / vw, rect.height / vh)
  const width = vw * scale
  const height = vh * scale
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export type PlayfieldProps = {
  map: Beatmap
  mods: number
  clockRef: RefObject<SyncClock>
  leadMsRef: RefObject<number>
  skin: Skin | null
}

export function GuestStage({
  stream,
  role,
  bindings,
  sendAim,
  sendKey,
  playfield,
  videoIssue,
  onRetryVideo,
}: {
  videoIssue: VideoIssue | null
  onRetryVideo: () => void
  stream: MediaStream | null
  role: Role
  bindings: { k1: string; k2: string }
  sendAim: (x: number, y: number) => void
  sendKey: (k: TapSlot, down: boolean) => void
  playfield: PlayfieldProps | null
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [needsUnmute, setNeedsUnmute] = useState(false)
  const [pressed, setPressed] = useState({ k1: false, k2: false })
  const held = useRef<Record<TapSlot, Set<Source>>>({ k1: new Set(), k2: new Set() })
  const cursorRef = useRef<{ x: number; y: number } | null>(null)

  // Audio plays through its own element: the video element is re-attached whenever the video
  // call restarts, and keeping it muted means autoplay rules can never pause the picture.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const track = stream?.getAudioTracks()[0] ?? null
    const current = (audio.srcObject as MediaStream | null)?.getAudioTracks()[0] ?? null
    if (track === current) return
    audio.srcObject = track ? new MediaStream([track]) : null
    if (!track) return
    audio
      .play()
      .then(() => setNeedsUnmute(false))
      .catch(() => setNeedsUnmute(true))
  }, [stream])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = true
    video.srcObject = stream
    if (!stream) return
    // Remote tracks start muted until their first frame; nudge playback when frames begin
    // so the element doesn't sit paused on a black frame.
    const play = () => {
      if (video.paused) video.play().catch(() => {})
    }
    play()
    const tracks = stream.getVideoTracks()
    tracks.forEach((t) => t.addEventListener('unmute', play))
    video.addEventListener('loadedmetadata', play)
    return () => {
      tracks.forEach((t) => t.removeEventListener('unmute', play))
      video.removeEventListener('loadedmetadata', play)
    }
  }, [stream])

  const press = useCallback(
    (slot: TapSlot, source: Source, down: boolean) => {
      const set = held.current[slot]
      const wasDown = set.size > 0
      if (down) set.add(source)
      else set.delete(source)
      const isDown = set.size > 0
      if (wasDown !== isDown) {
        sendKey(slot, isDown)
        setPressed((p) => ({ ...p, [slot]: isDown }))
      }
    },
    [sendKey],
  )

  const releaseAll = useCallback(() => {
    for (const slot of ['k1', 'k2'] as const) {
      if (held.current[slot].size > 0) {
        held.current[slot].clear()
        sendKey(slot, false)
      }
    }
    setPressed({ k1: false, k2: false })
  }, [sendKey])

  useEffect(() => {
    if (role !== 'aim') return
    const stage = stageRef.current
    const video = videoRef.current
    if (!stage || !video) return
    const eventName = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove'
    const onMove = (e: Event) => {
      const { clientX, clientY } = e as PointerEvent
      const r = videoContentRect(video)
      if (r.width === 0) return
      const x = clamp01((clientX - r.left) / r.width)
      const y = clamp01((clientY - r.top) / r.height)
      cursorRef.current = { x, y }
      sendAim(x, y)
    }
    const onLeave = () => {
      cursorRef.current = null
    }
    stage.addEventListener(eventName, onMove)
    stage.addEventListener('pointerleave', onLeave)
    return () => {
      stage.removeEventListener(eventName, onMove)
      stage.removeEventListener('pointerleave', onLeave)
      cursorRef.current = null
    }
  }, [role, sendAim])

  useEffect(() => {
    if (role !== 'tap') return
    const slotFor = (key: string): TapSlot | null => {
      const k = key === ' ' ? ' ' : key.toLowerCase()
      if (k === bindings.k1) return 'k1'
      if (k === bindings.k2) return 'k2'
      return null
    }
    const onDown = (e: KeyboardEvent) => {
      const slot = slotFor(e.key)
      if (!slot) return
      e.preventDefault()
      if (!e.repeat) press(slot, 'keyboard', true)
    }
    const onUp = (e: KeyboardEvent) => {
      const slot = slotFor(e.key)
      if (!slot) return
      e.preventDefault()
      press(slot, 'keyboard', false)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', releaseAll)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', releaseAll)
      releaseAll()
    }
  }, [role, bindings.k1, bindings.k2, press, releaseAll])

  const mouseSlot = (button: number): TapSlot | null => (button === 0 ? 'k1' : button === 2 ? 'k2' : null)

  return (
    <section className="flex flex-1 flex-col gap-3" aria-label="Host's game">
      <div
        ref={stageRef}
        tabIndex={0}
        aria-label={role === 'aim' ? 'Game view. Move your mouse here to aim.' : 'Game view. Click or press your keys to tap.'}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (role !== 'tap' || e.pointerType !== 'mouse') return
          const slot = mouseSlot(e.button)
          if (slot) press(slot, 'mouse', true)
        }}
        onPointerUp={(e) => {
          if (role !== 'tap' || e.pointerType !== 'mouse') return
          const slot = mouseSlot(e.button)
          if (slot) press(slot, 'mouse', false)
        }}
        className={cn(
          'relative flex min-h-72 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-border bg-black outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50',
          role === 'aim' ? (playfield ? 'cursor-none' : 'cursor-crosshair') : 'cursor-default',
        )}
      >
        <audio ref={audioRef} autoPlay />
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className={cn('absolute inset-0 size-full object-contain transition-opacity', playfield && 'opacity-10')}
        />
        {playfield && (
          <Playfield {...playfield} videoRef={videoRef} cursorRef={role === 'aim' ? cursorRef : undefined} />
        )}
        {!playfield && videoIssue && videoIssue !== 'connecting' ? (
          <VideoIssueOverlay issue={videoIssue} onRetry={onRetryVideo} />
        ) : (
          !playfield &&
          videoIssue === 'connecting' && (
            <p className="relative text-sm text-muted-foreground" role="status">
              Connecting to the host’s video…
            </p>
          )
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {role === 'tap' ? (
          <KeyLights pressed={pressed} labels={bindings} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Tip: go fullscreen and match your mouse sensitivity to feel natural.
          </p>
        )}
        <div className="flex gap-2">
          {needsUnmute && (
            <Button
              variant="secondary"
              onClick={() => {
                audioRef.current
                  ?.play()
                  .then(() => setNeedsUnmute(false))
                  .catch(() => {})
              }}
            >
              <Volume2 aria-hidden="true" />
              Unmute
            </Button>
          )}
          <Button variant="outline" onClick={() => stageRef.current?.requestFullscreen()}>
            <Maximize aria-hidden="true" />
            Fullscreen
          </Button>
        </div>
      </div>
    </section>
  )
}
