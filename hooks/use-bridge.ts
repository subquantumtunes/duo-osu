'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type BridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'bad-token' | 'unreachable'

type BridgeOutgoing =
  | { t: 'aim'; x: number; y: number }
  | { t: 'key'; k: 'k1' | 'k2'; down: boolean }
  | { t: 'release' }
  | { t: 'config'; k1: string; k2: string }

export type OsuStatus = {
  source: 'tosu' | 'gosumemory' | null
  state: number | null
  mods: number
  offset: number | null
}

export type BridgeEvents = {
  onOsu: (status: OsuStatus) => void
  onTime: (ms: number) => void
  onMap: (checksum: string, text: string) => void
}

export function useBridge(bindings: { k1: string; k2: string }, events: BridgeEvents) {
  const wsRef = useRef<WebSocket | null>(null)
  const readyRef = useRef(false)
  const bindingsRef = useRef(bindings)
  const eventsRef = useRef(events)
  const [status, setStatus] = useState<BridgeStatus>('disconnected')
  const [screen, setScreen] = useState<[number, number] | null>(null)
  const [osu, setOsu] = useState<OsuStatus | null>(null)

  useEffect(() => {
    eventsRef.current = events
  })

  const send = useCallback((msg: BridgeOutgoing) => {
    const ws = wsRef.current
    if (readyRef.current && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  const disconnect = useCallback(() => {
    readyRef.current = false
    const ws = wsRef.current
    wsRef.current = null
    if (ws && ws.readyState <= WebSocket.OPEN) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'release' }))
      ws.close()
    }
    setStatus('disconnected')
  }, [])

  const connect = useCallback(
    (token: string, port: number) => {
      disconnect()
      setStatus('connecting')
      let ws: WebSocket
      try {
        ws = new WebSocket(`ws://127.0.0.1:${port}`)
      } catch {
        setStatus('unreachable')
        return
      }
      wsRef.current = ws
      let authed = false
      ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token }))
      ws.onmessage = (event) => {
        let msg: { t?: string; screen?: [number, number]; ms?: number; checksum?: string; text?: string } & Partial<OsuStatus>
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (msg.t === 'time') {
          if (typeof msg.ms === 'number') eventsRef.current.onTime(msg.ms)
        } else if (msg.t === 'osu') {
          const next: OsuStatus = {
            source: msg.source ?? null,
            state: msg.state ?? null,
            mods: msg.mods ?? 0,
            offset: typeof msg.offset === 'number' ? msg.offset : null,
          }
          setOsu(next)
          eventsRef.current.onOsu(next)
        } else if (msg.t === 'map') {
          if (msg.checksum && typeof msg.text === 'string') eventsRef.current.onMap(msg.checksum, msg.text)
        } else if (msg.t === 'ok') {
          authed = true
          readyRef.current = true
          setScreen(msg.screen ?? null)
          setStatus('connected')
          const { k1, k2 } = bindingsRef.current
          ws.send(JSON.stringify({ t: 'config', k1, k2 }))
        } else if (msg.t === 'error') {
          setStatus('bad-token')
        }
      }
      ws.onclose = () => {
        if (wsRef.current !== ws) return
        readyRef.current = false
        wsRef.current = null
        setOsu(null)
        eventsRef.current.onOsu({ source: null, state: null, mods: 0, offset: null })
        setStatus((prev) => (prev === 'bad-token' ? prev : authed ? 'disconnected' : 'unreachable'))
      }
    },
    [disconnect],
  )

  useEffect(() => {
    bindingsRef.current = bindings
    send({ t: 'config', k1: bindings.k1, k2: bindings.k2 })
  }, [bindings, send])

  useEffect(() => disconnect, [disconnect])

  return { status, screen, osu, connect, disconnect, send }
}
