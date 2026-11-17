'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { SiteHeader } from '@/components/site-header'
import { StatusBadge, pingTone } from '@/components/status-badge'
import { useBridge } from '@/hooks/use-bridge'
import { useHostSession } from '@/hooks/use-host-session'
import type { Role, TapSlot } from '@/lib/protocol'
import { HostStage } from './host-stage'
import { RolePanel } from './role-panel'
import { BridgePanel } from './bridge-panel'
import { SessionPanel } from './session-panel'

const RELEASED = { k1: false, k2: false }

export function HostRoom() {
  const [guestRole, setGuestRole] = useState<Role>('tap')
  const [k1, setK1] = useState('z')
  const [k2, setK2] = useState('x')
  const [keys, setKeys] = useState(RELEASED)
  const aimRef = useRef<{ x: number; y: number } | null>(null)

  const bindings = useMemo(() => ({ k1, k2 }), [k1, k2])
  const bridge = useBridge(bindings)
  const { send } = bridge

  const onAim = useCallback(
    (x: number, y: number) => {
      aimRef.current = { x, y }
      send({ t: 'aim', x, y })
    },
    [send],
  )
  const onKey = useCallback(
    (k: TapSlot, down: boolean) => {
      setKeys((prev) => ({ ...prev, [k]: down }))
      send({ t: 'key', k, down })
    },
    [send],
  )
  const onRelease = useCallback(() => {
    setKeys(RELEASED)
    aimRef.current = null
    send({ t: 'release' })
  }, [send])

  const session = useHostSession(guestRole, { onAim, onKey, onRelease })

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <StatusBadge tone={bridge.status === 'connected' ? 'good' : 'idle'}>
            Bridge {bridge.status === 'connected' ? 'on' : 'off'}
          </StatusBadge>
          <StatusBadge tone={session.status === 'connected' ? pingTone(session.rtt) : 'idle'}>
            {session.status === 'connected'
              ? `Partner ${session.rtt !== null ? `${session.rtt} ms` : 'joined'}`
              : 'No partner'}
          </StatusBadge>
        </div>
      </SiteHeader>
      <main className="grid flex-1 gap-4 p-4 md:p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <HostStage
          stream={session.stream}
          aimRef={aimRef}
          showAim={guestRole === 'aim' && session.status === 'connected'}
          keys={keys}
          bindings={bindings}
          guestRole={guestRole}
        />
        <aside className="flex flex-col gap-4" aria-label="Session setup">
          <RolePanel guestRole={guestRole} onChange={setGuestRole} k1={k1} k2={k2} onK1={setK1} onK2={setK2} />
          <BridgePanel status={bridge.status} screen={bridge.screen} onConnect={bridge.connect} onDisconnect={bridge.disconnect} />
          <SessionPanel session={session} bridgeReady={bridge.status === 'connected'} />
        </aside>
      </main>
    </div>
  )
}
