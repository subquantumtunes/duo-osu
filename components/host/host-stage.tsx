'use client'

import { type RefObject, useEffect, useRef } from 'react'
import { MonitorUp } from 'lucide-react'
import { KeyLights } from '@/components/key-lights'
import { ROLE_LABEL, type Role } from '@/lib/protocol'
import type { PartnerStats } from '@/lib/timing'

const PARTNER_VIDEO_TEXT: Partial<Record<PartnerStats['videoState'], string>> = {
  network:
    'Your partner sees a black screen: the video can’t get through. Turn off VPNs (including Opera’s built-in VPN) on both PCs. In Opera, set Settings → WebRTC to “Default public and private interfaces”.',
  'host-capture':
    'Your partner sees a black screen because this capture is blank. Set osu! to Borderless, keep it on the shared monitor and not minimized, then stop and restart sharing if needed.',
  decode:
    'Your partner’s browser receives the video but can’t display it. They should turn on hardware acceleration and restart their browser.',
}

export function HostStage({
  stream,
  aimRef,
  showAim,
  keys,
  bindings,
  guestRole,
  partnerVideo,
}: {
  partnerVideo: PartnerStats['videoState'] | null
  stream: MediaStream | null
  aimRef: RefObject<{ x: number; y: number } | null>
  showAim: boolean
  keys: { k1: boolean; k2: boolean }
  bindings: { k1: string; k2: string }
  guestRole: Role
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const dotRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream
  }, [stream])

  useEffect(() => {
    if (!showAim) return
    let raf = 0
    const draw = () => {
      const dot = dotRef.current
      const aim = aimRef.current
      if (dot) {
        dot.style.opacity = aim ? '1' : '0'
        if (aim) {
          dot.style.left = `${aim.x * 100}%`
          dot.style.top = `${aim.y * 100}%`
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [showAim, aimRef])

  return (
    <section
      className="relative flex min-h-72 flex-col overflow-hidden rounded-2xl border border-border bg-card"
      aria-label="Your shared screen"
    >
      {stream ? (
        <div className="relative flex flex-1 items-center justify-center bg-black">
          <div className="relative w-full">
            <video ref={videoRef} autoPlay playsInline muted className="block w-full" />
            {showAim && (
              <div
                ref={dotRef}
                aria-hidden="true"
                className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-accent/30 opacity-0"
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <MonitorUp className="size-10 text-muted-foreground" aria-hidden="true" />
          <p className="max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground">
            Your shared screen shows up here. Share the <span className="text-foreground">entire monitor</span> osu! runs
            on so your partner’s cursor maps to the right spot.
          </p>
        </div>
      )}
      {partnerVideo && PARTNER_VIDEO_TEXT[partnerVideo] && (
        <p role="alert" className="border-t border-destructive/40 bg-destructive/10 px-4 py-3 text-xs leading-relaxed">
          {PARTNER_VIDEO_TEXT[partnerVideo]}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Partner input: <span className="font-medium text-foreground">{ROLE_LABEL[guestRole]}</span>
        </p>
        {guestRole === 'tap' ? (
          <KeyLights pressed={keys} labels={bindings} />
        ) : (
          <span className="text-xs text-muted-foreground">Cyan ring = partner cursor</span>
        )}
      </div>
    </section>
  )
}
