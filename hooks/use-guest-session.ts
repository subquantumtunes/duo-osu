'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataConnection, Peer } from 'peerjs'
import {
  type GuestMessage,
  type HostMessage,
  type Role,
  type TapSlot,
  ROOM_PREFIX,
  minimizePlayoutDelay,
} from '@/lib/protocol'

export type GuestStatus = 'idle' | 'connecting' | 'connected' | 'ended' | 'error'

export function useGuestSession(code: string) {
  const [status, setStatus] = useState<GuestStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [role, setRole] = useState<Role | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [rtt, setRtt] = useState<number | null>(null)

  const peerRef = useRef<Peer | null>(null)
  const ctrlRef = useRef<DataConnection | null>(null)
  const aimRef = useRef<DataConnection | null>(null)
  const aimSeq = useRef(0)
  const rttRef = useRef<number | undefined>(undefined)

  const leave = useCallback(() => {
    if (ctrlRef.current?.open) ctrlRef.current.send({ t: 'release' } satisfies GuestMessage)
    peerRef.current?.destroy()
    peerRef.current = null
    ctrlRef.current = null
    aimRef.current = null
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

    const openAimChannel = () => {
      if (aimRef.current) return
      const aim = peer.connect(hostId, { label: 'aim', reliable: false, serialization: 'json' })
      aimRef.current = aim
      aim.on('close', () => {
        if (aimRef.current === aim) aimRef.current = null
      })
    }

    peer.on('open', () => {
      const ctrl = peer.connect(hostId, { label: 'ctrl', reliable: true, serialization: 'json' })
      ctrlRef.current = ctrl
      ctrl.on('data', (raw) => {
        const msg = raw as HostMessage
        if (msg.t === 'welcome') {
          setRole(msg.guestRole)
          setStatus('connected')
          if (msg.guestRole === 'aim') openAimChannel()
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
          setStatus('ended')
          setStream(null)
        }
      })
    })

    peer.on('call', (call) => {
      call.answer()
      call.on('stream', (remote) => {
        minimizePlayoutDelay(call.peerConnection)
        setStream(remote)
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
    const aim = aimRef.current
    if (aim?.open) aim.send({ t: 'aim', x, y, s: ++aimSeq.current } satisfies GuestMessage)
  }, [])

  const sendKey = useCallback((k: TapSlot, down: boolean) => {
    const ctrl = ctrlRef.current
    if (ctrl?.open) ctrl.send({ t: 'key', k, down } satisfies GuestMessage)
  }, [])

  return { status, error, role, stream, rtt, join, leave, sendAim, sendKey }
}
