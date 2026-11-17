'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataConnection, Peer } from 'peerjs'
import {
  type GuestMessage,
  type HostMessage,
  type Role,
  type TapSlot,
  ROOM_PREFIX,
  decodeInput,
  encodeAim,
  encodeKey,
  minimizePlayoutDelay,
  openInputChannel,
} from '@/lib/protocol'
import { type Beatmap, parseBeatmap } from '@/lib/beatmap'
import { SyncClock } from '@/lib/sync-clock'
import { type PartnerMode, SOURCE_LAG_MS } from '@/lib/timing'

// One frame of capture plus encode on the host before a frame is even sent.
const CAPTURE_ENCODE_MS = 17

type VideoStatsSample = { jitter: number; emitted: number; decode: number; frames: number }

async function readVideoStats(pc: RTCPeerConnection | null, prev: VideoStatsSample | null) {
  if (!pc) return null
  const report = await pc.getStats()
  let current: VideoStatsSample | null = null
  report.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      current = {
        jitter: s.jitterBufferDelay ?? 0,
        emitted: s.jitterBufferEmittedCount ?? 0,
        decode: s.totalDecodeTime ?? 0,
        frames: s.framesDecoded ?? 0,
      }
    }
  })
  if (!current) return null
  const now: VideoStatsSample = current
  const base = prev ?? { jitter: 0, emitted: 0, decode: 0, frames: 0 }
  const emitted = now.emitted - base.emitted
  const frames = now.frames - base.frames
  const bufferMs = emitted > 0 ? ((now.jitter - base.jitter) / emitted) * 1000 : 0
  const decodeMs = frames > 0 ? ((now.decode - base.decode) / frames) * 1000 : 0
  return { sample: now, receiveMs: bufferMs + decodeMs }
}

export type GuestStatus = 'idle' | 'connecting' | 'connected' | 'ended' | 'error'

// Past this much queued data the link is congested; newer cursor packets supersede older ones.
const MAX_AIM_BUFFER = 256
const FALLBACK_AIM_MS = 8

export function useGuestSession(code: string) {
  const [status, setStatus] = useState<GuestStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [role, setRole] = useState<Role | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [rtt, setRtt] = useState<number | null>(null)
  const [sync, setSync] = useState<{ live: boolean; mods: number } | null>(null)
  const [map, setMap] = useState<Beatmap | null>(null)
  const [mapLoading, setMapLoading] = useState(false)
  const [videoLatency, setVideoLatency] = useState<number | null>(null)

  const clockRef = useRef(new SyncClock())
  const transitRef = useRef(0)
  const modeRef = useRef<PartnerMode>('video')
  const videoLatencyRef = useRef<number | null>(null)
  const videoPcRef = useRef<RTCPeerConnection | null>(null)
  const videoStatsRef = useRef<VideoStatsSample | null>(null)
  const chunksRef = useRef<{ id: string; parts: string[]; got: number } | null>(null)
  const peerRef = useRef<Peer | null>(null)
  const ctrlRef = useRef<DataConnection | null>(null)
  const inputRef = useRef<RTCDataChannel | null>(null)
  const tracksRef = useRef<MediaStreamTrack[]>([])
  const aimSeq = useRef(0)
  const lastFallbackAim = useRef(0)
  const keySeq = useRef(0)
  const rttRef = useRef<number | undefined>(undefined)

  const resetLink = () => {
    inputRef.current?.close()
    inputRef.current = null
    ctrlRef.current = null
    tracksRef.current = []
    keySeq.current = 0
    clockRef.current = new SyncClock()
    chunksRef.current = null
    videoPcRef.current = null
    videoStatsRef.current = null
  }

  const receiveMapChunk = (msg: Extract<HostMessage, { t: 'map' }>) => {
    let pending = chunksRef.current
    if (!pending || pending.id !== msg.id || msg.i === 0) {
      pending = { id: msg.id, parts: new Array(msg.n).fill(''), got: 0 }
      chunksRef.current = pending
      setMapLoading(true)
    }
    if (msg.i < 0 || msg.i >= pending.parts.length) return
    pending.parts[msg.i] = msg.d
    pending.got++
    if (pending.got < pending.parts.length) return
    chunksRef.current = null
    setMap(parseBeatmap(pending.parts.join(''), pending.id))
    setMapLoading(false)
  }

  const leave = useCallback(() => {
    if (ctrlRef.current?.open) ctrlRef.current.send({ t: 'release' } satisfies GuestMessage)
    peerRef.current?.destroy()
    peerRef.current = null
    resetLink()
    setStream(null)
    setRole(null)
    setStatus('ended')
  }, [])

  const join = useCallback(async () => {
    setError(null)
    setStatus('connecting')
    const { Peer } = await import('peerjs')
    const peer = new Peer({ debug: 1 })
    peerRef.current = peer
    const hostId = ROOM_PREFIX + code

    peer.on('open', () => {
      const ctrl = peer.connect(hostId, { label: 'ctrl', reliable: true, serialization: 'json' })
      ctrlRef.current = ctrl
      ctrl.on('open', () => {
        const input = openInputChannel(ctrl.peerConnection)
        if (input) {
          input.onmessage = (event) => {
            const packet = decodeInput(event.data)
            if (packet?.t !== 'clock') return
            clockRef.current.sample(
              packet.s,
              packet.time,
              packet.rate,
              packet.playing,
              transitRef.current + SOURCE_LAG_MS,
              performance.now(),
            )
          }
        }
        inputRef.current = input
      })
      ctrl.on('data', (raw) => {
        const msg = raw as HostMessage
        if (msg.t === 'welcome') {
          setRole(msg.guestRole)
          setStatus('connected')
        } else if (msg.t === 'pong') {
          const value = Math.round(performance.now() - msg.ts)
          rttRef.current = value
          transitRef.current = value / 2
          setRtt(value)
        } else if (msg.t === 'sync') {
          setSync({ live: msg.live, mods: msg.mods })
        } else if (msg.t === 'map') {
          receiveMapChunk(msg)
        } else if (msg.t === 'full') {
          setError('This room already has a partner.')
          setStatus('error')
          peer.destroy()
        }
      })
      ctrl.on('close', () => {
        if (peerRef.current === peer) {
          resetLink()
          setStatus('ended')
          setStream(null)
        }
      })
    })

    // Video and audio arrive as separate calls so the video isn't held back to stay in sync with audio.
    peer.on('call', (call) => {
      call.answer()
      call.on('stream', (remote) => {
        minimizePlayoutDelay(call.peerConnection)
        if (remote.getVideoTracks().length > 0) {
          videoPcRef.current = call.peerConnection
          videoStatsRef.current = null
        }
        const incoming = remote.getTracks()
        const kept = tracksRef.current.filter(
          (t) => t.readyState === 'live' && !incoming.some((n) => n.kind === t.kind),
        )
        tracksRef.current = [...kept, ...incoming]
        setStream(new MediaStream(tracksRef.current))
      })
    })

    peer.on('error', (err) => {
      setError(
        err.type === 'peer-unavailable'
          ? 'Room not found. Check the code, or ask the host to start sharing.'
          : `Connection error: ${err.type}`,
      )
      setStatus('error')
    })
  }, [code])

  useEffect(() => {
    if (status !== 'connected') return
    const tick = async () => {
      try {
        const stats = await readVideoStats(videoPcRef.current, videoStatsRef.current)
        if (stats) {
          videoStatsRef.current = stats.sample
          const rtt = rttRef.current
          if (rtt !== undefined) {
            const latency = Math.round(rtt / 2 + stats.receiveMs + CAPTURE_ENCODE_MS)
            videoLatencyRef.current = latency
            setVideoLatency(latency)
          }
        }
      } catch {}
      ctrlRef.current?.send({
        t: 'ping',
        ts: performance.now(),
        rtt: rttRef.current,
        video: videoLatencyRef.current,
        mode: modeRef.current,
      } satisfies GuestMessage)
    }
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [status])

  const setMode = useCallback((mode: PartnerMode) => {
    modeRef.current = mode
  }, [])

  useEffect(() => () => peerRef.current?.destroy(), [])

  const sendAim = useCallback((x: number, y: number) => {
    const input = inputRef.current
    if (input?.readyState === 'open') {
      if (input.bufferedAmount <= MAX_AIM_BUFFER) input.send(encodeAim(++aimSeq.current, x, y))
      return
    }
    // Without the fast channel, fall back to the reliable one at a rate it can keep up with.
    const ctrl = ctrlRef.current
    const now = performance.now()
    if (!ctrl?.open || now - lastFallbackAim.current < FALLBACK_AIM_MS) return
    lastFallbackAim.current = now
    ctrl.send({ t: 'aim', s: ++aimSeq.current, x, y } satisfies GuestMessage)
  }, [])

  // Each key event goes out on the fast lossy channel and the reliable one; the host applies
  // whichever copy arrives first, in sequence, so taps are never dropped.
  const sendKey = useCallback((k: TapSlot, down: boolean) => {
    const ctrl = ctrlRef.current
    if (!ctrl?.open) return
    const n = ++keySeq.current
    const input = inputRef.current
    if (input?.readyState === 'open') input.send(encodeKey(n, k, down))
    ctrl.send({ t: 'key', k, down, n } satisfies GuestMessage)
  }, [])

  return {
    status,
    error,
    role,
    stream,
    rtt,
    sync,
    map,
    mapLoading,
    videoLatency,
    clockRef,
    transitRef,
    setMode,
    join,
    leave,
    sendAim,
    sendKey,
  }
}
