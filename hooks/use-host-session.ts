'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataConnection, MediaConnection, Peer } from 'peerjs'
import {
  type GuestMessage,
  type HostMessage,
  type Role,
  type TapSlot,
  ROOM_PREFIX,
  makeRoomCode,
  tuneScreenSenders,
} from '@/lib/protocol'

export type HostStatus = 'idle' | 'starting' | 'waiting' | 'connected' | 'error'

type Handlers = {
  onAim: (x: number, y: number) => void
  onKey: (slot: TapSlot, down: boolean) => void
  onRelease: () => void
}

export function useHostSession(guestRole: Role, handlers: Handlers) {
  const [status, setStatus] = useState<HostStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [hasAudio, setHasAudio] = useState(false)
  const [surface, setSurface] = useState<string | null>(null)
  const [rtt, setRtt] = useState<number | null>(null)

  const peerRef = useRef<Peer | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const callRef = useRef<MediaConnection | null>(null)
  const guestIdRef = useRef<string | null>(null)
  const ctrlRef = useRef<DataConnection | null>(null)
  const lastAimSeq = useRef(-1)
  const guestRoleRef = useRef(guestRole)
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  const dropGuest = useCallback(() => {
    handlersRef.current.onRelease()
    callRef.current?.close()
    callRef.current = null
    ctrlRef.current = null
    guestIdRef.current = null
    lastAimSeq.current = -1
    setRtt(null)
    if (peerRef.current && !peerRef.current.destroyed) setStatus('waiting')
  }, [])

  const handleMessage = useCallback((raw: unknown) => {
    const msg = raw as GuestMessage
    if (!msg || typeof msg !== 'object') return
    const role = guestRoleRef.current
    switch (msg.t) {
      case 'aim':
        if (role !== 'aim' || msg.s <= lastAimSeq.current) return
        lastAimSeq.current = msg.s
        handlersRef.current.onAim(msg.x, msg.y)
        break
      case 'key':
        if (role !== 'tap' || (msg.k !== 'k1' && msg.k !== 'k2')) return
        handlersRef.current.onKey(msg.k, Boolean(msg.down))
        break
      case 'release':
        handlersRef.current.onRelease()
        break
      case 'ping':
        ctrlRef.current?.send({ t: 'pong', ts: msg.ts } satisfies HostMessage)
        if (typeof msg.rtt === 'number') setRtt(msg.rtt)
        break
    }
  }, [])

  const stop = useCallback(() => {
    handlersRef.current.onRelease()
    callRef.current?.close()
    peerRef.current?.destroy()
    peerRef.current = null
    callRef.current = null
    ctrlRef.current = null
    guestIdRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setStream(null)
    setRoomCode(null)
    setRtt(null)
    setStatus('idle')
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setStatus('starting')
    let media: MediaStream
    try {
      media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 }, displaySurface: 'monitor' },
        audio: true,
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions)
    } catch {
      setStatus('idle')
      setError('Screen sharing was cancelled or blocked.')
      return
    }

    const video = media.getVideoTracks()[0]
    if (video) {
      video.contentHint = 'motion'
      video.addEventListener('ended', stop)
      setSurface((video.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface ?? null)
    }
    setHasAudio(media.getAudioTracks().length > 0)
    streamRef.current = media
    setStream(media)

    const code = makeRoomCode()
    const { Peer } = await import('peerjs')
    const peer = new Peer(ROOM_PREFIX + code, { debug: 1 })
    peerRef.current = peer

    peer.on('open', () => {
      setRoomCode(code)
      setStatus('waiting')
    })

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') return
      setError(`Connection error: ${err.type}`)
      setStatus('error')
    })

    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect()
    })

    peer.on('connection', (conn) => {
      if (guestIdRef.current && guestIdRef.current !== conn.peer) {
        conn.on('open', () => {
          conn.send({ t: 'full' } satisfies HostMessage)
          setTimeout(() => conn.close(), 500)
        })
        return
      }
      guestIdRef.current = conn.peer
      conn.on('data', handleMessage)

      if (conn.label === 'ctrl') {
        ctrlRef.current = conn
        conn.on('open', () => {
          conn.send({ t: 'welcome', guestRole: guestRoleRef.current } satisfies HostMessage)
          const current = streamRef.current
          if (!current) return
          const call = peer.call(conn.peer, current)
          callRef.current = call
          const pc = call.peerConnection
          pc?.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'connected') void tuneScreenSenders(pc)
          })
          setStatus('connected')
        })
        conn.on('close', dropGuest)
        conn.on('error', dropGuest)
      }
    })
  }, [dropGuest, handleMessage, stop])

  useEffect(() => {
    guestRoleRef.current = guestRole
    ctrlRef.current?.send({ t: 'welcome', guestRole } satisfies HostMessage)
    handlersRef.current.onRelease()
  }, [guestRole])

  useEffect(() => stop, [stop])

  return { status, error, roomCode, stream, hasAudio, surface, rtt, start, stop }
}
