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
  encodeProbe,
  minimizePlayoutDelay,
  openInputChannel,
  type VideoIssue,
} from '@/lib/protocol'
import { ICE_SERVERS } from '@/lib/browser'
import { type Beatmap, parseBeatmap } from '@/lib/beatmap'
import { type Skin, closeSkin, loadSkin } from '@/lib/skin'
import { SyncClock } from '@/lib/sync-clock'
import { type PartnerMode, SOURCE_LAG_MS } from '@/lib/timing'

// One frame of capture plus encode on the host before a frame is even sent.
const CAPTURE_ENCODE_MS = 17

type VideoStatsSample = { jitter: number; emitted: number; decode: number; frames: number }

async function readVideoStats(pc: RTCPeerConnection | null, prev: VideoStatsSample | null) {
  if (!pc) return null
  const report = await pc.getStats()
  let current: VideoStatsSample | null = null
  let bytes = 0
  report.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      bytes = s.bytesReceived ?? 0
      current = {
        jitter: s.jitterBufferDelay ?? 0,
        emitted: s.jitterBufferEmittedCount ?? 0,
        decode: s.totalDecodeTime ?? 0,
        frames: s.framesDecoded ?? 0,
      }
    }
  })
  if (!current) return { sample: null, receiveMs: null, frames: 0, bytes: 0 }
  const now: VideoStatsSample = current
  const base = prev ?? { jitter: 0, emitted: 0, decode: 0, frames: 0 }
  const emitted = now.emitted - base.emitted
  const frames = now.frames - base.frames
  const bufferMs = emitted > 0 ? ((now.jitter - base.jitter) / emitted) * 1000 : 0
  const decodeMs = frames > 0 ? ((now.decode - base.decode) / frames) * 1000 : 0
  return { sample: now, receiveMs: frames > 0 ? bufferMs + decodeMs : null, frames: now.frames, bytes }
}

// How long a fresh video call gets to show its first frame before it's treated as stuck.
const FIRST_FRAME_MS = 6000
const AUTO_RETRIES = 2

function diagnose(
  pc: RTCPeerConnection | null,
  frames: number,
  bytes: number,
  host: { frames: number; live: boolean } | null,
  waitedMs: number,
): VideoIssue | null {
  if (frames > 0 && pc?.connectionState !== 'failed') return null
  if (pc?.connectionState === 'failed') return 'network'
  if (waitedMs < FIRST_FRAME_MS) return 'connecting'
  if (!pc || pc.connectionState !== 'connected') return 'network'
  if (host && (!host.live || host.frames === 0)) return 'host-capture'
  return bytes > 0 ? 'decode' : 'network'
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
  const [skin, setSkin] = useState<Skin | null>(null)
  const skinChunksRef = useRef<{ id: string; parts: string[]; got: number } | null>(null)
  const skinLoadRef = useRef(0)
  const [videoLatency, setVideoLatency] = useState<number | null>(null)
  const [videoIssue, setVideoIssue] = useState<VideoIssue | null>('connecting')
  const videoIssueRef = useRef<VideoIssue | null>('connecting')
  const videoSinceRef = useRef(0)
  const retriesRef = useRef(0)
  const hostVideoRef = useRef<{ frames: number; live: boolean } | null>(null)

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
  const inputOk = useRef(false)
  const probeTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const keySeq = useRef(0)
  const rttRef = useRef<number | undefined>(undefined)

  const resetLink = () => {
    if (probeTimer.current) clearInterval(probeTimer.current)
    probeTimer.current = null
    inputOk.current = false
    inputRef.current?.close()
    inputRef.current = null
    ctrlRef.current = null
    tracksRef.current = []
    keySeq.current = 0
    clockRef.current = new SyncClock()
    chunksRef.current = null
    videoPcRef.current = null
    videoStatsRef.current = null
    hostVideoRef.current = null
    retriesRef.current = 0
    videoIssueRef.current = 'connecting'
    setVideoIssue('connecting')
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

  const receiveSkinChunk = (msg: Extract<HostMessage, { t: 'skin' }>) => {
    let pending = skinChunksRef.current
    if (!pending || pending.id !== msg.id || msg.i === 0) {
      pending = { id: msg.id, parts: new Array(msg.n).fill(''), got: 0 }
      skinChunksRef.current = pending
    }
    if (msg.i < 0 || msg.i >= pending.parts.length) return
    pending.parts[msg.i] = msg.d
    pending.got++
    if (pending.got < pending.parts.length) return
    skinChunksRef.current = null
    const load = ++skinLoadRef.current
    void loadSkin(pending.parts.join('')).then((next) => {
      if (load !== skinLoadRef.current) return closeSkin(next)
      setSkin((prev) => {
        closeSkin(prev)
        return next
      })
    })
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
    const peer = new Peer({ debug: 1, config: { iceServers: ICE_SERVERS } })
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
        if (input) {
          if (probeTimer.current) clearInterval(probeTimer.current)
          probeTimer.current = setInterval(() => {
            if (inputOk.current || input.readyState === 'closed') {
              if (probeTimer.current) clearInterval(probeTimer.current)
              probeTimer.current = null
            } else if (input.readyState === 'open') {
              input.send(encodeProbe())
            }
          }, 250)
        }
      })
      ctrl.on('data', (raw) => {
        const msg = raw as HostMessage
        if (msg.t === 'welcome') {
          if (!videoSinceRef.current) videoSinceRef.current = performance.now()
          setRole(msg.guestRole)
          setStatus('connected')
        } else if (msg.t === 'host-video') {
          hostVideoRef.current = { frames: msg.frames, live: msg.live }
        } else if (msg.t === 'pong') {
          const value = Math.round(performance.now() - msg.ts)
          rttRef.current = value
          transitRef.current = value / 2
          setRtt(value)
        } else if (msg.t === 'input-ok') {
          inputOk.current = true
        } else if (msg.t === 'sync') {
          setSync({ live: msg.live, mods: msg.mods })
        } else if (msg.t === 'map') {
          receiveMapChunk(msg)
        } else if (msg.t === 'skin') {
          receiveSkinChunk(msg)
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
      call.on('close', () => {
        if (videoPcRef.current === call.peerConnection) videoPcRef.current = null
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
      const pc = videoPcRef.current
      let frames = 0
      let bytes = 0
      try {
        const stats = await readVideoStats(pc, videoStatsRef.current)
        if (stats) {
          frames = stats.frames
          bytes = stats.bytes
          videoStatsRef.current = stats.sample
          const rtt = rttRef.current
          if (rtt !== undefined && stats.receiveMs !== null) {
            const latency = Math.round(rtt / 2 + stats.receiveMs + CAPTURE_ENCODE_MS)
            videoLatencyRef.current = latency
            setVideoLatency(latency)
          }
        }
      } catch {}

      const now = performance.now()
      const issue = diagnose(pc, frames, bytes, hostVideoRef.current, now - videoSinceRef.current)
      if (issue === null) retriesRef.current = 0
      else if (issue !== 'connecting' && retriesRef.current < AUTO_RETRIES && ctrlRef.current?.open) {
        retriesRef.current++
        videoSinceRef.current = now
        ctrlRef.current.send({ t: 'video-retry' } satisfies GuestMessage)
      }
      if (issue !== videoIssueRef.current) {
        videoIssueRef.current = issue
        setVideoIssue(issue)
      }

      ctrlRef.current?.send({
        t: 'ping',
        ts: now,
        rtt: rttRef.current,
        video: videoLatencyRef.current,
        mode: modeRef.current,
        vs: issue ?? 'ok',
      } satisfies GuestMessage)
    }
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [status])

  const setMode = useCallback((mode: PartnerMode) => {
    modeRef.current = mode
  }, [])

  const retryVideo = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl?.open) return
    retriesRef.current = 0
    videoSinceRef.current = performance.now()
    videoIssueRef.current = 'connecting'
    setVideoIssue('connecting')
    ctrl.send({ t: 'video-retry' } satisfies GuestMessage)
  }, [])

  useEffect(() => () => peerRef.current?.destroy(), [])

  const sendAim = useCallback((x: number, y: number) => {
    const input = inputRef.current
    if (inputOk.current && input?.readyState === 'open') {
      if (input.bufferedAmount <= MAX_AIM_BUFFER) input.send(encodeAim(++aimSeq.current, x, y))
      return
    }
    // Until the host confirms the fast channel delivers, use the reliable one at a rate it can keep up with.
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
    skin,
    videoLatency,
    videoIssue,
    retryVideo,
    clockRef,
    transitRef,
    setMode,
    join,
    leave,
    sendAim,
    sendKey,
  }
}
