'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataConnection, MediaConnection, Peer } from 'peerjs'
import {
  type GuestMessage,
  type HostMessage,
  type Role,
  type TapSlot,
  chunkText,
  ROOM_PREFIX,
  PEER_TIMEOUT_MS,
  type PartnerExit,
  decodeInput,
  isTapSlot,
  encodeClock,
  makeRoomCode,
  openInputChannel,
  tuneScreenSenders,
} from '@/lib/protocol'
import type { PartnerStats } from '@/lib/timing'
import { ICE_SERVERS, SUPPORTED_BROWSERS, detectBrowser, isOpera } from '@/lib/browser'

const VIDEO_STATES = ['ok', 'connecting', 'network', 'host-capture', 'decode'] as const
const RETRY_COOLDOWN_MS = 3000

async function readEncodedFrames(pc: RTCPeerConnection | undefined) {
  if (!pc) return 0
  let frames = 0
  const report = await pc.getStats()
  report.forEach((s) => {
    if (s.type === 'outbound-rtp' && s.kind === 'video') frames += s.framesEncoded ?? 0
  })
  return frames
}

type SyncState = { live: boolean; mods: number }
type MapFile = { checksum: string; text: string }

export type HostStatus = 'idle' | 'starting' | 'waiting' | 'connected' | 'error'

type Handlers = {
  onAim: (x: number, y: number) => void
  onKey: (slot: TapSlot, down: boolean) => void
  onRelease: () => void
}

const SHARE_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as MediaTrackConstraints

const PREFERRED_SHARE = {
  video: { frameRate: { ideal: 60 } },
  audio: SHARE_AUDIO,
  systemAudio: 'include',
  selfBrowserSurface: 'exclude',
} as DisplayMediaStreamOptions

const PLAIN_SHARE: DisplayMediaStreamOptions = { video: true, audio: true }

function errorName(err: unknown) {
  return err instanceof Error ? err.name : ''
}

// Only TypeError and OverconstrainedError are raised before the picker opens,
// so they are the only failures worth retrying. Anything else happens after the
// user has already picked a screen, and retrying would reopen the picker and
// silently drop audio.
async function requestScreenShare(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new DOMException('getDisplayMedia unavailable', 'NotSupportedError')
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia(PREFERRED_SHARE)
  } catch (err) {
    const name = errorName(err)
    if (name !== 'TypeError' && name !== 'OverconstrainedError') throw err
    return navigator.mediaDevices.getDisplayMedia(PLAIN_SHARE)
  }
}

function describeShareError(err: unknown) {
  const name = errorName(err)
  const message = err instanceof Error ? err.message.toLowerCase() : ''
  const inFrame = typeof window !== 'undefined' && window.self !== window.top
  const opera = isOpera(detectBrowser())
  if (name === 'NotSupportedError' || !window.isSecureContext) {
    return `This browser can’t share your screen here. Use the latest ${SUPPORTED_BROWSERS} on a desktop, and open the site over https.`
  }
  if (name === 'NotAllowedError') {
    if (message.includes('system')) {
      return 'Your operating system blocked screen capture. Allow screen recording for your browser in system privacy settings, then restart the browser.'
    }
    if (opera && !inFrame && !message.includes('policy')) {
      return 'Screen sharing was cancelled or blocked. In Opera, click the site icon left of the address bar and set Screen sharing to Allow, then click Start sharing, pick your screen and click Share.'
    }
    if (inFrame || message.includes('policy')) {
      return 'Screen sharing is blocked inside this embedded view. Open the site in its own browser tab and try again.'
    }
    return 'Screen sharing was cancelled. Click Start sharing, choose your screen in the picker, then click Share.'
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The browser couldn’t start capturing that screen or its audio. Close other apps that are recording the screen or using your audio device exclusively, then click Start sharing once more.'
  }
  return `Screen sharing failed${name ? ` (${name})` : ''}. Try again in a fresh ${opera ? 'Opera' : 'Chrome or Edge'} tab.`
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
  const [partnerExit, setPartnerExit] = useState<PartnerExit | null>(null)
  const lastPingRef = useRef(0)
  const kickedRef = useRef(new Set<string>())

  const syncRef = useRef<SyncState>({ live: false, mods: 0 })
  const mapRef = useRef<MapFile | null>(null)
  const clockSeq = useRef(0)
  const peerRef = useRef<Peer | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const callsRef = useRef<MediaConnection[]>([])
  const videoCallRef = useRef<MediaConnection | null>(null)
  const lastRetry = useRef(0)
  const guestIdRef = useRef<string | null>(null)
  const ctrlRef = useRef<DataConnection | null>(null)
  const inputRef = useRef<RTCDataChannel | null>(null)
  const lastAimSeq = useRef(0)
  const lastKeySeq = useRef(0)
  const inputConfirmed = useRef(false)
  const guestRoleRef = useRef(guestRole)
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  // The video goes on its own call so it can be re-sent on request. A retry skips the encoder
  // tuning, in case a GPU encoder rejects the tuned parameters and sends nothing.
  const callVideo = useCallback((tuned: boolean) => {
    const peer = peerRef.current
    const guest = guestIdRef.current
    const tracks = streamRef.current?.getVideoTracks().filter((t) => t.readyState === 'live') ?? []
    if (!peer || peer.destroyed || !guest || tracks.length === 0) return
    videoCallRef.current?.close()
    const call = peer.call(guest, new MediaStream(tracks))
    videoCallRef.current = call
    const pc = call.peerConnection
    if (!tuned || !pc) return
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') void tuneScreenSenders(pc)
    })
  }, [])

  const closeLink = useCallback(() => {
    callsRef.current.forEach((call) => call.close())
    callsRef.current = []
    videoCallRef.current?.close()
    videoCallRef.current = null
    inputRef.current?.close()
    inputRef.current = null
    const ctrl = ctrlRef.current
    ctrlRef.current = null
    ctrl?.close()
    guestIdRef.current = null
    lastAimSeq.current = 0
    lastKeySeq.current = 0
    inputConfirmed.current = false
  }, [])

  const dropGuest = useCallback((exit: PartnerExit = 'left') => {
    if (!guestIdRef.current) return
    setPartnerExit(exit)
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

  const applyAim = useCallback((s: number, x: number, y: number) => {
    if (guestRoleRef.current !== 'aim' || s <= lastAimSeq.current) return
    lastAimSeq.current = s
    handlersRef.current.onAim(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)))
  }, [])

  const handleInput = useCallback(
    (event: MessageEvent) => {
      const packet = decodeInput(event.data)
      if (!packet) return
      if (!inputConfirmed.current && ctrlRef.current?.open) {
        inputConfirmed.current = true
        ctrlRef.current.send({ t: 'input-ok' } satisfies HostMessage)
      }
      if (packet.t === 'aim') applyAim(packet.s, packet.x, packet.y)
      else if (packet.t === 'key') applyKey(packet.n, packet.k, packet.down)
    },
    [applyAim, applyKey],
  )

  const handleMessage = useCallback((raw: unknown) => {
    const msg = raw as GuestMessage
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'key':
        if (!isTapSlot(msg.k) || typeof msg.n !== 'number') return
        applyKey(msg.n, msg.k, Boolean(msg.down))
        break
      case 'aim':
        if (typeof msg.s !== 'number' || typeof msg.x !== 'number' || typeof msg.y !== 'number') return
        applyAim(msg.s, msg.x, msg.y)
        break
      case 'release':
        handlersRef.current.onRelease()
        break
      case 'bye':
        dropGuest('left')
        break
      case 'video-retry': {
        const now = performance.now()
        if (now - lastRetry.current < RETRY_COOLDOWN_MS) return
        lastRetry.current = now
        callVideo(false)
        break
      }
      case 'ping': {
        lastPingRef.current = performance.now()
        const ctrl = ctrlRef.current
        ctrl?.send({ t: 'pong', ts: msg.ts } satisfies HostMessage)
        void readEncodedFrames(videoCallRef.current?.peerConnection)
          .then((frames) => {
            if (!ctrl?.open) return
            const live = streamRef.current?.getVideoTracks()[0]?.readyState === 'live'
            ctrl.send({ t: 'host-video', frames, live } satisfies HostMessage)
          })
          .catch(() => {})
        const videoState = VIDEO_STATES.find((s) => s === msg.vs) ?? 'ok'
        setPartner((prev) => ({
          rtt: typeof msg.rtt === 'number' ? msg.rtt : (prev?.rtt ?? 0),
          video: typeof msg.video === 'number' ? msg.video : null,
          audio: typeof msg.audio === 'number' ? msg.audio : null,
          mode: msg.mode === 'playfield' ? 'playfield' : 'video',
          videoState,
        }))
        if (typeof msg.rtt === 'number') setRtt(msg.rtt)
        break
      }
    }
  }, [applyAim, applyKey, callVideo, dropGuest])

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
    setPartner(null)
    setPartnerExit(null)
    setStatus('idle')
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setStatus('starting')
    let media: MediaStream
    try {
      media = await requestScreenShare()
    } catch (err) {
      console.error('[duosu] getDisplayMedia failed:', err)
      setStatus('idle')
      setError(describeShareError(err))
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
    const peer = new Peer(ROOM_PREFIX + code, { debug: 1, config: { iceServers: ICE_SERVERS } })
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
      if (kickedRef.current.has(conn.peer)) {
        conn.on('open', () => {
          conn.send({ t: 'kicked' } satisfies HostMessage)
          setTimeout(() => conn.close(), 500)
        })
        return
      }
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
          callVideo(true)
          const audio = current.getAudioTracks()
          callsRef.current = audio.length > 0 ? [peer.call(conn.peer, new MediaStream(audio))] : []
          lastPingRef.current = performance.now()
          setPartnerExit(null)
          setStatus('connected')
        })
        // A stale link closing late must not drop whoever joined after it.
        conn.on('close', () => {
          if (ctrlRef.current === conn) dropGuest('left')
        })
        conn.on('error', () => {
          if (ctrlRef.current === conn) dropGuest('lost')
        })
      }
    })
  }, [callVideo, dropGuest, handleInput, handleMessage, stop])

  useEffect(() => {
    guestRoleRef.current = guestRole
    ctrlRef.current?.send({ t: 'welcome', guestRole } satisfies HostMessage)
    handlersRef.current.onRelease()
  }, [guestRole])

  useEffect(() => stop, [stop])

  // A closed tab or dropped network often never fires a close event, so watch the partner's pings.
  useEffect(() => {
    if (status !== 'connected') return
    const id = setInterval(() => {
      if (ctrlRef.current && performance.now() - lastPingRef.current > PEER_TIMEOUT_MS) dropGuest('lost')
    }, 1000)
    return () => clearInterval(id)
  }, [status, dropGuest])

  const kick = useCallback(() => {
    const ctrl = ctrlRef.current
    const guest = guestIdRef.current
    if (!guest) return
    kickedRef.current.add(guest)
    // Detach first so the close that follows isn't reported as the partner leaving.
    ctrlRef.current = null
    if (ctrl?.open) ctrl.send({ t: 'kicked' } satisfies HostMessage)
    dropGuest('kicked')
    setTimeout(() => ctrl?.close(), 300)
  }, [dropGuest])

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
    const chunks = chunkText(map.text)
    chunks.forEach((d, i) => conn.send({ t: 'map', id: map.checksum, i, n: chunks.length, d } satisfies HostMessage))
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
    partnerExit,
    kick,
    start,
    stop,
    publishSync,
    publishMap,
    publishClock,
  }
}
