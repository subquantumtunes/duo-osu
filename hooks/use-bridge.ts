'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type BridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'bad-token' | 'unreachable'

type BridgeOutgoing =
  | { t: 'aim'; x: number; y: number }
  | { t: 'key'; k: 'k1' | 'k2'; down: boolean }
  | { t: 'release' }
  | { t: 'config'; k1: string; k2: string }

export function useBridge(bindings: { k1: string; k2: string }) {
  const wsRef = useRef<WebSocket | null>(null)
  const readyRef = useRef(false)
  const bindingsRef = useRef(bindings)
  const [status, setStatus] = useState<BridgeStatus>('disconnected')
  const [screen, setScreen] = useState<[number, number] | null>(null)

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
        let msg: { t?: string; screen?: [number, number] }
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (msg.t === 'ok') {
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

  return { status, screen, connect, disconnect, send }
}
