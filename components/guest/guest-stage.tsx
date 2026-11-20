'use client'

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { Beatmap } from '@/lib/beatmap'
import type { Skin } from '@/lib/skin'
import type { SyncClock } from '@/lib/sync-clock'
import type { CursorSettings } from '@/lib/cursor-settings'
import { Playfield } from './playfield'
import { type LaneInput, LanePlayfield } from './lane-playfield'
import { RULESET_MANIA, RULESET_TAIKO, laneName } from '@/lib/lanes'
import { Eye, EyeOff, Maximize, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { KeyLights } from '@/components/key-lights'
import { type Role, type TapSlot, type VideoIssue, formatKey, laneSlot } from '@/lib/protocol'
import { cn } from '@/lib/utils'
import type { LaneSettings, ManiaBlackout } from '@/lib/lane-settings'
import type { StandardSettings } from '@/lib/standard-settings'
import type { JudgementEvent } from '@/lib/judgements'
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

const BLACKOUT_KEY = 'duosu:blackout'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export type PlayfieldProps = {
  map: Beatmap
  mods: number
  clockRef: RefObject<SyncClock>
  leadMsRef: RefObject<number>
  skin: Skin | null
  judgementsRef?: RefObject<JudgementEvent[]>
  /** Set for taiko and mania, which draw drums or columns instead of the standard playfield. */
  laneRuleset?: number
}

/** The taiko drums or mania columns the partner plays, each with the key they press for it. */
export type LaneControls = { ruleset: number; lanes: number[]; keys: string[] }

export function GuestStage({
  stream,
  role,
  bindings,
  sendAim,
  sendKey,
  playfield,
  videoIssue,
  onRetryVideo,
  cursorStyle,
  inputLive,
  laneControls,
  laneSettings,
  standardSettings,
  showJudgements,
}: {
  showJudgements: boolean
  standardSettings: StandardSettings
  laneSettings: LaneSettings
  laneControls: LaneControls | null
  inputLive: boolean
  cursorStyle: CursorSettings
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
  const [pressed, setPressed] = useState<Partial<Record<TapSlot, boolean>>>({})
  const held = useRef(new Map<TapSlot, Set<Source>>())
  const lanePressedRef = useRef<boolean[]>([])
  const laneInputsRef = useRef<LaneInput[]>([])
  const cursorRef = useRef<{ x: number; y: number } | null>(null)
  const cursorStyleRef = useRef<CursorSettings>(cursorStyle)
  cursorStyleRef.current = cursorStyle
  const [blackout, setBlackout] = useState(false)
  const blackoutRef = useRef(false)
  // The setting is remembered, but only applied while a map is live so song select stays visible.
  blackoutRef.current = blackout && inputLive
  const blackoutOpacityRef = useRef(standardSettings.blackoutOpacity)
  blackoutOpacityRef.current = standardSettings.blackoutOpacity
  const autopilotRef = useRef(false)
  autopilotRef.current = role === 'tap' && standardSettings.autopilot && inputLive
  const judgementsOnRef = useRef(showJudgements)
  judgementsOnRef.current = showJudgements
  const laneSettingsRef = useRef(laneSettings)
  laneSettingsRef.current = laneSettings
  const maniaBlackoutRef = useRef<ManiaBlackout>('off')
  // Same rule as the standard blackout: only while a map is live.
  maniaBlackoutRef.current = inputLive ? laneSettings.maniaBlackout : 'off'
  const maniaStage = playfield?.laneRuleset === RULESET_MANIA

  useEffect(() => {
    setBlackout(localStorage.getItem(BLACKOUT_KEY) === '1')
  }, [])

  const toggleBlackout = () => {
    setBlackout((on) => {
      localStorage.setItem(BLACKOUT_KEY, on ? '0' : '1')
      return !on
    })
  }

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
      let set = held.current.get(slot)
      if (!set) held.current.set(slot, (set = new Set()))
      const wasDown = set.size > 0
      if (down) set.add(source)
      else set.delete(source)
      const isDown = set.size > 0
      if (wasDown !== isDown) {
        sendKey(slot, isDown)
        const lane = /^l(\d)$/.exec(slot)
        if (lane) {
          lanePressedRef.current[Number(lane[1])] = isDown
          const inputs = laneInputsRef.current
          // The renderer drains this every frame; trim it if nothing is drawing.
          if (inputs.length > 64) inputs.splice(0, inputs.length - 64)
          inputs.push({ lane: Number(lane[1]), down: isDown, at: performance.now() })
        }
        setPressed((p) => ({ ...p, [slot]: isDown }))
      }
    },
    [sendKey],
  )

  const releaseAll = useCallback(() => {
    for (const [slot, set] of held.current) {
      if (set.size > 0) {
        set.clear()
        sendKey(slot, false)
        const lane = /^l(\d)$/.exec(slot)
        if (lane) laneInputsRef.current.push({ lane: Number(lane[1]), down: false, at: performance.now() })
      }
    }
    lanePressedRef.current = []
    setPressed({})
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

  const laneSignature = laneControls ? `${laneControls.ruleset}:${laneControls.lanes}:${laneControls.keys}` : ''

  useEffect(() => {
    if (role !== 'tap') return
    const laneKeys = laneControls?.keys ?? null
    const lanes = laneControls?.lanes ?? null
    const slotFor = (key: string): TapSlot | null => {
      const k = key === ' ' ? ' ' : key.toLowerCase()
      if (laneKeys && lanes) {
        const index = laneKeys.indexOf(k)
        return index >= 0 ? laneSlot(lanes[index]) : null
      }
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
  }, [role, bindings.k1, bindings.k2, laneSignature, press, releaseAll])

  // Taiko and mania are keyboard only; clicks would land on an arbitrary lane.
  const mouseSlot = (button: number): TapSlot | null =>
    laneControls ? null : button === 0 ? 'k1' : button === 2 ? 'k2' : null

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
          className={cn(
            'absolute inset-0 size-full object-contain transition-opacity',
            playfield && !(maniaStage && laneSettings.streamBackground) && 'opacity-10',
          )}
        />
        {playfield?.laneRuleset !== undefined && laneControls && (
          <LanePlayfield
            map={playfield.map}
            mods={playfield.mods}
            skin={playfield.skin}
            clockRef={playfield.clockRef}
            leadMsRef={playfield.leadMsRef}
            videoRef={videoRef}
            view={{
              ruleset: playfield.laneRuleset,
              lanes: laneControls.lanes,
              pressedRef: lanePressedRef,
              inputsRef: laneInputsRef,
              blackoutRef: maniaBlackoutRef,
              settingsRef: laneSettingsRef,
              judgementsRef: playfield.judgementsRef,
              judgementsOnRef,
            }}
          />
        )}
        {playfield && playfield.laneRuleset === undefined && (
          <Playfield
            {...playfield}
            videoRef={videoRef}
            cursorRef={role === 'aim' ? cursorRef : undefined}
            cursorStyleRef={cursorStyleRef}
            blackoutRef={blackoutRef}
            blackoutOpacityRef={blackoutOpacityRef}
            autopilotRef={autopilotRef}
            judgementsOnRef={judgementsOnRef}
          />
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
        {!inputLive && (
          <p
            role="status"
            className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background/85 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur"
          >
            Waiting for map, your inputs aren&apos;t being sent yet
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {role === 'tap' ? (
          laneControls ? (
            <LaneLights controls={laneControls} pressed={pressed} />
          ) : (
            <KeyLights pressed={{ k1: Boolean(pressed.k1), k2: Boolean(pressed.k2) }} labels={bindings} />
          )
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
          {playfield && playfield.laneRuleset === undefined && (
            <Button variant="outline" aria-pressed={blackout} onClick={toggleBlackout}>
              {blackout ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
              {blackout ? 'Show stream playfield' : 'Black out stream playfield'}
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

function LaneLights({ controls, pressed }: { controls: LaneControls; pressed: Partial<Record<TapSlot, boolean>> }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Your lanes">
      {controls.lanes.map((lane, i) => {
        const on = Boolean(pressed[laneSlot(lane)])
        const name = controls.ruleset === RULESET_TAIKO ? laneName(RULESET_TAIKO, lane) : `Col ${lane + 1}`
        return (
          <div
            key={lane}
            className={cn(
              'flex min-w-14 flex-col items-center rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors duration-75',
              on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background/70 text-muted-foreground',
            )}
          >
            <span className="font-semibold">{name}</span>
            <span className="text-[10px] opacity-80">{formatKey(controls.keys[i] ?? '')}</span>
            <span className="sr-only">{on ? 'pressed' : 'released'}</span>
          </div>
        )
      })}
    </div>
  )
}
