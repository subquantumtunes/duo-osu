'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataConnection, Peer } from 'peerjs'
import {
  type GuestMessage,
  type HostMessage,
  type Role,
  type TapSlot,
  ROOM_PREFIX,
  encodeAim,
  encodeKey,
  minimizePlayoutDelay,
  openInputChannel,
} from '@/lib/protocol'

export type GuestStatus = 'idle' | 'connecting' | 'connected' | 'ended' | 'error'

// Past this much queued data the link is congested; newer cursor packets supersede older ones.
const MAX_AIM_BUFFER = 256

export function useGuestSession(code: string) {
  const [status, setStatus] = useState<GuestStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [role, setRole] = useState<Role | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [rtt, setRtt] = useState<number | null>(null)

  const peerRef = useRef<Peer | null>(null)
  const ctrlRef = useRef<DataConnection | null>(null)
  const inputRef = useRef<RTCDataChannel | null>(null)
  const tracksRef = useRef<MediaStreamTrack[]>([])
  const aimSeq = useRef(0)
  const keySeq = useRef(0)
  const rttRef = useRef<number | undefined>(undefined)

  const resetLink = () => {
    inputRef.current?.close()
    inputRef.current = null
    ctrlRef.current = null
    tracksRef.current = []
    keySeq.current = 0
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
        inputRef.current = openInputChannel(ctrl.peerConnection)
      })
      ctrl.on('data', (raw) => {
        const msg = raw as HostMessage
        if (msg.t === 'welcome') {
          setRole(msg.guestRole)
          setStatus('connected')
        } else if (msg.t === 'pong') {
          const value = Math.round(performance.now() - msg.ts)
          rttRef.current = value
          setRtt(value)
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
    const id = setInterval(() => {
      ctrlRef.current?.send({ t: 'ping', ts: performance.now(), rtt: rttRef.current } satisfies GuestMessage)
    }, 1000)
    return () => clearInterval(id)
  }, [status])

  useEffect(() => () => peerRef.current?.destroy(), [])

  const sendAim = useCallback((x: number, y: number) => {
    const input = inputRef.current
    if (input?.readyState !== 'open' || input.bufferedAmount > MAX_AIM_BUFFER) return
    input.send(encodeAim(++aimSeq.current, x, y))
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

  return { status, error, role, stream, rtt, join, leave, sendAim, sendKey }
}
