'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataConnection, MediaConnection, Peer } from 'peerjs'
import {
  type GuestMessage,
  type HostMessage,
  type Role,
  type TapSlot,
  MAP_CHUNK_CHARS,
  ROOM_PREFIX,
  decodeInput,
  encodeClock,
  makeRoomCode,
  openInputChannel,
  tuneScreenSenders,
} from '@/lib/protocol'
import type { PartnerStats } from '@/lib/timing'

type SyncState = { live: boolean; mods: number }
type MapFile = { checksum: string; text: string }

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
  const [partner, setPartner] = useState<PartnerStats | null>(null)

  const syncRef = useRef<SyncState>({ live: false, mods: 0 })
  const mapRef = useRef<MapFile | null>(null)
  const clockSeq = useRef(0)
  const peerRef = useRef<Peer | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const callsRef = useRef<MediaConnection[]>([])
  const guestIdRef = useRef<string | null>(null)
  const ctrlRef = useRef<DataConnection | null>(null)
  const inputRef = useRef<RTCDataChannel | null>(null)
  const lastAimSeq = useRef(0)
  const lastKeySeq = useRef(0)
  const guestRoleRef = useRef(guestRole)
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  const closeLink = useCallback(() => {
    callsRef.current.forEach((call) => call.close())
    callsRef.current = []
    inputRef.current?.close()
    inputRef.current = null
    ctrlRef.current = null
    guestIdRef.current = null
    lastAimSeq.current = 0
    lastKeySeq.current = 0
  }, [])

  const dropGuest = useCallback(() => {
    handlersRef.current.onRelease()
    closeLink()
    setRtt(null)
    setPartner(null)
    if (peerRef.current && !peerRef.current.destroyed) setStatus('waiting')
  }, [closeLink])

  // Key events come in twice (fast lossy + reliable). Applying strictly in sequence means the
  // first copy wins and a lost fast copy is filled in by the reliable one.
  const applyKey = useCallback((n: number, slot: TapSlot, down: boolean) => {
    if (guestRoleRef.current !== 'tap' || n !== lastKeySeq.current + 1) return
    lastKeySeq.current = n
    handlersRef.current.onKey(slot, down)
  }, [])

  const handleInput = useCallback(
    (event: MessageEvent) => {
      const packet = decodeInput(event.data)
      if (!packet) return
      if (packet.t === 'aim') {
        if (guestRoleRef.current !== 'aim' || packet.s <= lastAimSeq.current) return
        lastAimSeq.current = packet.s
        handlersRef.current.onAim(packet.x, packet.y)
      } else if (packet.t === 'key') {
        applyKey(packet.n, packet.k, packet.down)
      }
    },
    [applyKey],
  )

  const handleMessage = useCallback((raw: unknown) => {
    const msg = raw as GuestMessage
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'key':
        if ((msg.k !== 'k1' && msg.k !== 'k2') || typeof msg.n !== 'number') return
        applyKey(msg.n, msg.k, Boolean(msg.down))
        break
      case 'release':
        handlersRef.current.onRelease()
        break
      case 'ping':
        ctrlRef.current?.send({ t: 'pong', ts: msg.ts } satisfies HostMessage)
        if (typeof msg.rtt === 'number') {
          setRtt(msg.rtt)
          setPartner({
            rtt: msg.rtt,
            video: typeof msg.video === 'number' ? msg.video : null,
            mode: msg.mode === 'playfield' ? 'playfield' : 'video',
          })
        }
        break
    }
  }, [applyKey])

  const stop = useCallback(() => {
    handlersRef.current.onRelease()
    closeLink()
    peerRef.current?.destroy()
    peerRef.current = null
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
          const input = openInputChannel(conn.peerConnection)
          if (input) input.onmessage = handleInput
          inputRef.current = input
          conn.send({ t: 'welcome', guestRole: guestRoleRef.current } satisfies HostMessage)
          conn.send({ t: 'sync', ...syncRef.current } satisfies HostMessage)
          sendMap(conn)
          const current = streamRef.current
          if (!current) return
          // Separate calls keep audio and video in different sync groups, so the video isn't
          // delayed to line up with the audio jitter buffer.
          const groups = [current.getVideoTracks(), current.getAudioTracks()].filter((g) => g.length > 0)
          callsRef.current = groups.map((tracks) => {
            const call = peer.call(conn.peer, new MediaStream(tracks))
            const pc = call.peerConnection
            pc?.addEventListener('connectionstatechange', () => {
              if (pc.connectionState === 'connected') void tuneScreenSenders(pc)
            })
            return call
          })
          setStatus('connected')
        })
        conn.on('close', dropGuest)
        conn.on('error', dropGuest)
      }
    })
  }, [dropGuest, handleInput, handleMessage, stop])

  useEffect(() => {
    guestRoleRef.current = guestRole
    ctrlRef.current?.send({ t: 'welcome', guestRole } satisfies HostMessage)
    handlersRef.current.onRelease()
  }, [guestRole])

  useEffect(() => stop, [stop])

  const publishSync = useCallback((next: SyncState) => {
    const prev = syncRef.current
    if (prev.live === next.live && prev.mods === next.mods) return
    syncRef.current = next
    if (ctrlRef.current?.open) ctrlRef.current.send({ t: 'sync', ...next } satisfies HostMessage)
  }, [])

  const publishMap = useCallback((checksum: string, text: string) => {
    mapRef.current = { checksum, text }
    if (ctrlRef.current?.open) sendMap(ctrlRef.current)
  }, [])

  const publishClock = useCallback((time: number, rate: number, playing: boolean) => {
    const input = inputRef.current
    if (input?.readyState !== 'open' || input.bufferedAmount > 1024) return
    input.send(encodeClock(++clockSeq.current, time, rate, playing))
  }, [])

  function sendMap(conn: DataConnection) {
    const map = mapRef.current
    if (!map) return
    const n = Math.max(1, Math.ceil(map.text.length / MAP_CHUNK_CHARS))
    for (let i = 0; i < n; i++) {
      const d = map.text.slice(i * MAP_CHUNK_CHARS, (i + 1) * MAP_CHUNK_CHARS)
      conn.send({ t: 'map', id: map.checksum, i, n, d } satisfies HostMessage)
    }
  }

  return {
    status,
    error,
    roomCode,
    stream,
    hasAudio,
    surface,
    rtt,
    partner,
    start,
    stop,
    publishSync,
    publishMap,
    publishClock,
  }
}
